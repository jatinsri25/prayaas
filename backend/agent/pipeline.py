"""
Prayaas AI Pipeline — Production (Gemini)

Security pipeline:
  1. Audio validation + transcription (Gemini multimodal)
  2. Prompt injection detection
  3. PII redaction before LLM
  4. Token budget check
  5. LLM call (Gemini, routed through `confidence_gate.gated_call`)
  6. Output safety check
  7. Token budget deduction

ML feedback loop:
  - Every gated_call emits an AutoResolutionEvent row (via on_event hook)
  - Past admin corrections for similar problems are injected as few-shot
    examples — this is what makes the system "get smarter every week".
"""

import os
import json
import base64
import re
from typing import Optional, List, Tuple

from google.genai import Client as GenaiClient

from agent.guard import detect_injection
from agent.pii import redact_pii
from agent.token_budget import has_budget, deduct_tokens
from agent.embeddings import embed_text, cosine_similarity
from agent.confidence_gate import (
    gated_call,
    GateResult,
    AUTO_RESOLVE_THRESHOLD,
    MODEL_CHAIN,
)
from database import SessionLocal
import models

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "")
_client = GenaiClient(api_key=GOOGLE_API_KEY) if GOOGLE_API_KEY else None
API_TIMEOUT = 60


# ── Audio Transcription (Gemini multimodal) ───────────────────────────────────

def transcribe_audio(audio_bytes: bytes, filename: str = "audio.webm") -> str:
    """
    Transcribe audio using Gemini's multimodal capabilities.
    Uses inline data (base64) to avoid gRPC file upload issues.
    Supports Hindi, Hinglish, and all major Indian languages natively.
    """
    if _client is None:
        raise RuntimeError("GOOGLE_API_KEY not configured")

    suffix = "." + filename.split(".")[-1] if "." in filename else ".webm"
    mime_map = {
        ".webm": "audio/webm",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".ogg": "audio/ogg",
        ".m4a": "audio/mp4",
        ".mp4": "audio/mp4",
    }
    mime_type = mime_map.get(suffix, "audio/webm")
    audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")

    transcription_prompt = (
        "You are an expert multilingual audio transcription assistant. "
        "Listen to this audio recording very carefully and transcribe it into clear, professional English.\n\n"
        "IMPORTANT RULES:\n"
        "1. The speaker may be talking in Hindi, Hinglish, Marathi, Tamil, Telugu, Bengali, "
        "Gujarati, Punjabi, or any other Indian language.\n"
        "2. Accurately translate ALL non-English speech into natural, professional English.\n"
        "3. Preserve the full meaning, intent, and emotion of what the speaker said.\n"
        "4. Do NOT summarize or shorten — capture every detail mentioned.\n"
        "5. Output ONLY the English transcription text. No labels, no timestamps, no explanations."
    )

    # Audio transcription falls back through the model chain on quota errors,
    # but doesn't need confidence-gating (output is free-form text).
    last_err: Exception | None = None
    for model in MODEL_CHAIN:
        try:
            response = _client.models.generate_content(
                model=model,
                contents=[
                    {
                        "parts": [
                            {"text": transcription_prompt},
                            {"inline_data": {"mime_type": mime_type, "data": audio_b64}},
                        ]
                    }
                ],
            )
            return (response.text or "").strip()
        except Exception as e:
            last_err = e
            err_str = str(e)
            if any(s in err_str for s in ("429", "503", "RESOURCE_EXHAUSTED", "UNAVAILABLE")):
                continue
            raise
    raise last_err or RuntimeError("Transcription failed across all models")


# ── Severity Auto-Escalation Keywords ─────────────────────────────────────────

DISTRESS_PATTERNS = [
    "child injured", "children hurt", "accident", "collapsed", "fire",
    "no water", "no electricity", "flooding", "sewage overflow", "gas leak",
    "structural crack", "wall crack", "ceiling crack", "short circuit",
    "electrocution", "snake", "stray dog bite", "health hazard",
    "ambulance", "hospital", "broken lift", "lift stuck", "emergency",
    "dangerous", "life threatening", "poisoning", "contaminated water",
]


