"""
Prayaas Admin / ML Feedback Loop Router

Endpoints powering the admin dashboard at /admin:

  GET  /api/admin/feedback              → headline metrics
  GET  /api/admin/feedback/corrections  → recent admin corrections
  POST /api/admin/feedback/recompute    → rebuild ModelTrustScore for the
                                          current week (manual trigger;
                                          a Celery beat job runs this
                                          weekly in production)

The `auto_resolution_rate` metric is the resume line:
    "...achieving 94% auto-resolution — no human in the loop."
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from dependencies import Role, require_role
import models
import schemas

router = APIRouter(prefix="/api/admin", tags=["admin"])


def _week_start(dt: datetime) -> datetime:
    """Floor a datetime to the start of its ISO week (Monday 00:00 UTC)."""
    monday = dt - timedelta(days=dt.weekday())
    return monday.replace(hour=0, minute=0, second=0, microsecond=0)


@router.get("/feedback", response_model=schemas.FeedbackMetricsOut)
def get_feedback_metrics(
    days: int = Query(default=30, ge=1, le=365),
    db: Session = Depends(get_db),
    _: models.User = Depends(require_role(Role.GROUP_ADMIN)),
):
    """
    Headline metrics for the admin dashboard.

    Window defaults to last 30 days. The `auto_resolution_rate` is the
    star metric — what the resume line is selling.
    """
    cutoff = datetime.utcnow() - timedelta(days=days)

    events = (
        db.query(models.AutoResolutionEvent)
        .filter(models.AutoResolutionEvent.ts >= cutoff)
        .all()
    )
    corrections = (
        db.query(models.AICorrection)
        .filter(models.AICorrection.ts >= cutoff)
        .all()
    )

    total_events = len(events)
    total_corrections = len(corrections)

    auto_resolved = sum(1 for e in events if e.auto_resolved)
    escalated = sum(1 for e in events if e.escalations > 0)
    sum_conf = sum(e.confidence for e in events) if events else 0.0
    sum_lat = sum(e.elapsed_ms for e in events) if events else 0

    auto_resolution_rate = (auto_resolved / total_events) if total_events else 0.0
    escalation_rate = (escalated / total_events) if total_events else 0.0
    avg_confidence = (sum_conf / total_events) if total_events else 0.0
    avg_latency_ms = int(sum_lat / total_events) if total_events else 0

    by_task: dict = defaultdict(lambda: {"count": 0, "auto_resolved": 0, "avg_confidence": 0.0})
    by_model: dict = defaultdict(lambda: {"count": 0, "auto_resolved": 0, "avg_confidence": 0.0})

    for e in events:
        bt = by_task[e.task_type]
        bt["count"] += 1
        bt["auto_resolved"] += int(bool(e.auto_resolved))
        bt["avg_confidence"] += e.confidence

        bm = by_model[e.model_used]
        bm["count"] += 1
        bm["auto_resolved"] += int(bool(e.auto_resolved))
        bm["avg_confidence"] += e.confidence

    for bucket in (*by_task.values(), *by_model.values()):
        if bucket["count"]:
            bucket["avg_confidence"] = round(bucket["avg_confidence"] / bucket["count"], 4)
            bucket["auto_rate"] = round(bucket["auto_resolved"] / bucket["count"], 4)

    # 7-day correction trend
    trend: dict = defaultdict(int)
    for c in corrections:
        if c.ts >= datetime.utcnow() - timedelta(days=7):
            trend[c.ts.date().isoformat()] += 1

    correction_trends_7d = [
        {"date": (datetime.utcnow().date() - timedelta(days=offset)).isoformat(),
         "count": trend.get((datetime.utcnow().date() - timedelta(days=offset)).isoformat(), 0)}
        for offset in range(6, -1, -1)
    ]

    return schemas.FeedbackMetricsOut(
        auto_resolution_rate=round(auto_resolution_rate, 4),
        total_events=total_events,
        total_corrections=total_corrections,
        escalation_rate=round(escalation_rate, 4),
        avg_confidence=round(avg_confidence, 4),
        avg_latency_ms=avg_latency_ms,
        by_task=dict(by_task),
        by_model=dict(by_model),
        correction_trends_7d=correction_trends_7d,
    )


@router.get("/feedback/corrections", response_model=List[schemas.AICorrectionOut])
def list_recent_corrections(
    limit: int = Query(default=25, ge=1, le=200),
    db: Session = Depends(get_db),
    _: models.User = Depends(require_role(Role.GROUP_ADMIN)),
):
    """Most recent admin corrections — for the dashboard feed."""
    return (
        db.query(models.AICorrection)
        .order_by(models.AICorrection.ts.desc())
        .limit(limit)
        .all()
    )


@router.post("/feedback/recompute", response_model=List[schemas.ModelTrustScoreOut])
def recompute_trust_scores(
    db: Session = Depends(get_db),
    _: models.User = Depends(require_role(Role.SOCIETY_ADMIN)),
):
    """
    Rebuild ModelTrustScore rows for the current ISO week.

    success_rate = 1 - (corrections_for_model / events_for_model)
    """
    now = datetime.utcnow()
    week_start = _week_start(now)
    week_end = week_start + timedelta(days=7)

    events = (
        db.query(models.AutoResolutionEvent)
        .filter(models.AutoResolutionEvent.ts >= week_start)
        .filter(models.AutoResolutionEvent.ts < week_end)
        .all()
    )
    corrections = (
        db.query(models.AICorrection)
        .filter(models.AICorrection.ts >= week_start)
        .filter(models.AICorrection.ts < week_end)
        .all()
    )

    # Bucket events by model
    per_model: dict = defaultdict(lambda: {"events": [], "corrections": 0})
    for e in events:
        per_model[e.model_used]["events"].append(e)
    for c in corrections:
        if c.model_used:
            per_model[c.model_used]["corrections"] += 1

    output: List[models.ModelTrustScore] = []
    for model_name, bucket in per_model.items():
        ev = bucket["events"]
        sample_count = len(ev)
        auto_resolved_count = sum(1 for e in ev if e.auto_resolved)
        correction_count = bucket["corrections"]
        success_rate = 1.0 - (correction_count / sample_count) if sample_count else 0.0
        avg_confidence = sum(e.confidence for e in ev) / sample_count if sample_count else 0.0
        avg_latency_ms = int(sum(e.elapsed_ms for e in ev) / sample_count) if sample_count else 0

        # Upsert (model_name, week_start)
        existing = (
            db.query(models.ModelTrustScore)
            .filter(models.ModelTrustScore.model_name == model_name)
            .filter(models.ModelTrustScore.week_start == week_start)
            .first()
        )
        if existing:
            existing.sample_count = sample_count
            existing.auto_resolved_count = auto_resolved_count
            existing.correction_count = correction_count
            existing.success_rate = round(success_rate, 4)
            existing.avg_confidence = round(avg_confidence, 4)
            existing.avg_latency_ms = avg_latency_ms
            existing.computed_at = datetime.utcnow()
            output.append(existing)
        else:
            row = models.ModelTrustScore(
                model_name=model_name,
                week_start=week_start,
                sample_count=sample_count,
                auto_resolved_count=auto_resolved_count,
                correction_count=correction_count,
                success_rate=round(success_rate, 4),
                avg_confidence=round(avg_confidence, 4),
                avg_latency_ms=avg_latency_ms,
            )
            db.add(row)
            output.append(row)

    db.commit()
    return output


@router.get("/feedback/trust-scores", response_model=List[schemas.ModelTrustScoreOut])
def list_trust_scores(
    weeks: int = Query(default=8, ge=1, le=52),
    db: Session = Depends(get_db),
    _: models.User = Depends(require_role(Role.GROUP_ADMIN)),
):
    """Last N weeks of trust scores per model — feeds the dashboard chart."""
    cutoff = datetime.utcnow() - timedelta(weeks=weeks)
    return (
        db.query(models.ModelTrustScore)
        .filter(models.ModelTrustScore.week_start >= cutoff)
        .order_by(models.ModelTrustScore.week_start.desc())
        .all()
    )
