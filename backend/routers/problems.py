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

import os
import json
import time
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from sqlalchemy.orm import Session
from typing import List, Optional

from database import get_db
from auth import get_current_user
import models
import schemas
from agent.pipeline import run_ai_pipeline, transcribe_audio
from agent.dedup import find_duplicates
from agent.embeddings import embed_text
from utils.file_security import validate_audio_file
from utils.audit import log_action
from utils.logger import get_logger

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
    "affected_residents",
}


@router.post("/process", response_model=schemas.AIProblemDraft)
async def process_with_ai(
    raw_text: Optional[str] = Form(None),
    audio: Optional[UploadFile] = File(None),
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Run the secure AI pipeline on raw text or audio.
    Returns a structured draft with solutions before final posting.
    """
    if not raw_text and not audio:
        raise HTTPException(status_code=400, detail="Provide either raw_text or an audio file")

    # Handle audio input
    if audio:
        audio_bytes = await audio.read()

        # Validate audio file (size + magic bytes)
        validate_audio_file(audio_bytes, audio.filename or "audio.webm")

        raw_text = transcribe_audio(audio_bytes, audio.filename or "audio.webm")

    if not raw_text or not raw_text.strip():
        raise HTTPException(status_code=400, detail="Could not extract text from input")

    # Run secure pipeline (injection guard + PII redaction + token budget)
    try:
        result = await run_ai_pipeline(raw_text, user_id=current_user.id)
    except HTTPException:
        raise
    except Exception as e:
        error_msg = str(e)
        log.error("ai_pipeline_error", user_id=current_user.id, error=error_msg)
        if "429" in error_msg or "RESOURCE_EXHAUSTED" in error_msg:
            raise HTTPException(
                status_code=429,
                detail="AI quota temporarily exhausted. Please wait a minute and try again."
            )
        elif "503" in error_msg or "UNAVAILABLE" in error_msg:
            raise HTTPException(
                status_code=503,
                detail="AI service is temporarily overloaded. Please try again in a few seconds."
            )
        else:
            raise HTTPException(
                status_code=500,
                detail="AI processing failed unexpectedly. Please try again."
            )

    # Audit log (now includes confidence-gated pipeline telemetry)
    log_action(
        db,
        "AI_CALL",
        user_id=current_user.id,
        resource="ai_pipeline",
        meta={
            "text_length": len(raw_text),
            "has_audio": audio is not None,
            "confidence": result.get("confidence_score"),
            "auto_resolved": result.get("auto_resolved"),
            "model": result.get("last_model_used"),
            "escalated": result.get("was_escalated"),
        },
    )

    # Run an opportunistic duplicate check so the draft UI can warn the
    # user *before* they finalize. Geo coords come later (final POST step).
    dup_matches = find_duplicates(db, raw_text=raw_text)
    duplicate_warning = None
    if dup_matches:
        duplicate_warning = schemas.DuplicateWarning(
            is_likely_duplicate=True,
            matches=[schemas.DuplicateMatch(**m) for m in dup_matches],
        )

    return schemas.AIProblemDraft(
        title=result.get("title", "Community Issue"),
        category=result.get("category", "Other"),
        location=result.get("location", "Society premises"),
        severity=result.get("severity", "Medium"),
        formatted_description=result.get("formatted_description", raw_text),
        affected_residents=result.get("affected_residents", "Society residents"),
        solutions=[schemas.SolutionItem(**s) for s in result.get("solutions", [])],
        confidence_score=result.get("confidence_score"),
        was_escalated=result.get("was_escalated"),
        last_model_used=result.get("last_model_used"),
        auto_resolved=result.get("auto_resolved"),
        duplicate_warning=duplicate_warning,
    )


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
        raw_text=payload.raw_text,
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
    title: str = Form(...),
    formatted_description: str = Form(...),
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
    audio_path = None
    if audio:
        audio_bytes = await audio.read()
        validate_audio_file(audio_bytes, audio.filename or "audio.webm")

        ext = audio.filename.split(".")[-1] if audio.filename and "." in audio.filename else "webm"
        filename = f"{current_user.id}_{int(time.time())}.{ext}"
        audio_path = os.path.join(UPLOAD_DIR, filename)
        with open(audio_path, "wb") as f:
            f.write(audio_bytes)

    # Compute embedding once for this problem so future dedup queries are O(1).
    embedding_payload = None
    if raw_input:
        embedding_payload = json.dumps(embed_text(raw_input))
    elif formatted_description:
        embedding_payload = json.dumps(embed_text(formatted_description))

    problem = models.Problem(
        title=title,
        raw_input=raw_input,
        formatted_description=formatted_description,
        category=category,
        severity=severity,
        location=location,
        affected_residents=affected_residents,
        ai_solutions=ai_solutions,
        audio_file=audio_path,
        author_id=current_user.id,
        group_id=group_id,
        latitude=latitude,
        longitude=longitude,
        embedding_json=embedding_payload,
        confidence_score=confidence_score,
        was_escalated=bool(was_escalated) if was_escalated is not None else False,
        last_model_used=last_model_used,
    )
    db.add(problem)
    db.commit()
    db.refresh(problem)

    # Audit log
    log_action(db, "POST_PROBLEM", user_id=current_user.id,
               resource=f"problem:{problem.id}",
               meta={"group_id": group_id, "confidence": confidence_score, "model": last_model_used})

    log.info("problem_posted", user_id=current_user.id, problem_id=problem.id)
    return problem


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
    problem = db.query(models.Problem).filter(models.Problem.id == problem_id).first()
    if not problem:
        raise HTTPException(status_code=404, detail="Problem not found")

    is_author = problem.author_id == current_user.id
    is_admin = current_user.role in ("group_admin", "society_admin", "superadmin")
    if not is_author and not is_admin:
        raise HTTPException(status_code=403, detail="Not authorized to correct AI fields")

    # Compute embedding of the *original raw input* once — this lets future
    # nearest-neighbor lookups find similar past problems quickly.
    correction_embedding = None
    if problem.raw_input:
        correction_embedding = json.dumps(embed_text(problem.raw_input))
    elif problem.embedding_json:
        correction_embedding = problem.embedding_json

    corrections_logged = 0
    for field_name, new_value in payload.items():
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
):
    """List all problems, optionally filtered by group."""
    q = db.query(models.Problem)
    if group_id:
        q = q.filter(models.Problem.group_id == group_id)
    return q.order_by(models.Problem.created_at.desc()).all()


@router.get("/{problem_id}", response_model=schemas.ProblemOut)
def get_problem(problem_id: int, db: Session = Depends(get_db)):
    problem = db.query(models.Problem).filter(models.Problem.id == problem_id).first()
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
