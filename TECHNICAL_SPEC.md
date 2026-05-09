# Prayaas Technical Specification

This document outlines the architecture, technology stack, and security measures implemented in the Prayaas platform.

## 1. System Architecture

Prayaas uses a modern, decoupled client-server architecture with a clear separation of concerns.

- **Frontend Client**: A Next.js application that handles UI rendering, state management, and user interactions.
- **Backend API**: A FastAPI application providing secure RESTful endpoints, database interaction, and AI orchestration.
- **AI Layer**: An integrated AI pipeline powered by Google's Gemini models for intelligent problem parsing and formatting.

## 2. Technology Stack

### Frontend (Client)
- **Framework**: Next.js (React)
- **Styling**: Global CSS and modular styling with a focus on modern aesthetics (glassmorphism, parallax scrolling, responsive layouts).
- **HTTP Client**: Axios with interceptors for automatic token refresh and CSRF protection.
- **State Management**: React Hooks (useState, useEffect, useRef).

### Backend (Server)
- **Framework**: FastAPI (Python 3.9+)
- **Server**: Uvicorn (ASGI)
- **Database ORM**: SQLAlchemy
- **Data Validation**: Pydantic
- **Database Engine**: SQLite (Development) / PostgreSQL (Ready for Production)
- **Caching & Rate Limiting**: Redis (Optional but recommended for production token budgeting)

### AI & Machine Learning
- **SDK**: `google-genai` (REST-based SDK, bypassing previous gRPC DNS issues on macOS)
- **Orchestration**: Custom pipeline wrapper using LangChain concepts.
- **Models**: 
  - `gemini-2.5-flash-lite` (Primary)
  - `gemini-2.0-flash-lite` (Fallback 1)
  - `gemini-2.0-flash` (Fallback 2)

## 3. The AI Pipeline (`backend/agent/pipeline.py`)

The AI pipeline is a critical component for processing unstructured resident reports (text or voice) into structured, actionable data. It features a robust, multi-step workflow:

1. **Input Reception**: Accepts raw text or audio blobs (webm, mp3, wav, etc.).
2. **Audio Transcription**: Uses Gemini's multimodal capabilities to natively transcribe audio via base64 inline data. Prompts are heavily optimized to understand Hindi, Hinglish, and regional languages and output professional English.
3. **Security Check (Injection Guard)**: Scans input for prompt injection attempts.
4. **PII Redaction**: Identifies and redacts Personally Identifiable Information before sending data to the LLM.
5. **Token Budgeting**: Verifies the user has enough daily AI quota to process the request.
6. **Confidence-Gated LLM Processing (Formatting)**: Structures the raw problem into JSON (Title, Category, Severity, Location, Description) via `confidence_gate.gated_call`.
7. **Confidence-Gated LLM Processing (Solutions)**: Generates 3 actionable solutions with responsible parties, timelines, and priority levels.
8. **Telemetry Persistence**: Each gated call emits an `AutoResolutionEvent` row used to compute the auto-resolution rate, model fallback frequency, and per-task confidence distribution.
9. **Token Deduction**: Deducts the used tokens from the user's daily budget.

### 3.1 Confidence-Gated Model Escalation (`backend/agent/confidence_gate.py`)

Every Gemini call routes through `gated_call(...)`, which:

1. Tries the cheapest model in `MODEL_CHAIN` (`gemini-2.5-flash-lite`).
2. Scores the output's confidence on a `[0, 1]` scale combining JSON validity, schema completeness, length sanity, and self-reported uncertainty markers.
3. If confidence is below `PRAYAAS_AUTO_RESOLVE_THRESHOLD` (default `0.78`), the call is automatically escalated to the next stronger model in the chain. If the chain is exhausted without crossing the threshold, the response is still returned but flagged `auto_resolved=False` for human review.
4. Persists an `AutoResolutionEvent` row with `model_used`, `confidence`, `escalations`, `auto_resolved`, and `elapsed_ms`. The headline `auto_resolution_rate` metric on the admin dashboard is `SUM(auto_resolved) / COUNT(*)` over a rolling window.

### 3.2 ML Feedback Loop (`backend/routers/admin.py`, `backend/routers/problems.py`)

