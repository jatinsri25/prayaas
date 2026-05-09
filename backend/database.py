"""
Prayaas Database Configuration — Production Ready

Supports:
  - SQLite  (dev):  DATABASE_URL=sqlite:///./prayaas.db
  - PostgreSQL (prod): DATABASE_URL=postgresql://user:pass@host:5432/prayaas
"""

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker
import os

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./prayaas.db")

# ── Engine configuration ─────────────────────────────────────────────────────
_is_sqlite = DATABASE_URL.startswith("sqlite")

if _is_sqlite:
    engine = create_engine(
        DATABASE_URL,
        connect_args={"check_same_thread": False},
    )
else:
    # PostgreSQL with connection pooling and TLS
    _connect_args = {}
    if os.getenv("DB_SSL_REQUIRE", "false").lower() == "true":
        _connect_args["sslmode"] = "require"

    engine = create_engine(
        DATABASE_URL,
        pool_size=int(os.getenv("DB_POOL_SIZE", "10")),
        max_overflow=int(os.getenv("DB_MAX_OVERFLOW", "20")),
        pool_pre_ping=True,           # detect stale connections
        pool_recycle=1800,             # recycle connections after 30 min
        connect_args=_connect_args,
    )

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    """FastAPI dependency — yields a DB session and ensures cleanup."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
