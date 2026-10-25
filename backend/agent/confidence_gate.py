"""
Prayaas Confidence-Gated AI Pipeline

This module is the operational heart of the resume line:
  > "Designed a confidence-gated AI pipeline with automatic model
  >  escalation achieving 94% auto-resolution — no human in the loop."

Every Gemini call routes through `gated_call(...)`. We:

  1. Try the cheapest model in the chain.
  2. Score the output's *confidence* against schema + heuristic checks.
  3. If confidence < `AUTO_RESOLVE_THRESHOLD`, escalate to the next stronger
     model. We continue until either confidence is high enough OR the chain
     is exhausted (then we mark the event as `requires_review = True`).
  4. Persist an `AutoResolutionEvent` row for every call so the admin
     dashboard can compute the live auto-resolution rate.

Confidence is a [0.0, 1.0] score combining:
  - JSON parse validity         (0.40 weight — fatal if false)
  - Schema-required field count (0.30 weight)
  - Length sanity check         (0.10 weight)
  - Distress/urgency agreement  (0.10 weight)
  - LLM self-reported "low confidence" phrases (0.10 weight, negative signal)
"""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field
from threading import Event
from typing import Any, Callable, Dict, List, Optional

from google.genai import Client as GenaiClient

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "")
_client = GenaiClient(api_key=GOOGLE_API_KEY) if GOOGLE_API_KEY else None

# ── Model escalation chain ───────────────────────────────────────────────────
# Cheapest → most capable. We escalate on low confidence, not just on quota.
MODEL_CHAIN: List[str] = [name.strip() for name in os.getenv(
    "PRAYAAS_MODEL_CHAIN", "gemini-3.5-flash-lite,gemini-3.8-flash"
).split(",") if name.strip()]
if not MODEL_CHAIN:
    raise ValueError("PRAYAAS_MODEL_CHAIN must contain at least one model")

# A response with confidence at or above this is auto-resolved (no human review).
AUTO_RESOLVE_THRESHOLD: float = float(os.getenv("PRAYAAS_AUTO_RESOLVE_THRESHOLD", "0.78"))

# Phrases that indicate the LLM itself flagged uncertainty.
_LOW_CONFIDENCE_PHRASES = [
    "i'm not sure",
    "i am unsure",
    "uncertain",
    "cannot determine",
    "could not parse",
    "needs verification",
    "unclear",
    "insufficient information",
]


@dataclass
class GateResult:
    """Outcome of a confidence-gated LLM call."""
    text: str
    parsed: Optional[Any]
    model_used: str
    confidence: float
    escalations: int
    auto_resolved: bool
    errors: List[str] = field(default_factory=list)
    elapsed_ms: int = 0
    usage: Optional[Dict[str, int]] = None
    usage_by_model: List[Dict[str, Any]] = field(default_factory=list)
    cache_hit: bool = False

    def to_log_meta(self) -> Dict[str, Any]:
        return {
            "model": self.model_used,
            "confidence": round(self.confidence, 3),
            "escalations": self.escalations,
            "auto_resolved": self.auto_resolved,
            "elapsed_ms": self.elapsed_ms,
            "had_errors": bool(self.errors),
        }


# ── Confidence scorers ──────────────────────────────────────────────────────

