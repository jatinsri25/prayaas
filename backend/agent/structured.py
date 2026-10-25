"""Bounded structured generation. Never log complaint text or model output."""
from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from dataclasses import asdict
from datetime import datetime, timedelta
from threading import Event
from typing import Callable, Optional, Type

from fastapi import HTTPException
from pydantic import BaseModel, ValidationError

from agent import confidence_gate as gate
from agent.pii import redact_pii
from agent.availability import known_failure, require_provider_attempt, provider_error, MESSAGES
from database import SessionLocal
from models import AICallBudget, StructuredCache
from utils.logger import get_logger

log = get_logger()


def _insert_ignore(db, table, values):
    if db.bind.dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    else:
        from sqlalchemy.dialects.sqlite import insert
    return db.execute(insert(table).values(**values).on_conflict_do_nothing())


def reserve_call(user_id: Optional[int] = None):
    """Reserve before the provider call; failed calls still consume a reservation."""
    day = datetime.utcnow().date().isoformat()
    limits = [(f"global:{day}", int(os.getenv("PRAYAAS_AI_DAILY_CALL_LIMIT", "20")))]
    if user_id is not None:
        limits.append((f"user:{user_id}:{day}", int(os.getenv("PRAYAAS_AI_USER_DAILY_CALL_LIMIT", "10"))))
    now = datetime.utcnow()
    with SessionLocal.begin() as db:
        for key, limit in limits:
            _insert_ignore(db, AICallBudget, {"key": key, "calls": 0})
            changed = db.query(AICallBudget).filter(
                AICallBudget.key == key, AICallBudget.calls < max(0, limit),
                (AICallBudget.blocked_until.is_(None)) | (AICallBudget.blocked_until <= now),
            ).update({AICallBudget.calls: AICallBudget.calls + 1}, synchronize_session=False)
            if not changed:
                raise HTTPException(429, "AI drafting is unavailable: daily limit or provider cooldown. You can post without AI.")


def mark_provider_exhausted():
    with SessionLocal.begin() as db:
        key = "global:" + datetime.utcnow().date().isoformat()
        _insert_ignore(db, AICallBudget, {"key": key, "calls": 0})
        db.query(AICallBudget).filter_by(key=key).update({
            "blocked_until": datetime.utcnow() + timedelta(seconds=max(60, int(os.getenv("PRAYAAS_AI_COOLDOWN_SECONDS", "900")))),
        })


def ai_status(user_id=None):
    """Read local configuration/reservations only; never spend provider quota."""
    state = {"code": "eligible", "can_attempt": True, "retry_at": None,
             "message": "AI can be attempted. Provider availability is checked only when you request a draft."}
    if not os.getenv("GOOGLE_API_KEY", ""):
        return {**state, "code": "unconfigured", "can_attempt": False, "message": MESSAGES["unconfigured"]}
    failure = known_failure(gate.MODEL_CHAIN[0])
    if failure:
        return {**state, **failure, "can_attempt": False}
    now = datetime.utcnow()
    day = now.date().isoformat()
    limits = [(f"global:{day}", int(os.getenv("PRAYAAS_AI_DAILY_CALL_LIMIT", "20")))]
    if user_id is not None:
        limits.append((f"user:{user_id}:{day}", int(os.getenv("PRAYAAS_AI_USER_DAILY_CALL_LIMIT", "10"))))
    with SessionLocal() as db:
        for key, limit in limits:
            row = db.get(AICallBudget, key)
            if (row.calls if row else 0) >= max(0, limit):
                reset = datetime.combine(now.date() + timedelta(days=1), datetime.min.time())
                return {**state, "code": "daily_limit", "can_attempt": False,
                        "retry_at": reset.isoformat() + "Z",
                        "message": "The local daily AI limit is reached. Cached drafts may still work; you can also post without AI."}
            if row and row.blocked_until and row.blocked_until > now:
                return {**state, "code": "quota", "can_attempt": False,
                        "retry_at": row.blocked_until.isoformat() + "Z", "message": MESSAGES["quota"]}
    return state


def _cached_result(payload, schema):
    data = json.loads(payload)
    data["parsed"] = schema.model_validate(data["parsed"]).model_dump(mode="json")
    result = gate.GateResult(**data)
    result.cache_hit = True
    result.usage = {"prompt_tokens": 0, "completion_tokens": 0}
    result.usage_by_model = []
    result.elapsed_ms = 0
    return result