When admins or authors edit AI-generated fields (`title`, `category`, `severity`, `location`, `formatted_description`, `affected_residents`), the `PATCH /api/problems/{id}/ai-fields` endpoint logs every change as an `AICorrection` row including `original_value`, `corrected_value`, the `model_used` at draft time, and the original input's embedding.

These corrections drive two feedback mechanisms:

- **Few-shot prompting at inference time**: `pipeline._retrieve_similar_corrections()` performs a nearest-neighbor lookup against past corrections (cosine similarity on text-embedding-001 vectors) and injects up to 2 in-context examples into the next `format_problem` prompt.
- **Weekly Model Trust Scores**: `/api/admin/feedback/recompute` aggregates the week's events and corrections per model into a `ModelTrustScore` row (`success_rate = 1 - corrections/samples`). When a model's trust score falls below an operational threshold, it can be retired from `MODEL_CHAIN`.

### 3.3 Semantic Dedup with Geofencing (`backend/agent/dedup.py`)

`POST /api/problems/check-duplicate` runs a two-stage filter:

- **Stage 1 — Geofence**: Haversine distance against `latitude`/`longitude` columns on `problems`. Candidates outside `radius_meters` (default 500 m) are dropped. In production with PostGIS, this becomes `ST_DWithin(geom, ST_MakePoint(lng, lat), radius)`.
- **Stage 2 — Semantic similarity**: Cosine similarity between the new report's `gemini-embedding-001` vector and stored `embedding_json` of every candidate. Threshold default `0.82` (tuned empirically — paraphrases score ~0.95, unrelated reports score ~0.6).

The frontend calls this both on `process_with_ai` (warning shown in the AI draft view) and as a standalone check with location coordinates.

### 3.4 RAG over Government Documents (`backend/routers/knowledge.py`)

`POST /api/knowledge/ask` answers civic questions ("who is responsible for X?") with cited sources:

1. Embed the question (`gemini-embedding-001`).
2. Retrieve top-k chunks from `knowledge_chunks` ranked by cosine similarity.
3. Drop chunks below `_MIN_CITATION_SIMILARITY = 0.45` to avoid grounding on irrelevant text.
4. Inject the retrieved chunks into a confidence-gated LLM prompt and return the grounded answer + the citations the LLM was instructed to cite.

The knowledge base is seeded by `python -m scripts.seed_lmc_docs` with summarized excerpts of LMC Solid Waste Management Bylaws, U.P. Apartment Act, U.P. Jal Nigam rules, and Lucknow Police society security guidelines. In production this becomes a `pgvector(3072)` column with an IVFFlat index for sub-100ms retrieval over millions of chunks.

## 4. Security Implementation

- **Authentication**: JWT-based auth. Access tokens are stored securely in memory (not localStorage), while refresh tokens are stored in `HttpOnly` cookies to prevent XSS attacks.
- **CSRF Protection**: State-changing requests (POST, PUT, DELETE) require a CSRF token.
- **Role-Based Access Control (RBAC)**: Enforced at the API level (e.g., only authors or admins can delete or change the status of a problem).
- **File Validation**: Strict checking of magic bytes and MIME types for uploaded audio files to prevent malicious uploads.
- **Rate Limiting & Quotas**: Token budgeting per user per day prevents API abuse and manages costs.
- **API Fallbacks**: AI pipeline implements automatic retries and model fallbacks on `429` (Quota Exhausted) and `503` (Service Unavailable) errors, preventing infinite UI hangs. API calls time out safely after 120 seconds.

## 5. Deployment & Infrastructure

- **Containerization**: The platform is fully dockerized with a `docker-compose.prod.yml` configuration.
- **Environment Management**: Strict `.env` isolation. Required variables include `GOOGLE_API_KEY`, `DATABASE_URL`, `REDIS_URL`, and `ENVIRONMENT`.
- **CORS**: Strictly defined origins to prevent unauthorized cross-origin requests.

## 6. Known Edge Cases Resolved

- **macOS gRPC DNS Issues**: The legacy `google.generativeai` SDK experienced DNS resolution failures (`503 Service Unavailable`) on macOS. This was permanently resolved by migrating to the `google.genai` REST-based SDK.
- **Google API Quota Exhaustion**: Implemented a resilient fallback chain (`gemini-2.5-flash-lite` -> `gemini-2.0-flash-lite`) to bypass `0` free-tier quota limits on newer models.
- **Double Voting**: Prevented via database constraints (`Upvote` model mapped to `user_id` and `problem_id`).