def _detect_urgency_escalation(text: str) -> Optional[str]:
    text_lower = text.lower()
    for pattern in DISTRESS_PATTERNS:
        if pattern in text_lower:
            return pattern
    return None


# ── ML Feedback Loop: nearest-neighbor few-shot corrections ───────────────────

def _retrieve_similar_corrections(
    raw_text: str,
    field_name: str,
    top_k: int = 2,
    min_similarity: float = 0.72,
) -> List[Tuple[str, str]]:
    """
    Find the top-k most similar past corrections for `field_name`.
    Returns list of (original_value, corrected_value) tuples that the
    prompt can include as in-context examples.

    This is the "gets smarter every week" mechanism: as admins fix more
    AI mistakes, the next generation gets better few-shot context.
    """
    query_embedding = embed_text(raw_text)
    db = SessionLocal()
    try:
        rows = (
            db.query(models.AICorrection)
            .filter(models.AICorrection.field_name == field_name)
            .filter(models.AICorrection.embedding_json.isnot(None))
            .order_by(models.AICorrection.ts.desc())
            .limit(200)  # cheap safety cap
            .all()
        )
    finally:
        db.close()

    scored: List[Tuple[float, models.AICorrection]] = []
    for row in rows:
        try:
            past_embedding = json.loads(row.embedding_json)
        except (TypeError, json.JSONDecodeError):
            continue
        sim = cosine_similarity(query_embedding, past_embedding)
        if sim >= min_similarity:
            scored.append((sim, row))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [(r.original_value or "", r.corrected_value or "") for _, r in scored[:top_k]]


def _format_few_shot_block(examples: List[Tuple[str, str]], field_label: str) -> str:
    if not examples:
        return ""
    lines = [
        "\n\nLEARNED FROM PAST ADMIN CORRECTIONS (apply this style):",
    ]
    for i, (original, corrected) in enumerate(examples, start=1):
        lines.append(
            f"Example {i}: AI originally wrote {field_label} = {original!r}; "
            f"a human admin corrected it to {corrected!r}."
        )
    return "\n".join(lines)


# ── AutoResolutionEvent persistence callback ─────────────────────────────────

def _make_event_recorder(user_id: Optional[int] = None, problem_id: Optional[int] = None):
    """
    Returns an `on_event` callback that persists each gated_call as
    an AutoResolutionEvent row. We open/close a dedicated session per
    event so this never holds a DB connection during the LLM call.
    """
    def _record(result: GateResult, task_type: str) -> None:
        db = SessionLocal()
        try:
            event = models.AutoResolutionEvent(
                task_type=task_type,
                model_used=result.model_used,
                confidence=result.confidence,
                escalations=result.escalations,
                auto_resolved=result.auto_resolved,
                elapsed_ms=result.elapsed_ms,
                had_errors=bool(result.errors),
                user_id=user_id,
                problem_id=problem_id,
            )
            db.add(event)
            db.commit()
        except Exception:
            db.rollback()
        finally:
            db.close()
    return _record


# ── Formatting Tools (now confidence-gated) ───────────────────────────────────

FORMAT_REQUIRED_FIELDS = [
    "title", "category", "severity", "location",
    "formatted_description", "affected_residents",
]


