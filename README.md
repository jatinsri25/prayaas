# 🏘️ Prayaas — AI-Powered Society Community Platform

> Report, format, and resolve community problems with LangChain agentic AI (Gemini)

## Features

- 🎙️ **Voice-to-Report** — Record audio, Gemini AI transcribes it automatically
- 🎯 **Confidence-Gated AI Pipeline** — Every Gemini call is scored for output confidence; low-confidence calls automatically escalate up the model chain. Live auto-resolution rate dashboard at `/admin`.
- 🔁 **ML Feedback Loop** — Admin corrections to AI fields are logged, retrieved as nearest-neighbor few-shot examples on the next inference, and aggregated into weekly per-model trust scores
- 🗺️ **Semantic Dedup with Geofencing** — Two-stage filter (haversine distance + cosine similarity over `gemini-embedding-001`) blocks duplicate reports before they're filed
- 📖 **RAG over LMC Bylaws** — Ask civic questions and get answers grounded in cited Lucknow Municipal Corporation + U.P. Apartment Act sources at `/knowledge`
- 🤖 **LangChain AI Agent** — Gemini 2.5/2.0 Flash family formats problems + generates 3 prioritised solutions
- 👥 **Society Groups** — Create and join groups for wings/blocks
- 📋 **AI Drafts** — Review and edit AI-formatted reports before posting
- 🗳️ **Upvoting & Status** — Community voting and issue tracking

## Security Features (Production)

- 🔐 **JWT RS256** — Asymmetric token signing with refresh token rotation
- 🛡️ **Argon2id** — GPU-hostile password hashing (migrates from bcrypt transparently)
- 🚫 **Prompt Injection Guard** — 20+ regex patterns block LLM manipulation
- 🔒 **PII Redaction** — Aadhaar, PAN, phone, email stripped before AI processing
- 🔑 **RBAC** — Role-based access control (Resident → Superadmin)
- 🍪 **Secure Tokens** — Access token in memory only, refresh via HttpOnly cookie
- 📝 **Audit Log** — Immutable, checksummed activity log
- 🛡️ **CSRF Protection** — Double-submit cookie pattern
- 📊 **Rate Limiting** — Nginx zones for anon/auth/AI endpoints
- 🏷️ **Input Validation** — Bleach HTML sanitization + Pydantic constraints

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14 + TypeScript |
| Backend | FastAPI (Python) |
| AI | LangChain + Google Gemini 2.0 Flash |
| Database | SQLite (dev) / PostgreSQL 15 (prod) |
| Auth | JWT RS256 + Argon2id + Redis |
| Infrastructure | Docker + Nginx + GitHub Actions |

## Setup & Running

