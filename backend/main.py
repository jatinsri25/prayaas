"""
Prayaas FastAPI Application — Production Hardened

Security features:
  - Tightened CORS (configurable whitelist)
  - CSRF middleware (production only)
  - /docs and /redoc blocked in production
  - Structured logging middleware
  - Prometheus metrics endpoint
  - Health check endpoint
"""

import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse
from dotenv import load_dotenv
import time

load_dotenv()

ENVIRONMENT = os.getenv("ENVIRONMENT", "development")

from database import engine, Base
import models
from utils.schema_migrate import ensure_dev_columns

# Create all tables
Base.metadata.create_all(bind=engine)

# Add any new columns that were shipped after the SQLite DB was created.
# (No-op in production — use Alembic migrations there.)
_added_columns = ensure_dev_columns(engine)

from auth import router as auth_router
from routers.groups import router as groups_router
from routers.problems import router as problems_router
from routers.admin import router as admin_router
from routers.knowledge import router as knowledge_router
from middleware.csrf import CSRFMiddleware
from utils.logger import get_logger
from metrics import get_metrics_response, http_requests_total

log = get_logger()

# ── App Configuration ─────────────────────────────────────────────────────────

# Block docs in production
_docs_url = "/docs" if ENVIRONMENT == "development" else None
_redoc_url = "/redoc" if ENVIRONMENT == "development" else None
_openapi_url = "/openapi.json" if ENVIRONMENT == "development" else None

app = FastAPI(
    title="Prayaas API",
    description="AI-powered community problem reporting platform for residential societies",
    version="2.0.0",
    docs_url=_docs_url,
    redoc_url=_redoc_url,
    openapi_url=_openapi_url,
)


# ── CORS ──────────────────────────────────────────────────────────────────────

_cors_origins = os.getenv("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")
ALLOWED_ORIGINS = [origin.strip() for origin in _cors_origins.split(",") if origin.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-CSRF-Token"],
    expose_headers=["X-Request-ID"],
)


# ── CSRF Middleware ───────────────────────────────────────────────────────────

app.add_middleware(CSRFMiddleware)


# ── Request Logging Middleware ────────────────────────────────────────────────

class RequestLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        start = time.time()

        # Skip logging for health/metrics endpoints
        if request.url.path in ("/health", "/metrics"):
            return await call_next(request)

        response = await call_next(request)
        duration = time.time() - start

        # Prometheus metric
        try:
            http_requests_total.labels(
                method=request.method,
                path=request.url.path,
                status=str(response.status_code),
            ).inc()
        except Exception:
            pass

        # Structured log
        if duration > 2.0 or response.status_code >= 400:
            log.info(
                "http_request",
                method=request.method,
                path=request.url.path,
                status=response.status_code,
                duration_ms=round(duration * 1000, 2),
                client_ip=request.client.host if request.client else "unknown",
            )

        return response


app.add_middleware(RequestLoggingMiddleware)


# ── Block docs in production (belt-and-suspenders) ────────────────────────────

if ENVIRONMENT != "development":
    @app.middleware("http")
    async def block_docs(request: Request, call_next):
        if request.url.path in ("/docs", "/redoc", "/openapi.json"):
            return JSONResponse(status_code=404, content={"detail": "Not found"})
        return await call_next(request)


# ── Static file serving for audio uploads ─────────────────────────────────────

os.makedirs("uploads", exist_ok=True)
app.mount("/uploads", StaticFiles(directory="uploads"), name="uploads")


# ── Routers ───────────────────────────────────────────────────────────────────

app.include_router(auth_router)
app.include_router(groups_router)
app.include_router(problems_router)
app.include_router(admin_router)
app.include_router(knowledge_router)


# ── Root & Health ─────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return {
        "app": "Prayaas",
        "version": "2.0.0",
        "status": "running",
        "environment": ENVIRONMENT,
        "message": "AI-powered society community platform",
    }


@app.get("/health")
def health():
    return {"status": "healthy", "version": "2.0.0"}


@app.get("/metrics")
def metrics():
    """Prometheus metrics endpoint (block in production via Nginx/WAF)."""
    return get_metrics_response()


# ── Startup Log ───────────────────────────────────────────────────────────────

log.info(
    "app_started",
    environment=ENVIRONMENT,
    cors_origins=ALLOWED_ORIGINS,
    docs_enabled=ENVIRONMENT == "development",
)
