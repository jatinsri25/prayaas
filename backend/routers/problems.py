"""
Prayaas Problems Router — Production Hardened

Security:
  - File validation on audio uploads
  - AI pipeline with injection/PII guards (now confidence-gated)
  - Audit logging on all mutations
  - RBAC on status updates and deletion
  - Proper upvote tracking (no double-voting)

ML feedback loop:
  - Every admin PATCH that overrides an AI field is logged as an
    AICorrection row, feeding the next generation's few-shot context.

Semantic dedup:
  - POST /check-duplicate runs geofenced + cosine-similarity matching
    before the user finalizes their report.
"""

import asyncio
import os
import json
import time
from contextlib import suppress
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import StreamingResponse, JSONResponse
from sqlalchemy.orm import Session
from typing import List, Optional

from database import get_db, SessionLocal
from auth import get_current_user
import models
import schemas
from agent.pipeline import run_ai_pipeline, transcribe_audio
from agent.dedup import find_duplicates
from agent.embeddings import embed_text
from agent.structured import ai_status
from agent.pii import redact_pii
from utils.file_security import validate_audio_file
from utils.audit import log_action
from utils.logger import get_logger
from utils.problem_access import visible_problems, require_group_member
from pydantic import ValidationError

router = APIRouter(prefix="/api/problems", tags=["problems"])
log = get_logger()

UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)

# Fields whose admin edits become ML feedback loop training signal.
_TRACKED_AI_FIELDS = {
    "title",
    "category",
    "severity",
    "location",
    "formatted_description",
    "description_en",
    "description_hi",
    "affected_residents",
}


@router.get("/ai-status")
def report_ai_status(current_user: models.User = Depends(get_current_user)):
    return JSONResponse(ai_status(current_user.id), headers={"Cache-Control": "no-store"})


@router.post("/process", response_model=schemas.AIProblemDraft)
async def process_with_ai(
    raw_text: Optional[str] = Form(None),
    audio: Optional[UploadFile] = File(None),
    current_user: models.User = Depends(get_current_user),
):
    """JSON endpoint retained for existing clients."""
    audio_bytes, filename = await _read_report_input(raw_text, audio)
    try:
        return await asyncio.wait_for(
            _process_report(raw_text, audio_bytes, filename, current_user.id, lambda stage: None),
            timeout=85,
        )
    except Exception as exc:
        raise _pipeline_error(exc) from exc


async def _read_report_input(raw_text, audio):
    if not (raw_text or "").strip() and not audio:
        raise HTTPException(status_code=400, detail="Provide either text or an audio recording.")
    if raw_text and len(raw_text) > 5000:
        raise HTTPException(status_code=400, detail="Please keep your report within 5,000 characters.")
    if not audio:
        return None, "audio.webm"
    audio_bytes = await audio.read()
    filename = audio.filename or "audio.webm"
    validate_audio_file(audio_bytes, filename)
    return audio_bytes, filename


def _pipeline_error(exc):
    if isinstance(exc, HTTPException):
        return exc
    log.error("ai_pipeline_error", error_type=type(exc).__name__)
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
        return HTTPException(status_code=504, detail="AI took too long. Your input is safe; please try again.")
    return HTTPException(status_code=503, detail="AI is temporarily unavailable. Your input is safe; please try again.")


def _finish_report(result, user_id, has_audio):
    # A separate session keeps request-scoped sessions out of worker threads.
    with SessionLocal() as db:
        viewer = db.get(models.User, user_id)
        matches = find_duplicates(db, raw_text=result["raw_input"], viewer=viewer) if viewer else []
        log_action(db, "AI_CALL", user_id=user_id, resource="ai_pipeline", meta={
            "has_audio": has_audio, "confidence": result.get("confidence_score"),
            "auto_resolved": result.get("auto_resolved"), "model": result.get("last_model_used"),
            "escalated": result.get("was_escalated"),
        })
    return schemas.AIProblemDraft(**result, duplicate_warning=schemas.DuplicateWarning(
        is_likely_duplicate=bool(matches), matches=matches,
    ))


async def _process_report(raw_text, audio_bytes, filename, user_id, emit):
    if audio_bytes:
        emit("transcribing")
        transcription = await asyncio.to_thread(transcribe_audio, audio_bytes, filename, user_id)
        if not transcription:
            raise HTTPException(status_code=400, detail="No speech detected. Please record again or type your report.")
        raw_text = "\n".join(part for part in [raw_text, transcription] if part)
    result = await run_ai_pipeline(raw_text or "", user_id=user_id, on_progress=emit)
    emit("checking")
    return await asyncio.to_thread(_finish_report, result, user_id, bool(audio_bytes))


