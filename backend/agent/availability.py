"""Local provider state, not a health probe. Never persist provider response bodies."""
from __future__ import annotations

import hashlib
import os
from datetime import datetime, timedelta

from fastapi import HTTPException

from database import SessionLocal
from models import AIProviderState
from utils.logger import get_logger

MESSAGES = {
    "unconfigured": "AI is not configured. Ask the administrator to configure Gemini, or write your report without AI.",
    "credentials": "Gemini rejected the server credentials. An administrator needs to check the API key and permissions. You can post without AI.",
    "model_unavailable": "The configured AI model is unavailable for this project. An administrator needs to update the model. You can post without AI.",
    "quota": "AI provider quota is unavailable. You can post without AI.",
    "request_rejected": "AI could not accept this request. For a recording, try recording again or type the details. You can post without AI.",
    "timeout": "AI took too long. Your input is still on this page. Try later or post without AI.",
    "unavailable": "The AI provider is temporarily unavailable. Your input is still on this page. You can post without AI.",
}


def _key(model):
    # A replacement key/model must not inherit an old configuration failure.
    return hashlib.sha256((os.getenv("GOOGLE_API_KEY", "") + ":" + model).encode()).hexdigest()


def known_failure(model):
    with SessionLocal() as db:
        row = db.get(AIProviderState, _key(model))
        if row and row.retry_at > datetime.utcnow():
            return {"code": row.error_code, "retry_at": row.retry_at.isoformat() + "Z",
                    "message": MESSAGES.get(row.error_code, MESSAGES["unavailable"])}
    return None


def require_provider_attempt(model):
    failure = known_failure(model)
    if failure:
        raise HTTPException(429 if failure["code"] == "quota" else 503, failure["message"])


def provider_error(exc, model):
    if isinstance(exc, HTTPException):
        return exc
    try:
        status = int(getattr(exc, "code", 0) or 0)
    except (TypeError, ValueError):
        status = 0
    # Inspect privately for known reasons; never return/log the SDK message.
    detail = str(exc).lower()
    if status in (401, 403) or any(word in detail for word in ("api_key_invalid", "api key not valid", "api key expired", "reported as leaked")):
        code = "credentials"
    elif status == 404:
        code = "model_unavailable"
    elif status == 429 or "resource_exhausted" in detail:
        code = "quota"
    elif status in (408, 504) or isinstance(exc, TimeoutError) or "timeout" in type(exc).__name__.lower():
        code = "timeout"
    elif status == 400:
        code = "request_rejected"
    else:
        code = "unavailable"
    get_logger().warning("ai_provider_failed", model=model, reason=code, status=status,
                         error_type=type(exc).__name__)
    # A bad individual request must not disable AI for other residents.
    if code != "request_rejected":
        seconds = 600 if code in ("credentials", "model_unavailable") else 30
        if code == "quota":
            seconds = max(60, int(os.getenv("PRAYAAS_AI_COOLDOWN_SECONDS", "900")))
        with SessionLocal.begin() as db:
            if db.bind.dialect.name == "postgresql":
                from sqlalchemy.dialects.postgresql import insert
            else:
                from sqlalchemy.dialects.sqlite import insert
            values = {"key": _key(model), "error_code": code,
                      "retry_at": datetime.utcnow() + timedelta(seconds=seconds)}
            db.execute(insert(AIProviderState).values(**values).on_conflict_do_update(
                index_elements=["key"], set_={"error_code": code, "retry_at": values["retry_at"]},
            ))
    return HTTPException(429 if code == "quota" else 504 if code == "timeout" else 503, MESSAGES[code])