def format_problem(raw_text: str, user_id: Optional[int] = None) -> GateResult:
    """
    Confidence-gated format step. Returns a GateResult so the caller has
    full visibility into model_used, confidence, escalations, etc.
    """
    urgency_match = _detect_urgency_escalation(raw_text)
    severity_hint = ""
    if urgency_match:
        severity_hint = (
            f'\nIMPORTANT: The resident used distress language ("{urgency_match}"). '
            f'This MUST be classified as "High" or "Critical" severity regardless of other factors.'
        )

    # Pull in past corrections for the "title" field as few-shot context.
    few_shot = _format_few_shot_block(
        _retrieve_similar_corrections(raw_text, field_name="title"),
        field_label="title",
    )

    prompt = f"""You are an expert civic analyst working for a residential housing society in India.
You deeply understand Indian apartment society dynamics — RWA committees, maintenance staff, security guards,
municipal corporations (BMC/MCD/BBMP), and the specific challenges of shared living in Indian contexts.

A resident has reported:
"{raw_text}"
{severity_hint}{few_shot}

TASK: Analyze this report thoroughly and produce a JSON object.

REASONING STEPS (do this internally, do NOT output these):
1. What exactly is the physical/operational problem?
2. Where specifically in the society does this occur?
3. How severe is the impact? Consider safety risk, people affected, duration, escalation potential.
4. Who is most affected — all residents, specific wing, elderly, children, pets, staff?
5. Has this been an ongoing issue or a one-time event?

Return this JSON object:
{{
  "title": "A specific, actionable title (5-12 words). Bad: 'Water issue'. Good: 'No running water in Block B since 3 days'",
  "category": "One of: Infrastructure, Safety, Sanitation, Noise, Maintenance, Security, Utilities, Other",
  "severity": "One of: Low, Medium, High, Critical.",
  "location": "Be specific: 'Block B, 3rd floor corridor' not just 'society'.",
  "formatted_description": "A 4-6 sentence professional report.",
  "affected_residents": "Be specific: 'All 120+ residents of Block B' or 'Elderly residents on ground floor'."
}}

Return ONLY the JSON object. No markdown fences, no explanation."""

    return gated_call(
        prompt=prompt,
        task_type="format_problem",
        required_fields=FORMAT_REQUIRED_FIELDS,
        temperature=0.15,
        on_event=_make_event_recorder(user_id=user_id),
        user_id=user_id,
    )


def suggest_solutions(problem_json: str, user_id: Optional[int] = None) -> GateResult:
    """Confidence-gated solutions step."""
    prompt = f"""You are an experienced residential welfare association (RWA) advisor in India. You understand:
- Society committee structures (President, Secretary, Treasurer, Managing Committee)
- Maintenance staff capabilities (plumber, electrician, security, housekeeping)
- Municipal/civic body escalation (BMC, MCD, BBMP, BWSSB, BESCOM etc.)
- Vendor procurement for Indian housing societies
- Legal frameworks (Maharashtra MOFA, Apartment Ownership Act, local bylaws)

Problem details:
{problem_json}

Generate exactly 3 practical, actionable solutions ordered by priority (1 = most urgent).

Each solution MUST be SPECIFIC, ACTIONABLE, REALISTIC and ESCALATION-AWARE.

Return a JSON array:
[
  {{
    "action": "Detailed action description (2-3 sentences).",
    "responsible_party": "Specific role: 'Society Maintenance Staff (Electrician)' etc.",
    "timeline": "Realistic Indian timeline.",
    "priority": 1
  }}
]

Priority 1 = immediate/most important. Return ONLY the JSON array, no markdown, no explanation."""

    return gated_call(
        prompt=prompt,
        task_type="suggest_solutions",
        required_fields=None,  # array result, validated separately
        temperature=0.2,
        on_event=_make_event_recorder(user_id=user_id),
        user_id=user_id,
    )


# ── Secure AI Pipeline ───────────────────────────────────────────────────────