@router.post("/process/stream")
async def stream_report(
    raw_text: Optional[str] = Form(None),
    audio: Optional[UploadFile] = File(None),
    current_user: models.User = Depends(get_current_user),
):
    """Newline-delimited events report actual stages, never simulated percentages."""
    audio_bytes, filename = await _read_report_input(raw_text, audio)
    user_id = current_user.id

    async def events():
        queue = asyncio.Queue()

        def emit(stage):
            queue.put_nowait({"type": "progress", "stage": stage})

        async def produce():
            try:
                draft = await asyncio.wait_for(
                    _process_report(raw_text, audio_bytes, filename, user_id, emit), timeout=85,
                )
                queue.put_nowait({"type": "complete", "draft": draft.model_dump(mode="json")})
            except Exception as exc:
                error = _pipeline_error(exc)
                queue.put_nowait({"type": "error", "status": error.status_code, "detail": error.detail})

        task = asyncio.create_task(produce())
        try:
            yield json.dumps({"type": "progress", "stage": "received"}) + "\n"
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=10)
                except asyncio.TimeoutError:
                    event = {"type": "heartbeat"}
                yield json.dumps(event) + "\n"
                if event["type"] in ("complete", "error"):
                    break
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    return StreamingResponse(events(), media_type="application/x-ndjson", headers={
        "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no",
    })


