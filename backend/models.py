"""
Prayaas ORM Models — Production

Changes from dev version:
  - Added `role` field to User (RBAC)
  - Added AuditLog model (immutable)
  - Added Upvote model (proper many-to-many, prevents double-voting)

AI / ML extensions:
  - Problem: latitude, longitude, embedding_json, confidence_score,
             was_escalated, last_model_used (powers semantic dedup +
             confidence-gated pipeline metrics)
  - AICorrection: every admin edit to an AI field becomes a row, feeding
                  the weekly ML trust score + nearest-neighbor few-shot store
  - AutoResolutionEvent: one row per LLM call, drives the
                        "94% auto-resolution" dashboard metric
  - ModelTrustScore: weekly aggregate per model (success rate, sample size)
  - KnowledgeChunk: RAG over municipal bylaws / public docs
"""

from sqlalchemy import (
    Column,
    Integer,
    Float,
    String,
    DateTime,
    ForeignKey,
    Text,
    Boolean,
    UniqueConstraint,
    Index,
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
import enum
from database import Base


class SeverityEnum(str, enum.Enum):
    low = "Low"
    medium = "Medium"
    high = "High"
    critical = "Critical"


class CategoryEnum(str, enum.Enum):
    infrastructure = "Infrastructure"
    safety = "Safety"
    sanitation = "Sanitation"
    noise = "Noise"
    maintenance = "Maintenance"
    security = "Security"
    utilities = "Utilities"
    other = "Other"


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(200), nullable=False)
    email = Column(String(320), unique=True, index=True, nullable=False)
    flat_number = Column(String(50), nullable=False)
    phone = Column(String(20), nullable=True)
    hashed_password = Column(Text, nullable=False)
    avatar_color = Column(String(10), default="#6366f1")
    role = Column(String(20), default="resident")   # resident | group_admin | society_admin | superadmin
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    group_memberships = relationship("GroupMember", back_populates="user")
    problems = relationship("Problem", back_populates="author")


class Group(Base):
    __tablename__ = "groups"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(200), nullable=False)
    description = Column(Text, nullable=True)
    created_by = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    is_public = Column(Boolean, default=True)

    creator = relationship("User", foreign_keys=[created_by])
    members = relationship("GroupMember", back_populates="group")
    problems = relationship("Problem", back_populates="group")


class GroupMember(Base):
    __tablename__ = "group_members"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    group_id = Column(Integer, ForeignKey("groups.id"))
    role = Column(String(20), default="member")  # admin | member
    joined_at = Column(DateTime(timezone=True), server_default=func.now())

    user = relationship("User", back_populates="group_memberships")
    group = relationship("Group", back_populates="members")


class Problem(Base):
    __tablename__ = "problems"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(200), nullable=False)
    raw_input = Column(Text, nullable=True)
    formatted_description = Column(Text, nullable=False)
    category = Column(String(50), default="Other")
    severity = Column(String(20), default="Medium")
    location = Column(String(200), nullable=True)
    affected_residents = Column(String(500), nullable=True)
    ai_solutions = Column(Text, nullable=True)    # JSON string
    audio_file = Column(String(500), nullable=True)
    author_id = Column(Integer, ForeignKey("users.id"))
    group_id = Column(Integer, ForeignKey("groups.id"), nullable=True)
    upvotes = Column(Integer, default=0)
    status = Column(String(30), default="Open")   # Open | In Progress | Resolved
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # ── Geospatial (semantic dedup with geofencing) ───────────────────────────
    # Stored as plain floats for SQLite compatibility. In production with
    # PostGIS, replace with `geometry(Point, 4326)` and ST_DWithin queries.
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)

    # ── Vector embedding (semantic dedup + nearest-neighbor) ──────────────────
    # Stored as a JSON-serialized list[float] of length 768 (text-embedding-004).
    # In production with pgvector, swap for `Vector(768)` + IVFFlat index.
    embedding_json = Column(Text, nullable=True)

    # ── Confidence-gated pipeline telemetry ───────────────────────────────────
    confidence_score = Column(Float, nullable=True)        # [0, 1] from gate
    was_escalated = Column(Boolean, default=False)         # > 0 escalations?
    last_model_used = Column(String(80), nullable=True)    # e.g. gemini-2.0-flash

    author = relationship("User", back_populates="problems")
    group = relationship("Group", back_populates="problems")