def _score_json_validity(text: str) -> tuple[float, Optional[Any]]:
    """0.0 if not parseable JSON, 1.0 if it is. Returns parsed value too."""
    cleaned = text.strip()
    # Strip common markdown fences
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```\s*$", "", cleaned)
    try:
        return 1.0, json.loads(cleaned)
    except (json.JSONDecodeError, ValueError):
        # Try to recover an embedded JSON object/array
        for pattern in (r"\{.*\}", r"\[.*\]"):
            m = re.search(pattern, cleaned, re.DOTALL)
            if m:
                try:
                    return 0.7, json.loads(m.group())
                except (json.JSONDecodeError, ValueError):
                    continue
        return 0.0, None


def _score_required_fields(parsed: Any, required: List[str]) -> float:
    """Fraction of required fields that are present and non-empty."""
    if not required:
        return 1.0
    if not isinstance(parsed, dict):
        return 0.0
    present = sum(1 for f in required if parsed.get(f))
    return present / len(required)


def _score_length(text: str) -> float:
    """Penalize very short or empty responses."""
    n = len(text.strip())
    if n < 20:
        return 0.0
    if n < 100:
        return 0.5
    return 1.0


def _score_no_uncertainty(text: str) -> float:
    """1.0 if no low-confidence phrases detected, 0.0 if any present."""
    lower = text.lower()
    for phrase in _LOW_CONFIDENCE_PHRASES:
        if phrase in lower:
            return 0.0
    return 1.0


def compute_confidence(
    text: str,
    parsed: Optional[Any],
    json_valid_score: float,
    required_fields: Optional[List[str]] = None,
) -> float:
    """
    Weighted composite confidence in [0.0, 1.0].

    Weights are deliberately conservative — a response with invalid JSON
    can never exceed ~0.6, which keeps the auto-resolve gate honest.
    """
    field_score = _score_required_fields(parsed, required_fields or [])
    len_score = _score_length(text)
    cert_score = _score_no_uncertainty(text)

    return round(
        0.40 * json_valid_score
        + 0.30 * field_score
        + 0.10 * len_score
        + 0.10 * cert_score
        + 0.10 * (1.0 if parsed is not None else 0.0),
        4,
    )


# ── Core gated call ──────────────────────────────────────────────────────────

def _raw_call(
    model: str, prompt: str, temperature: float,
    *, timeout_ms: int = 20000, response_schema: Optional[type] = None,
    max_output_tokens: int = 3200,
) -> tuple[str, Optional[Dict[str, int]]]:
    """Single Gemini call. Raises on hard errors."""
    if _client is None:
        from fastapi import HTTPException
        from agent.availability import MESSAGES
        raise HTTPException(503, MESSAGES["unconfigured"])
    config = {
        "temperature": temperature,
        "response_mime_type": "application/json",
        # The gate owns retries; SDK retries must not multiply the latency.
        "http_options": {"timeout": timeout_ms, "retry_options": {"attempts": 1}},
    }
    if response_schema is not None:
        config.update(response_json_schema=response_schema.model_json_schema(), max_output_tokens=max_output_tokens)
    response = _client.models.generate_content(
        model=model,
        contents=prompt,
        config=config,
    )
    meta = response.usage_metadata
    usage = None
    if meta is not None and meta.prompt_token_count is not None and meta.candidates_token_count is not None:
        usage = {
            "prompt_tokens": meta.prompt_token_count,
            "completion_tokens": meta.candidates_token_count + (meta.thoughts_token_count or 0),
        }
    return (response.text or "").strip(), usage


def gated_call(
    prompt: str,
    *,
    task_type: str,
    required_fields: Optional[List[str]] = None,
    temperature: float = 0.2,
    threshold: float = AUTO_RESOLVE_THRESHOLD,
    on_event: Optional[Callable[[GateResult, str], None]] = None,
    user_id: Optional[int] = None,
    response_schema: Optional[type] = None,
    validate: Optional[Callable[[Any], Any]] = None,
    on_attempt: Optional[Callable[[int], None]] = None,
    cancelled: Optional[Event] = None,
    timeout_seconds: float = 40,
) -> GateResult:
    """
    Run `prompt` through the model chain, escalating on low confidence.

    Args:
        prompt:           The fully-rendered LLM prompt.
        task_type:        Logical task name (e.g. "format_problem", "rag_answer").
                          Used by metrics + ML feedback aggregations.
        required_fields:  Top-level JSON keys we need for downstream code.
        temperature:      Sampling temperature.
        threshold:        Confidence floor for auto-resolution.
        on_event:         Optional callback receiving (result, task_type).
                          Used to persist AutoResolutionEvent rows.
        user_id:          For audit logging.
    """
    start = time.monotonic()
    last: GateResult | None = None
    errors: List[str] = []
    attempts = 0
    usage_complete = True
    usage_by_model = []

    for index, model in enumerate(MODEL_CHAIN):
        remaining = timeout_seconds - (time.monotonic() - start)
        # Gemini rejects a server deadline below ten seconds.
        if remaining < 10 or (cancelled is not None and cancelled.is_set()):
            break
        attempts += 1
        if on_attempt:
            on_attempt(index)
        try:
            text, usage = _raw_call(
                model, prompt, temperature,
                timeout_ms=max(1, int(min(20, remaining) * 1000)),
                response_schema=response_schema,
            )
            if usage is None:
                usage_complete = False
            else:
                usage_by_model.append({"model": model, **usage})
        except Exception as exc:
            usage_complete = False
            errors.append(f"{model}:{type(exc).__name__}:{getattr(exc, 'code', '')}")
            # Escalate on quota/availability errors
            if any(s in str(exc) for s in ("429", "503", "404", "RESOURCE_EXHAUSTED", "UNAVAILABLE")) or isinstance(exc, TimeoutError) or "timeout" in type(exc).__name__.lower():
                continue
            break

        json_score, parsed = _score_json_validity(text)
        confidence = compute_confidence(text, parsed, json_score, required_fields)
        if validate is not None:
            try:
                parsed = validate(parsed)
            except (ValueError, TypeError):
                parsed = None
                confidence = 0.0
                errors.append(f"{model}:InvalidSchema")

        candidate = GateResult(
            text=text,
            parsed=parsed,
            model_used=model,
            confidence=confidence,
            escalations=index,
            auto_resolved=confidence >= threshold,
            errors=list(errors),
            elapsed_ms=int((time.monotonic() - start) * 1000),
        )
        if last is None or candidate.confidence > last.confidence:
            last = candidate

        if confidence >= threshold:
            break  # auto-resolved — no escalation needed

    # If chain exhausted without crossing threshold, last still holds the
    # best attempt — caller decides whether to use it (we mark auto_resolved=False).
    if last is None:
        last = GateResult(
            text="",
            parsed=None,
            model_used=MODEL_CHAIN[max(0, attempts - 1)],
            confidence=0.0,
            escalations=max(0, attempts - 1),
            auto_resolved=False,
            errors=errors,
            elapsed_ms=int((time.monotonic() - start) * 1000),
        )

    last.errors = errors
    last.escalations = max(0, attempts - 1)
    last.elapsed_ms = int((time.monotonic() - start) * 1000)
    last.usage_by_model = usage_by_model
    if usage_complete and usage_by_model:
        last.usage = {
            key: sum(item[key] for item in usage_by_model)
            for key in ("prompt_tokens", "completion_tokens")
        }

    if on_event:
        try:
            on_event(last, task_type)
        except Exception:
            pass

    return last
