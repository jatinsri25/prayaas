from __future__ import annotations

from datetime import date
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

import models
import schemas
from auth import get_current_user
from database import get_db
from agent.search import SearchRequest, SearchFilters, interpret_query, apply_filters
from agent.digest import get_digest, generate_digest, digest_out
from agent.pii import redact_pii
from dependencies import Role, require_role
from utils.audit import log_action

router = APIRouter(prefix="/api/insights", tags=["insights"])


@router.post("/search")
def search_reports(payload: SearchRequest, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    cached = False
    if payload.mode == "ai":
        filters, cached = interpret_query(payload.query, user.id)
    else:
        filters = payload.filters or SearchFilters()
    rows = apply_filters(db, user, filters, payload.group_id)
    return {"filters": filters.model_dump(mode="json"), "cache_hit": cached, "mode": payload.mode,
            "results": [schemas.ProblemOut.model_validate(row) for row in rows[:50]],
            "has_more": len(rows) > 50}


@router.get("/digest")
def latest_digest(user: models.User = Depends(require_role(Role.SOCIETY_ADMIN))):
    return get_digest()


@router.post("/digest")
def create_digest(user: models.User = Depends(require_role(Role.SOCIETY_ADMIN))):
    return generate_digest(user.id)


class DigestEdit(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    summary_en: str = Field(min_length=1, max_length=4000)
    summary_hi: str = Field(min_length=1, max_length=4000)
    revision: int = Field(ge=1)


@router.patch("/digest/{week_start}")
def edit_digest(week_start: date, payload: DigestEdit, db: Session = Depends(get_db),
                user: models.User = Depends(require_role(Role.SOCIETY_ADMIN))):
    row = db.get(models.WeeklyDigest, week_start.isoformat())
    if row is None:
        raise HTTPException(404, "Digest not found")
    clean = {name: redact_pii(schemas._sanitize(getattr(payload, name)))[0] for name in ("summary_en", "summary_hi")}
    if any(not value.strip() for value in clean.values()):
        raise HTTPException(422, "Both summaries must contain text")
    updated = db.query(models.WeeklyDigest).filter_by(week_start=week_start.isoformat(), revision=payload.revision).filter(
        models.WeeklyDigest.generation_mode != "preparing",
    ).update({**clean,
              "edited_by": user.id, "revision": payload.revision + 1}, synchronize_session=False)
    if not updated:
        db.rollback()
        raise HTTPException(409, "This draft is still preparing or was changed. Reload before saving.")
    db.commit()
    db.refresh(row)
    log_action(db, "EDIT_DIGEST", user_id=user.id, resource=f"digest:{week_start.isoformat()}", meta={"revision": row.revision})
    return digest_out(row)