def structured_call(
    prompt: str, schema: Type[BaseModel], *, task_type: str,
    user_id: Optional[int] = None, scope: Optional[str] = None,
    ttl_seconds: int = 86400, cancelled: Optional[Event] = None,
    on_attempt: Optional[Callable[[int], None]] = None,
    on_event: Optional[Callable] = None, budget_check: Optional[Callable] = None,
) -> gate.GateResult:
    """One generation, plus one schema-only retry. Cache keys include scope/schema/model.

    The DB lease prevents concurrent identical requests across workers from
    spending quota twice. No database transaction is held during network I/O.
    """
    clean_prompt, _ = redact_pii(prompt)
    key = hashlib.sha256(json.dumps([
        "structured-v1", scope or f"user:{user_id}", task_type,
        gate.MODEL_CHAIN[0], schema.model_json_schema(), clean_prompt,
    ], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    owner = str(uuid.uuid4())
    started = time.monotonic()
    deadline = started + 48
    while True:
        if cancelled is not None and cancelled.is_set():
            raise HTTPException(499, "Draft cancelled")
        now = datetime.utcnow()
        with SessionLocal.begin() as db:
            # Delete expired response bodies instead of retaining an unbounded corpus.
            db.query(StructuredCache).filter(StructuredCache.expires_at < now).delete(synchronize_session=False)
            row = db.get(StructuredCache, key)
            if row and row.result_json:
                try:
                    result = _cached_result(row.result_json, schema)
                    log.info("structured_ai", task=task_type, cache_hit=True, input_hash=key[:12])
                    return result
                except (ValueError, TypeError):
                    db.delete(row)
                    db.flush()
                    row = None
            if row is None:
                _insert_ignore(db, StructuredCache, {
                    "key": key, "owner": owner, "expires_at": now + timedelta(seconds=65),
                })
            claimed = db.query(StructuredCache).filter_by(key=key, owner=owner).count() == 1
        if claimed:
            break
        if time.monotonic() >= deadline:
            raise HTTPException(503, "An identical draft is still being prepared. Try again or continue without AI.")
        time.sleep(.1)

    result = None
    usage_by_model = []
    errors = []
    try:
        if budget_check:
            budget_check()
        model = gate.MODEL_CHAIN[0]
        for attempt in range(2):
            if cancelled is not None and cancelled.is_set():
                raise HTTPException(499, "Draft cancelled")
            require_provider_attempt(model)
            reserve_call(user_id)
            if on_attempt:
                on_attempt(attempt)
            try:
                response_text, usage = gate._raw_call(
                    model, clean_prompt, .1, response_schema=schema, timeout_ms=20000,
                )
            except Exception as exc:
                error = provider_error(exc, model)
                if error.status_code == 429:
                    mark_provider_exhausted()
                raise error from exc
            if usage:
                usage_by_model.append({"model": model, **usage})
            score, parsed = gate._score_json_validity(response_text)
            try:
                parsed = schema.model_validate(parsed).model_dump(mode="json")
            except (ValidationError, TypeError, ValueError):
                errors.append(f"{model}:InvalidSchema")
                if attempt == 0:
                    continue
                raise HTTPException(503, "AI could not produce a valid draft. You can post without AI.")
            confidence = gate.compute_confidence(response_text, parsed, score)
            result = gate.GateResult(
                text=response_text, parsed=parsed, model_used=model,
                confidence=confidence, escalations=attempt,
                auto_resolved=confidence >= gate.AUTO_RESOLVE_THRESHOLD,
                errors=errors, elapsed_ms=int((time.monotonic() - started) * 1000),
                usage={name: sum(item[name] for item in usage_by_model) for name in ("prompt_tokens", "completion_tokens")}
                if len(usage_by_model) == attempt + 1 else None,
                usage_by_model=usage_by_model,
            )
            break
        if cancelled is not None and cancelled.is_set():
            raise HTTPException(499, "Draft cancelled")
        with SessionLocal.begin() as db:
            db.query(StructuredCache).filter_by(key=key, owner=owner).update({
                "result_json": json.dumps(asdict(result), ensure_ascii=False),
                "expires_at": datetime.utcnow() + timedelta(seconds=ttl_seconds),
            })
        if on_event:
            on_event(result, task_type)
        log.info("structured_ai", task=task_type, cache_hit=False, input_hash=key[:12],
                 elapsed_ms=result.elapsed_ms, attempts=result.escalations + 1, model=model)
        return result
    except Exception as exc:
        log.warning("structured_ai_failed", task=task_type, input_hash=key[:12],
                    error_type=type(exc).__name__, status=getattr(exc, "status_code", None),
                    elapsed_ms=int((time.monotonic() - started) * 1000))
        raise
    finally:
        if result is None or (cancelled is not None and cancelled.is_set()):
            with SessionLocal.begin() as db:
                db.query(StructuredCache).filter_by(key=key, owner=owner).filter(
                    StructuredCache.result_json.is_(None),
                ).delete(synchronize_session=False)
