"""
Prayaas Audit Logger

Writes immutable audit log entries to the database.
Each entry includes a SHA-256 checksum for tamper detection.
"""

import hashlib
import json
from datetime import datetime
from typing import Optional
from sqlalchemy.orm import Session
import models


def log_action(
    db: Session,
    action: str,
    user_id: Optional[int] = None,
    resource: Optional[str] = None,
    ip_address: Optional[str] = None,
    meta: Optional[dict] = None,
) -> None:
    """
    Write an audit log entry with integrity checksum.

    Args:
        db: Database session
        action: Action type (LOGIN, REGISTER, POST_PROBLEM, AI_CALL, UPVOTE, etc.)
        user_id: Acting user (None for system actions)
        resource: Resource identifier (e.g., "problem:42", "user:7")
        ip_address: Client IP
        meta: Additional context as dict
    """
    try:
        ts = datetime.utcnow()
        meta_json = json.dumps(meta, default=str) if meta else None

        # Compute checksum over all fields for tamper detection
        content = f"{ts.isoformat()}:{user_id}:{action}:{resource}:{ip_address}:{meta_json}"
        checksum = hashlib.sha256(content.encode()).hexdigest()

        entry = models.AuditLog(
            ts=ts,
            user_id=user_id,
            action=action,
            resource=resource,
            ip_address=ip_address,
            meta=meta_json,
            checksum=checksum,
        )
        db.add(entry)
        db.commit()
    except Exception:
        db.rollback()  # never let audit failures crash the app
