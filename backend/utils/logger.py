"""
Prayaas Structured Logger

JSON-formatted structured logging with contextual fields.
Uses structlog for machine-parseable log output.
"""

import os
import logging
import sys

try:
    import structlog
    _HAS_STRUCTLOG = True
except ImportError:
    _HAS_STRUCTLOG = False

_configured = False


def _configure():
    """Configure structlog (called once on first use)."""
    global _configured
    if _configured or not _HAS_STRUCTLOG:
        return
    _configured = True

    env = os.getenv("ENVIRONMENT", "development")

    if env == "development":
        # Pretty console output for dev
        renderer = structlog.dev.ConsoleRenderer()
    else:
        # JSON for production (ELK/CloudWatch/etc.)
        renderer = structlog.processors.JSONRenderer()

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.dev.set_exc_info,
            renderer,
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str = "prayaas"):
    """
    Get a structured logger instance.

    Usage:
        log = get_logger()
        log.info("user_action", user_id=42, action="login", ip="1.2.3.4")
        log.warning("injection_attempt", user_id=42, pattern="ignore instructions")
    """
    if _HAS_STRUCTLOG:
        _configure()
        return structlog.get_logger(name)
    else:
        # Fallback to standard logging
        logger = logging.getLogger(name)
        if not logger.handlers:
            handler = logging.StreamHandler(sys.stdout)
            handler.setFormatter(logging.Formatter(
                "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
            ))
            logger.addHandler(handler)
            logger.setLevel(logging.INFO)
        return logger