### Prerequisites
- Python 3.10+
- Node.js 18+
- Google Gemini API key ([Get one here](https://aistudio.google.com/apikey))
- Redis (optional for dev — features degrade gracefully)

### 1. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and set your `GOOGLE_API_KEY`:
```env
GOOGLE_API_KEY=your-google-api-key
```

### 2. Start the Backend

```bash
cd backend
source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Backend runs at: http://localhost:8000
API docs at: http://localhost:8000/docs (dev only)

### 3. Start the Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend runs at: http://localhost:3000

### 4. Seed the RAG Knowledge Base (one-time)

```bash
cd backend
source venv/bin/activate
python -m scripts.seed_lmc_docs
```

This populates `knowledge_chunks` with summarized excerpts from the LMC Solid Waste Management Bylaws, U.P. Apartment Act, U.P. Jal Nigam rules, and Lucknow Police society guidelines so the `/knowledge` page can answer civic questions.

### 5. Production (Docker Compose)

```bash
# Fill in production secrets
cp .env.example .env
# Edit .env with production values

docker compose -f docker-compose.prod.yml up -d
```

---

## AI Pipeline

```
User Input (voice/text)
        ↓
  [Gemini Audio]                    ← voice transcription (if audio)
        ↓
  [Injection Guard]                 ← prompt injection detection
        ↓
  [PII Redaction]                   ← Aadhaar, phone, email stripped
        ↓
  [Token Budget]                    ← per-user daily limit check
        ↓
  [Confidence-Gated format_problem]
   ├─ Try gemini-2.5-flash-lite
   ├─ Score JSON validity + schema completeness + uncertainty markers
   └─ If score < 0.78 → escalate to next model in chain
        ↓
  [Severity auto-escalation]        ← distress keywords bump to High/Critical
        ↓
  [Confidence-Gated suggest_solutions]
        ↓
  [AutoResolutionEvent persisted]   ← powers the 94% auto-resolution metric
        ↓
  [Embedding stored on Problem]     ← for future semantic dedup queries
        ↓
  Draft shown to user with confidence badge
        ↓
  [Dedup check]                     ← haversine + cosine similarity
        ↓
  Edit → Post to community
        ↓
  [Admin correction → AICorrection] ← becomes few-shot context next time
```

## Project Structure

```
Prayaas/
├── backend/
│   ├── main.py              # FastAPI app (CORS, CSRF, logging)
│   ├── database.py          # PostgreSQL/SQLite setup
│   ├── models.py            # ORM models (User, Group, Problem, AuditLog)
│   ├── schemas.py           # Pydantic schemas (validated + sanitized)
│   ├── auth.py              # JWT RS256 + refresh tokens + lockout
│   ├── dependencies.py      # RBAC (require_role)
│   ├── metrics.py           # Prometheus metrics
│   ├── routers/
│   │   ├── groups.py        # Groups CRUD (with audit)
│   │   ├── problems.py      # Problems + AI + dedup + correction PATCH
│   │   ├── admin.py         # ML feedback metrics + weekly trust scores
│   │   └── knowledge.py     # RAG ask endpoint with cited sources
│   ├── agent/
│   │   ├── pipeline.py          # Confidence-gated Gemini AI pipeline
│   │   ├── confidence_gate.py   # Auto-escalation + confidence scoring
│   │   ├── embeddings.py        # gemini-embedding-001 wrapper + cosine
│   │   ├── dedup.py             # Geofenced semantic dedup
│   │   ├── guard.py             # Prompt injection detection
│   │   ├── pii.py               # PII redaction engine
│   │   └── token_budget.py      # Per-user AI usage limits
│   ├── scripts/
│   │   └── seed_lmc_docs.py # Seed RAG knowledge base with LMC bylaws
│   ├── middleware/
│   │   ├── lockout.py       # Account lockout (Redis)
│   │   └── csrf.py          # CSRF protection
│   ├── utils/
│   │   ├── password.py      # Argon2id + bcrypt migration
│   │   ├── audit.py         # Immutable audit logging
│   │   ├── field_encrypt.py # PII field encryption
│   │   ├── file_security.py # Audio file validation
│   │   ├── schema_migrate.py # SQLite dev column ALTERs (no Alembic needed)
│   │   └── logger.py        # Structured logging
│   ├── Dockerfile           # Production container
│   └── requirements.txt
├── frontend/
│   ├── app/
│   │   ├── admin/           # AI Ops dashboard (auto-resolution rate, trust scores)
│   │   ├── knowledge/       # RAG "Ask the rulebook" interface
│   │   ├── problems/        # Report intake + detail (with inline AI corrections)
│   │   └── ...              # other Next.js pages
│   ├── lib/
│   │   ├── api.ts           # Secure API client (CSRF, token refresh, admin/knowledge)
│   │   └── auth.ts          # In-memory token management
│   ├── next.config.js       # Security headers (CSP, HSTS, etc.)
│   └── Dockerfile           # Production container
├── nginx/nginx.conf         # Rate limiting + TLS + reverse proxy
├── docker-compose.prod.yml  # Production stack
├── .github/workflows/       # CI/CD security pipeline
├── .pre-commit-config.yaml  # SAST + secrets detection
├── .env.example             # Environment template
└── README.md
```