---

## 7. Feature Roadmap

### 7.1 AI & Intelligence Layer

| Feature | Description | Status |
|---|---|---|
| **Confidence-Gated Pipeline** | Every Gemini call routes through `confidence_gate.gated_call`, which scores output confidence and escalates to a stronger model when below threshold. Drives the headline auto-resolution metric. | **Built** |
| **ML Feedback Loop** | Admin corrections to AI fields are logged to `ai_corrections`, surfaced as nearest-neighbor few-shot examples on the next inference, and aggregated into weekly `ModelTrustScore` rows. | **Built** |
| **Semantic Dedup + Geofencing** | Two-stage filter (haversine + cosine similarity over `gemini-embedding-001`) on `POST /api/problems/check-duplicate`. | **Built** |
| **RAG over LMC Documents** | `POST /api/knowledge/ask` retrieves top-k chunks from `knowledge_chunks` and grounds the answer with cited sources. | **Built** |
| **Sentiment & Urgency Escalation** | Auto-bump severity if AI detects distress language ("child injured", "no water for 3 days"). Overrides user-selected severity. | **Built** |
| **Voice Language Auto-Detect** | Log the detected language per submission to build a heatmap of regional linguistic clusters. Gemini already handles Hindi/Hinglish. | Planned |
| **AI-Generated Status Updates** | When an admin changes problem status, auto-draft a citizen-facing progress note using the stored solution plan. | Planned |

### 7.2 Backend & Data

| Feature | Description | Status |
|---|---|---|
| **Geospatial Indexing** | Add latitude + longitude columns with PostGIS (or SpatiaLite for dev). Enables radius queries: "all open problems within 500m." | Planned |
| **Problem Clustering** | Background job (Celery + Redis) that groups nearby, same-category problems into a single "cluster ticket" for municipal departments. | Planned |
| **Webhook System** | Let departments register a webhook URL; Prayaas POSTs a JSON payload whenever a problem is assigned to them. | Planned |
| **Audit Trail Table** | Every status change, reassignment, or edit logged with `actor_id`, timestamp, and diff. Critical for accountability. | Planned |

### 7.3 Security & Compliance

| Feature | Description | Status |
|---|---|---|
| **Field-Level Encryption** | AES-256 encryption at rest for original audio/text, even after PII redaction. Required for government data agreements. | Planned |
| **2FA via TOTP** | `pyotp` for admin accounts. Citizen accounts stay password-only. | Planned |
| **Anomaly Detection** | Flag accounts submitting >N problems/hour from the same IP or device fingerprint as potential spam. | Planned |

### 7.4 Frontend & UX

| Feature | Description | Status |
|---|---|---|
| **Offline-First PWA** | Service worker queues submissions when offline (critical for low-bandwidth areas). Syncs automatically on reconnect. | Planned |
| **Live Map View** | Leaflet.js or Mapbox GL overlaid with problem pins, color-coded by severity. Filter by category, status, date range. | Planned |
| **Real-Time Status Push** | WebSocket or SSE channel per problem ID. Citizens get in-app notifications on status changes — no polling. | Planned |
| **Accessibility (a11y)** | WCAG 2.1 AA compliance: screen reader labels, keyboard navigation, high-contrast mode toggle. | Planned |

### 7.5 Observability

| Feature | Description | Status |
|---|---|---|
| **Structured Logging** | Replace print statements with `structlog` outputting JSON. Ship to Loki or CloudWatch. | Planned |
| **AI Cost Dashboard** | `/admin/ai-costs` endpoint showing tokens consumed per day per model, per user cohort. | Planned |
| **Health Check Endpoints** | `/health/db`, `/health/redis`, `/health/ai` returning dependency status for Docker healthchecks. | Planned |

### 7.6 Phased Build Order

**Phase 1 — Trust & Reliability:**
1. Audit Trail → Geospatial Columns → Duplicate Detection → Health Checks

**Phase 2 — User Engagement:**
2. Live Map → Real-Time Status Push → PWA Offline Mode

**Phase 3 — Scale & Ops:**
3. Problem Clustering → Webhook System → AI Cost Dashboard → Field Encryption
