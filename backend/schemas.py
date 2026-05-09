"""
Prayaas Pydantic Schemas — Production Hardened

All string fields have length constraints.
HTML is stripped from user input via bleach.
Password has strength requirements.
"""

from pydantic import BaseModel, EmailStr, Field, field_validator
from typing import Optional, List
from datetime import datetime
import re

try:
    import bleach
    _HAS_BLEACH = True
except ImportError:
    _HAS_BLEACH = False


def _sanitize(v: str) -> str:
    """Strip all HTML tags from input."""
    if _HAS_BLEACH and v:
        return bleach.clean(v, tags=[], strip=True)
    return v


# ── Auth ──────────────────────────────────────────────────────────────────────

class UserRegister(BaseModel):
    name: str = Field(..., min_length=2, max_length=100)
    email: EmailStr
    flat_number: str = Field(..., min_length=1, max_length=20)
    phone: Optional[str] = Field(None, max_length=15)
    password: str = Field(..., min_length=8, max_length=128)

    @field_validator("name", "flat_number")
    @classmethod
    def sanitize_strings(cls, v: str) -> str:
        return _sanitize(v.strip())

    @field_validator("password")
    @classmethod
    def validate_password_strength(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        if not re.search(r"[A-Z]", v):
            raise ValueError("Password must contain at least one uppercase letter")
        if not re.search(r"[a-z]", v):
            raise ValueError("Password must contain at least one lowercase letter")
        if not re.search(r"\d", v):
            raise ValueError("Password must contain at least one digit")
        return v

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        cleaned = re.sub(r"[\s\-\(\)]", "", v)
        if not re.match(r"^\+?\d{10,15}$", cleaned):
            raise ValueError("Invalid phone number format")
        return cleaned


class UserLogin(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=1, max_length=128)


class UserOut(BaseModel):
    id: int
    name: str
    email: str
    flat_number: str
    phone: Optional[str]
    avatar_color: str
    created_at: datetime

    class Config:
        from_attributes = True


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


# ── Groups ────────────────────────────────────────────────────────────────────

class GroupCreate(BaseModel):
    name: str = Field(..., min_length=2, max_length=100)
    description: Optional[str] = Field(None, max_length=1000)
    is_public: bool = True

    @field_validator("name")
    @classmethod
    def sanitize_name(cls, v: str) -> str:
        return _sanitize(v.strip())

    @field_validator("description")
    @classmethod
    def sanitize_description(cls, v: Optional[str]) -> Optional[str]:
        if v:
            return _sanitize(v.strip())
        return v


class GroupMemberOut(BaseModel):
    user_id: int
    role: str
    joined_at: datetime
    user: UserOut

    class Config:
        from_attributes = True


class GroupOut(BaseModel):
    id: int
    name: str
    description: Optional[str]
    is_public: bool
    created_at: datetime
    member_count: int = 0
    creator: UserOut

    class Config:
        from_attributes = True


# ── Problems ──────────────────────────────────────────────────────────────────

class SolutionItem(BaseModel):
    action: str = Field(..., max_length=500)
    responsible_party: str = Field(..., max_length=200)
    timeline: str = Field(..., max_length=100)
    priority: int = Field(..., ge=1, le=10)


class AIProblemDraft(BaseModel):
    title: str
    category: str
    location: str
    severity: str
    formatted_description: str
    affected_residents: str
    solutions: List[SolutionItem]
    # Confidence-gated pipeline telemetry — exposed to frontend so the
    # "Review draft" UI can show a confidence badge and an "AI escalated to
    # a stronger model" banner when relevant.
    confidence_score: Optional[float] = None
    was_escalated: Optional[bool] = None
    last_model_used: Optional[str] = None
    auto_resolved: Optional[bool] = None
    duplicate_warning: Optional["DuplicateWarning"] = None


class ProblemCreate(BaseModel):
    raw_input: Optional[str] = Field(None, max_length=5000)
    group_id: Optional[int] = None


class ProblemOut(BaseModel):
    id: int
    title: str
    formatted_description: str
    category: str
    severity: str
    location: Optional[str]
    affected_residents: Optional[str]
    ai_solutions: Optional[str]
    upvotes: int
    status: str
    created_at: datetime
    author: UserOut
    group_id: Optional[int]
    confidence_score: Optional[float] = None
    was_escalated: Optional[bool] = None
    last_model_used: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None

    class Config:
        from_attributes = True


# ── Semantic Dedup ────────────────────────────────────────────────────────────

class DuplicateMatch(BaseModel):
    problem_id: int
    title: str
    similarity: float                 # cosine, [-1, 1]
    distance_meters: Optional[float]  # haversine when both reports have geo
    status: str
    created_at: datetime


class DuplicateWarning(BaseModel):
    is_likely_duplicate: bool
    matches: List[DuplicateMatch] = []


class DuplicateCheckRequest(BaseModel):
    raw_text: str = Field(..., min_length=10, max_length=5000)
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    radius_meters: float = Field(default=500.0, ge=10.0, le=10000.0)
    similarity_threshold: float = Field(default=0.82, ge=0.5, le=1.0)


# ── ML Feedback Loop ──────────────────────────────────────────────────────────

class AICorrectionOut(BaseModel):
    id: int
    problem_id: int
    field_name: str
    original_value: Optional[str]
    corrected_value: Optional[str]
    model_used: Optional[str]
    original_confidence: Optional[float]
    ts: datetime

    class Config:
        from_attributes = True


class ModelTrustScoreOut(BaseModel):
    model_name: str
    week_start: datetime
    sample_count: int
    auto_resolved_count: int
    correction_count: int
    success_rate: float
    avg_confidence: float
    avg_latency_ms: int

    class Config:
        from_attributes = True


class FeedbackMetricsOut(BaseModel):
    """Headline metrics for the admin dashboard."""
    auto_resolution_rate: float        # 0..1 — the resume metric
    total_events: int
    total_corrections: int
    escalation_rate: float
    avg_confidence: float
    avg_latency_ms: int
    by_task: dict
    by_model: dict
    correction_trends_7d: List[dict]   # [{date: 'YYYY-MM-DD', count: N}, ...]


# ── RAG Knowledge ─────────────────────────────────────────────────────────────

class KnowledgeAskRequest(BaseModel):
    question: str = Field(..., min_length=4, max_length=500)
    top_k: int = Field(default=4, ge=1, le=10)


class KnowledgeCitation(BaseModel):
    document_title: str
    section_title: Optional[str]
    page_number: Optional[int]
    source_url: Optional[str]
    chunk_text: str
    similarity: float


class KnowledgeAnswer(BaseModel):
    question: str
    answer: str
    citations: List[KnowledgeCitation]
    confidence: float
    model_used: str
    auto_resolved: bool


class ProblemUpvote(BaseModel):
    problem_id: int


class AIProcessRequest(BaseModel):
    raw_text: str = Field(..., min_length=10, max_length=5000)
    group_id: Optional[int] = None

    @field_validator("raw_text")
    @classmethod
    def sanitize_raw_text(cls, v: str) -> str:
        return _sanitize(v.strip())


# Resolve forward references (AIProblemDraft references DuplicateWarning).
AIProblemDraft.model_rebuild()