class Upvote(Base):
    """Proper upvote tracking — prevents double-voting."""
    __tablename__ = "upvotes"
    __table_args__ = (
        UniqueConstraint("user_id", "problem_id", name="uq_user_problem_upvote"),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    problem_id = Column(Integer, ForeignKey("problems.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class AuditLog(Base):
    """
    Immutable audit log — records all significant user/system actions.

    In PostgreSQL, protect with:
      CREATE RULE no_update_audit AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
      CREATE RULE no_delete_audit AS ON DELETE TO audit_log DO INSTEAD NOTHING;
    """
    __tablename__ = "audit_log"

    id = Column(Integer, primary_key=True, index=True)
    ts = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    action = Column(String(100), nullable=False)     # LOGIN, REGISTER, POST_PROBLEM, AI_CALL, etc.
    resource = Column(String(200), nullable=True)     # e.g., "problem:42"
    ip_address = Column(String(45), nullable=True)
    meta = Column(Text, nullable=True)                # JSON for extra context
    checksum = Column(String(64), nullable=False)     # SHA-256 of row content


# ═══════════════════════════════════════════════════════════════════════════════
# ML FEEDBACK LOOP — admin corrections + auto-resolution telemetry
# ═══════════════════════════════════════════════════════════════════════════════

class AICorrection(Base):
    """
    Logs every human edit to an AI-generated field.

    The collected corpus drives:
      - Weekly model trust score (success_rate per model_used)
      - Nearest-neighbor few-shot prompting (find similar past problems
        and inject their corrections as in-context examples)
      - The "system gets smarter every week from real human corrections"
        narrative on the admin dashboard.

    Indexed by (field_name, ts) so the dashboard can compute trends fast.
    """
    __tablename__ = "ai_corrections"
    __table_args__ = (
        Index("ix_ai_corrections_field_ts", "field_name", "ts"),
        Index("ix_ai_corrections_problem", "problem_id"),
    )

    id = Column(Integer, primary_key=True, index=True)
    problem_id = Column(Integer, ForeignKey("problems.id"), nullable=False)
    admin_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    field_name = Column(String(50), nullable=False)        # title|category|severity|description|location
    original_value = Column(Text, nullable=True)           # what AI produced
    corrected_value = Column(Text, nullable=True)          # what admin wrote
    model_used = Column(String(80), nullable=True)         # snapshot of last_model_used
    original_confidence = Column(Float, nullable=True)     # gate confidence at draft time
    embedding_json = Column(Text, nullable=True)           # embedding of original problem text
                                                            # (enables nearest-neighbor lookup)
    ts = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class AutoResolutionEvent(Base):
    """
    One row per LLM call routed through `confidence_gate.gated_call`.

    Powers the resume metric:
        auto_resolution_rate = SUM(auto_resolved) / COUNT(*)

    Also tracks:
      - escalations    : how often we had to climb the model chain
      - elapsed_ms     : end-to-end latency per call
      - had_errors     : transient API failures we recovered from
    """
    __tablename__ = "auto_resolution_events"
    __table_args__ = (
        Index("ix_auto_res_task_ts", "task_type", "ts"),
        Index("ix_auto_res_model", "model_used"),
    )

    id = Column(Integer, primary_key=True, index=True)
    ts = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    task_type = Column(String(50), nullable=False)          # format_problem|suggest_solutions|rag_answer
    model_used = Column(String(80), nullable=False)
    confidence = Column(Float, nullable=False)
    escalations = Column(Integer, default=0)                # 0 = no escalation needed
    auto_resolved = Column(Boolean, default=False)
    elapsed_ms = Column(Integer, default=0)
    had_errors = Column(Boolean, default=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    problem_id = Column(Integer, ForeignKey("problems.id"), nullable=True)


class ModelTrustScore(Base):
    """
    Rolling weekly scoreboard per model.

    Refreshed by the admin endpoint /api/admin/feedback/recompute (or a
    Celery beat job in production). Lets the team retire underperforming
    models from the chain when their success rate falls below a threshold.
    """
    __tablename__ = "model_trust_scores"
    __table_args__ = (
        UniqueConstraint("model_name", "week_start", name="uq_model_week"),
    )

    id = Column(Integer, primary_key=True, index=True)
    model_name = Column(String(80), nullable=False)
    week_start = Column(DateTime(timezone=True), nullable=False)
    sample_count = Column(Integer, default=0)
    auto_resolved_count = Column(Integer, default=0)
    correction_count = Column(Integer, default=0)
    success_rate = Column(Float, default=0.0)               # 1 - (corrections / samples)
    avg_confidence = Column(Float, default=0.0)
    avg_latency_ms = Column(Integer, default=0)
    computed_at = Column(DateTime(timezone=True), server_default=func.now())


# ═══════════════════════════════════════════════════════════════════════════════
# RAG OVER GOVERNMENT DOCUMENTS — Lucknow Municipal Corporation bylaws
# ═══════════════════════════════════════════════════════════════════════════════

class KnowledgeChunk(Base):
    """
    A retrievable text chunk from a public municipal document.

    Used by the RAG endpoint to answer "Who is responsible for X?" with
    a cited source. Chunks are embedded with text-embedding-004 (768-d)
    and ranked by cosine similarity at query time.

    In production with pgvector this becomes a `Vector(768)` column with
    an IVFFlat index for sub-100ms retrieval over millions of chunks.
    """
    __tablename__ = "knowledge_chunks"
    __table_args__ = (
        Index("ix_knowledge_doc", "document_title"),
    )

    id = Column(Integer, primary_key=True, index=True)
    document_title = Column(String(300), nullable=False)
    source_url = Column(String(500), nullable=True)
    section_title = Column(String(300), nullable=True)
    page_number = Column(Integer, nullable=True)
    chunk_text = Column(Text, nullable=False)
    embedding_json = Column(Text, nullable=False)     # JSON-encoded list[float]
    created_at = Column(DateTime(timezone=True), server_default=func.now())
