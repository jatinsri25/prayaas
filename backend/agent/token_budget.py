"""
Prayaas AI Token Budget

Per-user daily token budget tracking via Redis.
Prevents abuse and controls AI costs.
"""

import os
from datetime import datetime

_redis_client = None
DEFAULT_DAILY_BUDGET = int(os.getenv("AI_TOKEN_BUDGET_PER_USER", "50000"))


def _get_redis():
    global _redis_client
    if _redis_client is None:
        try:
            import redis
            redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
            _redis_client = redis.from_url(redis_url, decode_responses=True)
            _redis_client.ping()
        except Exception:
            _redis_client = None
    return _redis_client


def _budget_key(user_id: int) -> str:
    """Key includes date so it auto-resets daily."""
    today = datetime.utcnow().strftime("%Y-%m-%d")
    return f"token_budget:{user_id}:{today}"


def get_remaining_budget(user_id: int) -> int:
    """Get remaining token budget for the user today."""
    r = _get_redis()
    if r is None:
        return DEFAULT_DAILY_BUDGET  # no Redis = unlimited (dev mode)

    key = _budget_key(user_id)
    used = r.get(key)
    if used is None:
        return DEFAULT_DAILY_BUDGET
    return max(0, DEFAULT_DAILY_BUDGET - int(used))


def deduct_tokens(user_id: int, tokens: int) -> int:
    """Deduct tokens from the user's daily budget. Returns remaining."""
    r = _get_redis()
    if r is None:
        return DEFAULT_DAILY_BUDGET

    key = _budget_key(user_id)
    pipe = r.pipeline()
    pipe.incrby(key, tokens)
    pipe.expire(key, 86400)  # expire at end of day (24h TTL)
    used, _ = pipe.execute()
    return max(0, DEFAULT_DAILY_BUDGET - int(used))


def has_budget(user_id: int, estimated_tokens: int) -> bool:
    """Check if the user has enough budget for the estimated tokens."""
    return get_remaining_budget(user_id) >= estimated_tokens
