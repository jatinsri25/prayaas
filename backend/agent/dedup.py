"""
Prayaas Semantic Dedup with Geofencing

Two-stage filter that prevents the platform from being flooded with
duplicate complaints about the same physical issue:

  Stage 1 — Geofence:
    Filter candidate problems to those within `radius_meters` of the
    new report's lat/lng (uses haversine here; PostGIS ST_DWithin in prod).

  Stage 2 — Semantic similarity:
    For each candidate, compute cosine similarity between its stored
    embedding (text-embedding-004, 768-d) and the new report's embedding.
    Keep those above `similarity_threshold` (default 0.82, tuned to
    catch "no water in block B" + "Block B has zero water supply" but
    NOT "lift broken on 4th floor" + "lift broken in tower C").

Returns the top-k matches, ranked by similarity. Frontend uses this to
warn the user before they post a duplicate.
"""

from __future__ import annotations

import json
from typing import List, Optional

from sqlalchemy.orm import Session

import models
from agent.embeddings import embed_text, cosine_similarity, haversine_meters

# How fresh a candidate must be to count as a duplicate. Older "Resolved"
# tickets shouldn't trigger a dedup warning for new reports.
DEFAULT_LOOKBACK_DAYS = 30
DEFAULT_RADIUS_M = 500.0
DEFAULT_SIM_THRESHOLD = 0.82
DEFAULT_TOP_K = 5


def find_duplicates(
    db: Session,
    *,
    raw_text: str,
    latitude: Optional[float] = None,
    longitude: Optional[float] = None,
    radius_meters: float = DEFAULT_RADIUS_M,
    similarity_threshold: float = DEFAULT_SIM_THRESHOLD,
    top_k: int = DEFAULT_TOP_K,
    exclude_problem_id: Optional[int] = None,
) -> List[dict]:
    """
    Returns up to `top_k` duplicate candidates as plain dicts ready to
    serialize as DuplicateMatch.

    Geofencing is OPTIONAL — if no lat/lng provided we skip Stage 1 and
    rely entirely on semantic similarity (still useful, just less precise).
    """
    query_embedding = embed_text(raw_text)

    candidates_query = db.query(models.Problem).filter(
        models.Problem.embedding_json.isnot(None),
        models.Problem.status.in_(["Open", "In Progress"]),
    )
    if exclude_problem_id is not None:
        candidates_query = candidates_query.filter(models.Problem.id != exclude_problem_id)

    # Pull a generous window then filter in Python (works on SQLite).
    # In PostgreSQL + pgvector this becomes:
    #   ORDER BY embedding <=> :query_emb LIMIT 50
    candidates = candidates_query.order_by(models.Problem.created_at.desc()).limit(200).all()

    matches: List[dict] = []
    for candidate in candidates:
        # Stage 1: geofence (if both sides have geo)
        distance: Optional[float] = None
        if (
            latitude is not None
            and longitude is not None
            and candidate.latitude is not None
            and candidate.longitude is not None
        ):
            distance = haversine_meters(
                latitude, longitude,
                candidate.latitude, candidate.longitude,
            )
            if distance > radius_meters:
                continue  # outside geofence — not a duplicate

        # Stage 2: semantic similarity
        try:
            candidate_emb = json.loads(candidate.embedding_json or "[]")
        except json.JSONDecodeError:
            continue

        similarity = cosine_similarity(query_embedding, candidate_emb)
        if similarity < similarity_threshold:
            continue

        matches.append({
            "problem_id": candidate.id,
            "title": candidate.title,
            "similarity": round(float(similarity), 4),
            "distance_meters": round(distance, 1) if distance is not None else None,
            "status": candidate.status,
            "created_at": candidate.created_at,
        })

    matches.sort(key=lambda m: m["similarity"], reverse=True)
    return matches[:top_k]