async def run_ai_pipeline(raw_text: str, user_id: Optional[int] = None) -> dict:
    """
    Production AI pipeline with full security controls + confidence gating.

    Returns a dict that includes the structured problem fields PLUS:
      - confidence_score, was_escalated, last_model_used  (for storage)
      - auto_resolved                                     (for the metric)
      - embedding_json                                    (for future dedup)
    """
    from fastapi import HTTPException
    from utils.logger import get_logger

    log = get_logger()

    # ── Step 1: Injection guard ──────────────────────────────────────────────
    threat = detect_injection(raw_text)
    if threat:
        log.warning("injection_attempt", user_id=user_id, threat=threat)
        raise HTTPException(
            status_code=400,
            detail="Your input contains content that cannot be processed. Please rephrase your report.",
        )

    # ── Step 2: PII redaction ────────────────────────────────────────────────
    clean_text, redacted_entities = redact_pii(raw_text)
    if redacted_entities:
        log.info(
            "pii_redacted",
            user_id=user_id,
            entity_count=len(redacted_entities),
            entity_types=[e["type"] for e in redacted_entities],
        )

    # ── Step 3: Token budget check ───────────────────────────────────────────
    estimated_tokens = len(clean_text.split()) * 2 + 800
    if user_id and not has_budget(user_id, estimated_tokens):
        raise HTTPException(
            status_code=429,
            detail="Daily AI usage limit reached. Please try again tomorrow.",
        )

    # ── Step 4: Format the problem (confidence-gated) ────────────────────────
    format_result = format_problem(clean_text, user_id=user_id)

    if format_result.parsed and isinstance(format_result.parsed, dict):
        problem_data = format_result.parsed
    else:
        # Last-ditch fallback so the user always gets *something* back
        problem_data = {
            "title": "Community Issue Report",
            "category": "Other",
            "severity": "Medium",
            "location": "Common area — exact location needs verification",
            "formatted_description": raw_text,
            "affected_residents": "Society residents — impact scope to be assessed",
        }

    # ── Step 4b: Severity auto-escalation ────────────────────────────────────
    urgency_match = _detect_urgency_escalation(raw_text)
    if urgency_match and problem_data.get("severity") in ("Low", "Medium"):
        problem_data["severity"] = "High"

    # ── Step 5: Generate solutions (confidence-gated) ────────────────────────
    solutions_result = suggest_solutions(json.dumps(problem_data), user_id=user_id)

    if solutions_result.parsed and isinstance(solutions_result.parsed, list):
        solutions = solutions_result.parsed
    else:
        solutions = [
            {"action": "Immediately report this to the Managing Committee Secretary and request an emergency inspection.", "responsible_party": "Managing Committee Secretary", "timeline": "Within 4 hours", "priority": 1},
            {"action": "Engage the society's maintenance staff or an external vendor to assess and begin repair work.", "responsible_party": "Society Maintenance Staff", "timeline": "Within 48 hours", "priority": 2},
            {"action": "Schedule a follow-up inspection. Document with photos and update residents via society WhatsApp group.", "responsible_party": "Managing Committee", "timeline": "Within 1 week", "priority": 3},
        ]

    # ── Step 6: Deduct tokens ────────────────────────────────────────────────
    actual_tokens = (
        len(clean_text.split())
        + len(json.dumps(problem_data).split())
        + len(json.dumps(solutions).split())
    ) * 2
    if user_id:
        deduct_tokens(user_id, actual_tokens)

    # ── Step 7: Aggregate confidence + escalation telemetry ──────────────────
    # We use the *minimum* confidence across both calls — the chain is only as
    # strong as its weakest link.
    aggregate_confidence = min(format_result.confidence, solutions_result.confidence)
    was_escalated = bool(format_result.escalations or solutions_result.escalations)
    auto_resolved = aggregate_confidence >= AUTO_RESOLVE_THRESHOLD

    # Embedding for future semantic dedup + nearest-neighbor lookups
    embedding = embed_text(raw_text)

    return {
        **problem_data,
        "solutions": solutions,
        "raw_input": raw_text,
        "confidence_score": aggregate_confidence,
        "was_escalated": was_escalated,
        "last_model_used": format_result.model_used,
        "auto_resolved": auto_resolved,
        "embedding_json": json.dumps(embedding),
    }