@router.post("/check-duplicate", response_model=schemas.DuplicateWarning)
def check_duplicate(
    payload: schemas.DuplicateCheckRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    Standalone semantic dedup endpoint.

    Combines geofencing (haversine distance, swap for PostGIS ST_DWithin
    in production) with cosine similarity over text-embedding-004 vectors.
    The frontend calls this when the user fills in the location field so we
    can warn before the AI pipeline burns tokens on a duplicate report.
    """
    matches = find_duplicates(
        db,
        raw_text=redact_pii(payload.raw_text)[0],
        viewer=current_user,
        latitude=payload.latitude,
        longitude=payload.longitude,
        radius_meters=payload.radius_meters,
        similarity_threshold=payload.similarity_threshold,
    )
    return schemas.DuplicateWarning(
        is_likely_duplicate=bool(matches),
        matches=[schemas.DuplicateMatch(**m) for m in matches],
    )


@router.post("", response_model=schemas.ProblemOut)
async def post_problem(
    background_tasks: BackgroundTasks,
    title: str = Form(...),
    formatted_description: str = Form(...),
    description_en: Optional[str] = Form(None),
    description_hi: Optional[str] = Form(None),
    input_language: str = Form("en"),
    drafting_mode: str = Form("ai"),
    category: str = Form("Other"),
    severity: str = Form("Medium"),
    location: Optional[str] = Form(None),
    affected_residents: Optional[str] = Form(None),
    ai_solutions: Optional[str] = Form(None),
    raw_input: Optional[str] = Form(None),
    group_id: Optional[int] = Form(None),
    latitude: Optional[float] = Form(None),
    longitude: Optional[float] = Form(None),
    confidence_score: Optional[float] = Form(None),
    was_escalated: Optional[bool] = Form(None),
    last_model_used: Optional[str] = Form(None),
    audio: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Post a finalized problem to the community feed."""
    require_group_member(db, current_user, group_id)
    if category not in {item.value for item in models.CategoryEnum} or severity not in {item.value for item in models.SeverityEnum}:
        raise HTTPException(422, "Choose a valid category and severity")
    if input_language not in ("en", "hi") or drafting_mode not in ("ai", "manual"):
        raise HTTPException(422, "Invalid language or drafting mode")
    fields = {"title": (title, 200), "formatted_description": (formatted_description, 5000),
              "description_en": (description_en, 5000), "description_hi": (description_hi, 5000),
              "raw_input": (raw_input, 5000), "location": (location, 200), "affected_residents": (affected_residents, 300)}
    clean = {}
    for name, (value, limit) in fields.items():
        if value is not None and len(value) > limit:
            raise HTTPException(422, f"{name} is too long (maximum {limit})")
        clean[name] = redact_pii(schemas._sanitize((value or "").strip()))[0] or None
    clean["formatted_description"] = clean["description_en"] or clean["description_hi"] or clean["formatted_description"]
    if not clean["title"] or not clean["formatted_description"]:
        raise HTTPException(422, "A title and description are required")
    if ai_solutions:
        try:
            solutions = json.loads(ai_solutions)
            if not isinstance(solutions, list) or len(solutions) > 3:
                raise ValueError()
            ai_solutions = json.dumps([schemas.SolutionItem.model_validate(item).model_dump() for item in solutions])
            ai_solutions = redact_pii(ai_solutions)[0]
        except (ValueError, TypeError, ValidationError):
            raise HTTPException(422, "Invalid suggested solutions")
    if drafting_mode == "manual":
        ai_solutions, confidence_score, last_model_used, was_escalated = None, None, None, False
    audio_path = None
    if audio:
        audio_bytes = await audio.read()
        validate_audio_file(audio_bytes, audio.filename or "audio.webm")

        ext = audio.filename.split(".")[-1] if audio.filename and "." in audio.filename else "webm"
        filename = f"{current_user.id}_{int(time.time())}.{ext}"
        audio_path = os.path.join(UPLOAD_DIR, filename)
        with open(audio_path, "wb") as f:
            f.write(audio_bytes)

    problem = models.Problem(
        **clean,
        input_language=input_language,
        drafting_mode=drafting_mode,
        category=category,
        severity=severity,
        ai_solutions=ai_solutions,
        audio_file=audio_path,
        author_id=current_user.id,
        group_id=group_id,
        latitude=latitude,
        longitude=longitude,
        confidence_score=confidence_score,
        was_escalated=bool(was_escalated) if was_escalated is not None else False,
        last_model_used=last_model_used,
    )
    db.add(problem)
    db.commit()
    db.refresh(problem)
    # Posting does not wait on an optional AI indexing request.
    if drafting_mode != "manual":
        background_tasks.add_task(_index_problem, problem.id, clean["raw_input"] or clean["formatted_description"])

    # Audit log
    log_action(db, "POST_PROBLEM", user_id=current_user.id,
               resource=f"problem:{problem.id}",
               meta={"group_id": group_id, "confidence": confidence_score, "model": last_model_used})

    log.info("problem_posted", user_id=current_user.id, problem_id=problem.id)
    return problem


def _index_problem(problem_id: int, text: str):
    try:
        clean_text, _ = redact_pii(text)
        embedding = json.dumps(embed_text(clean_text))
        with SessionLocal() as db:
            db.query(models.Problem).filter(models.Problem.id == problem_id).update({"embedding_json": embedding})
            db.commit()
    except Exception as exc:
        log.warning("problem_index_failed", problem_id=problem_id, error_type=type(exc).__name__)


# ── ML Feedback Loop: admin correction PATCH ─────────────────────────────────

@router.patch("/{problem_id}/ai-fields", response_model=schemas.ProblemOut)
def correct_ai_fields(
    problem_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    Admin/author edits to AI-generated fields. Each changed field becomes
    an `AICorrection` row — this is the training signal for the weekly
    model trust score AND the few-shot context that makes the next AI
    draft smarter.

    Accepts a partial dict like:
      {"title": "...", "category": "...", "severity": "..."}
    """
    problem = visible_problems(db, current_user).filter(models.Problem.id == problem_id).first()
    if not problem:
        raise HTTPException(status_code=404, detail="Problem not found")

    is_author = problem.author_id == current_user.id
    is_admin = current_user.role in ("group_admin", "society_admin", "superadmin")
    if not is_author and not is_admin:
        raise HTTPException(status_code=403, detail="Not authorized to correct AI fields")

    # Reuse the existing index; correcting a report must not consume AI quota.
    correction_embedding = problem.embedding_json

    normalized = {}
    for field_name, value in payload.items():
        if field_name not in _TRACKED_AI_FIELDS:
            raise HTTPException(422, "Unsupported report field")
        if not isinstance(value, str) or not value.strip() or len(value) > (5000 if field_name.startswith("description") or field_name == "formatted_description" else 200):
            raise HTTPException(422, "Provide a non-empty value within the field limit")
        normalized[field_name] = redact_pii(schemas._sanitize(value.strip()))[0]
        if not normalized[field_name].strip():
            raise HTTPException(422, "The report field cannot be empty")
    if "category" in normalized and normalized["category"] not in {item.value for item in models.CategoryEnum}:
        raise HTTPException(422, "Invalid category")
    if "severity" in normalized and normalized["severity"] not in {item.value for item in models.SeverityEnum}:
        raise HTTPException(422, "Invalid severity")
    if "formatted_description" in normalized:
        normalized["description_en" if problem.input_language != "hi" or problem.description_en else "description_hi"] = normalized["formatted_description"]
    if "description_en" in normalized:
        normalized["formatted_description"] = normalized["description_en"]
        if "description_hi" not in normalized:
            problem.description_hi = None
    elif "description_hi" in normalized:
        problem.description_en = None
        normalized["formatted_description"] = normalized["description_hi"]

    corrections_logged = 0
    for field_name, new_value in normalized.items():
        if field_name not in _TRACKED_AI_FIELDS:
            continue
        old_value = getattr(problem, field_name, None)
        if old_value == new_value:
            continue  # no-op

        correction = models.AICorrection(
            problem_id=problem.id,
            admin_id=current_user.id,
            field_name=field_name,
            original_value=str(old_value) if old_value is not None else None,
            corrected_value=str(new_value) if new_value is not None else None,
            model_used=problem.last_model_used,
            original_confidence=problem.confidence_score,
            embedding_json=correction_embedding,
        )
        db.add(correction)
        setattr(problem, field_name, new_value)
        corrections_logged += 1

    if corrections_logged:
        db.commit()
        db.refresh(problem)
        log_action(
            db,
            "AI_CORRECTION",
            user_id=current_user.id,
            resource=f"problem:{problem.id}",
            meta={"fields_changed": corrections_logged},
        )
        log.info(
            "ai_correction_logged",
            user_id=current_user.id,
            problem_id=problem.id,
            count=corrections_logged,
        )

    return problem


@router.get("", response_model=List[schemas.ProblemOut])
def list_problems(
    group_id: Optional[int] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """List all problems, optionally filtered by group."""
    q = visible_problems(db, current_user)
    if group_id:
        q = q.filter(models.Problem.group_id == group_id)
    return q.order_by(models.Problem.created_at.desc()).all()


@router.get("/{problem_id}", response_model=schemas.ProblemOut)
def get_problem(problem_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    problem = visible_problems(db, current_user).filter(models.Problem.id == problem_id).first()
    if not problem:
        raise HTTPException(status_code=404, detail="Problem not found")
    return problem


@router.post("/{problem_id}/upvote", response_model=dict)
def upvote_problem(
    problem_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Upvote a problem (max one per user — prevents double-voting)."""
    problem = db.query(models.Problem).filter(models.Problem.id == problem_id).first()
    if not problem:
        raise HTTPException(status_code=404, detail="Problem not found")

    # Check for existing upvote
    existing = db.query(models.Upvote).filter(
        models.Upvote.user_id == current_user.id,
        models.Upvote.problem_id == problem_id,
    ).first()

    if existing:
        raise HTTPException(status_code=400, detail="Already upvoted this problem")

    # Record upvote
    upvote = models.Upvote(user_id=current_user.id, problem_id=problem_id)
    db.add(upvote)
    problem.upvotes += 1
    db.commit()

    # Audit log
    log_action(db, "UPVOTE", user_id=current_user.id, resource=f"problem:{problem_id}")

    return {"upvotes": problem.upvotes}


@router.patch("/{problem_id}/status", response_model=schemas.ProblemOut)
def update_status(
    problem_id: int,
    status: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Update problem status. Only author or group_admin+ can change status."""
    problem = db.query(models.Problem).filter(models.Problem.id == problem_id).first()
    if not problem:
        raise HTTPException(status_code=404, detail="Problem not found")

    # Authorization: author or admin+
    is_author = problem.author_id == current_user.id
    is_admin = current_user.role in ("group_admin", "society_admin", "superadmin")

    if not is_author and not is_admin:
        raise HTTPException(status_code=403, detail="Not authorized to change status")

    # Validate status value
    valid_statuses = {"Open", "In Progress", "Resolved"}
    if status not in valid_statuses:
        raise HTTPException(status_code=400, detail=f"Invalid status. Must be one of: {valid_statuses}")

    old_status = problem.status
    problem.status = status
    db.commit()
    db.refresh(problem)

    # Audit log
    log_action(db, "STATUS_CHANGE", user_id=current_user.id,
               resource=f"problem:{problem_id}",
               meta={"old_status": old_status, "new_status": status})

    return problem


@router.delete("/{problem_id}", response_model=dict)
def delete_problem(
    problem_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Delete a problem. Only author or society_admin+ can delete."""
    problem = db.query(models.Problem).filter(models.Problem.id == problem_id).first()
    if not problem:
        raise HTTPException(status_code=404, detail="Problem not found")

    is_author = problem.author_id == current_user.id
    is_admin = current_user.role in ("society_admin", "superadmin")

    if not is_author and not is_admin:
        raise HTTPException(status_code=403, detail="Not authorized to delete this problem")

    # Delete associated upvotes
    db.query(models.Upvote).filter(models.Upvote.problem_id == problem_id).delete()

    # Delete the problem
    db.delete(problem)
    db.commit()

    # Audit log
    log_action(db, "DELETE_PROBLEM", user_id=current_user.id,
               resource=f"problem:{problem_id}")

    return {"message": "Problem deleted successfully"}
