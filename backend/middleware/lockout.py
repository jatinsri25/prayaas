"""
Prayaas Account Lockout Middleware

Redis-backed brute-force protection:
  - 5 failed attempts → 15-minute lockout per user+IP
  - 10+ failures → alert (credential stuffing detection)
"""

import os
from fastapi import HTTPException

# Redis is lazily imported to allow running without Redis in dev mode
_redis_client = None


def _get_redis():
    """Get or create Redis connection (lazy init)."""
    global _redis_client
    if _redis_client is None:
        import redis
        redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
        try:
            _redis_client = redis.from_url(redis_url, decode_responses=True)
            _redis_client.ping()
        except Exception:
            # Redis not available — lockout disabled (dev mode)
            _redis_client = None
    return _redis_client


LOCKOUT_THRESHOLD = 5
LOCKOUT_SECONDS = 900   # 15 minutes
ALERT_THRESHOLD = 10


def check_lockout(identifier: str) -> None:
    """
    Check if an account/IP is locked out.
    identifier: 'user_id:ip' or 'email:ip'
    Raises HTTP 429 if locked.
    """
    r = _get_redis()
    if r is None:
        return  # Redis unavailable — skip lockout in dev

    key = f"lockout:{identifier}"
    attempts = r.get(key)
    if attempts and int(attempts) >= LOCKOUT_THRESHOLD:
        ttl = r.ttl(key)
        raise HTTPException(
            status_code=429,
            detail=f"Account locked due to too many failed attempts. Try again in {max(ttl, 0) // 60 + 1} minutes."
        )


def record_failed_attempt(identifier: str) -> int:
    """
    Record a failed login attempt. Returns the current count.
    identifier: 'user_id:ip' or 'email:ip'
    """
    r = _get_redis()
    if r is None:
        return 0

    key = f"lockout:{identifier}"
    pipe = r.pipeline()
    pipe.incr(key)
    pipe.expire(key, LOCKOUT_SECONDS)
    count, _ = pipe.execute()

    if count >= ALERT_THRESHOLD:
        # Log high failure rate — possible credential stuffing
        from utils.logger import get_logger
        log = get_logger()
        log.warning(
            "credential_stuffing_alert",
            identifier=identifier,
            attempt_count=count,
        )

    return count


def clear_lockout(identifier: str) -> None:
    """Clear lockout counter on successful login."""
    r = _get_redis()
    if r is None:
        return
    r.delete(f"lockout:{identifier}")
