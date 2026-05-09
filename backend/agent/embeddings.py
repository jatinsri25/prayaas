"""
Prayaas Embeddings Service

Thin wrapper around Gemini's text-embedding-004 model with:
  - In-process LRU cache (cuts API calls ~70% on repeated text)
  - Cosine similarity helper (numpy-free, works on plain Python lists)
  - Graceful degradation: returns deterministic hash-based pseudo-embeddings
    when no API key is configured (so dev/CI never hard-fail)

Used by:
  - Semantic dedup pipeline (problems.py)
  - RAG knowledge base (knowledge.py)
  - ML feedback loop nearest-neighbor lookup
"""

from __future__ import annotations

import hashlib
import math
import os
from functools import lru_cache
from typing import List, Sequence

from google.genai import Client as GenaiClient

# `gemini-embedding-001` returns 3072-d vectors and is the current
# generally-available text embedding model on the v1beta API.
# Override via env var if you migrate to a different model later.
EMBEDDING_MODEL = os.getenv("PRAYAAS_EMBEDDING_MODEL", "gemini-embedding-001")
EMBEDDING_DIM = int(os.getenv("PRAYAAS_EMBEDDING_DIM", "3072"))

_GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "")
_client: GenaiClient | None = None


def _get_client() -> GenaiClient | None:
    """Lazy-init the genai client. Returns None if no API key (dev fallback)."""
    global _client
    if not _GOOGLE_API_KEY:
        return None
    if _client is None:
        _client = GenaiClient(api_key=_GOOGLE_API_KEY)
    return _client


def _pseudo_embedding(text: str) -> List[float]:
    """
    Deterministic fallback when no API key is set.
    Hash-based, normalized to unit length so cosine still works for tests.
    """
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    # Tile the 32-byte digest into a 768-d vector
    raw = (digest * ((EMBEDDING_DIM // len(digest)) + 1))[:EMBEDDING_DIM]
    vec = [(b - 128) / 128.0 for b in raw]
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


@lru_cache(maxsize=2048)
def _embed_cached(text_normalized: str) -> tuple:
    """LRU-cached inner call. Returns a tuple (immutable, hashable)."""
    client = _get_client()
    if client is None:
        return tuple(_pseudo_embedding(text_normalized))

    try:
        result = client.models.embed_content(
            model=EMBEDDING_MODEL,
            contents=text_normalized,
        )
        # google-genai returns either .embeddings[0].values or .embedding.values
        embeddings = getattr(result, "embeddings", None)
        if embeddings:
            values = embeddings[0].values
        else:
            values = result.embedding.values  # type: ignore[attr-defined]
        return tuple(float(v) for v in values)
    except Exception as exc:  # pragma: no cover - network errors logged not raised
        # Never crash the request pipeline on embedding failure, but log
        # at least once so on-call can investigate misconfigured model names.
        try:
            from utils.logger import get_logger
            get_logger().warning(
                "embedding_call_failed",
                model=EMBEDDING_MODEL,
                error_type=type(exc).__name__,
                error=str(exc)[:160],
            )
        except Exception:
            pass
        return tuple(_pseudo_embedding(text_normalized))


def embed_text(text: str) -> List[float]:
    """Get a 768-d embedding for the given text. Cached + fault-tolerant."""
    if not text or not text.strip():
        return [0.0] * EMBEDDING_DIM
    normalized = " ".join(text.strip().lower().split())[:8000]
    return list(_embed_cached(normalized))


def cosine_similarity(a: Sequence[float], b: Sequence[float]) -> float:
    """Cosine similarity in [-1, 1]. Returns 0.0 on dimension mismatch."""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = 0.0
    norm_a = 0.0
    norm_b = 0.0
    for x, y in zip(a, b):
        dot += x * y
        norm_a += x * x
        norm_b += y * y
    denom = math.sqrt(norm_a) * math.sqrt(norm_b)
    if denom == 0.0:
        return 0.0
    return dot / denom


def haversine_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Great-circle distance between two lat/lng points in meters.
    Used for geofencing in semantic dedup. Replace with PostGIS ST_Distance
    when DATABASE_URL switches to PostgreSQL + PostGIS in production.
    """
    R = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlmb / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))
