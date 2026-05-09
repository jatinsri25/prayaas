"""
Lightweight idempotent column-adder for SQLite dev databases.

`Base.metadata.create_all()` only creates *missing tables*; it never adds
*missing columns* to existing tables. For SQLite dev where there's no
Alembic flow, we run this on startup to ALTER TABLE ADD COLUMN any new
fields we shipped in models.py.

Production (Postgres) should always use Alembic migrations — this module
is a no-op there.
"""

from __future__ import annotations

from typing import Iterable

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

# Dev-only column additions. Each tuple is (table_name, column_name, sql_type).
# Keep these in sync with models.py whenever a new optional column is added.
_DEV_COLUMNS: list[tuple[str, str, str]] = [
    ("problems", "latitude", "FLOAT"),
    ("problems", "longitude", "FLOAT"),
    ("problems", "embedding_json", "TEXT"),
    ("problems", "confidence_score", "FLOAT"),
    ("problems", "was_escalated", "BOOLEAN DEFAULT 0"),
    ("problems", "last_model_used", "VARCHAR(80)"),
]


def _existing_columns(engine: Engine, table: str) -> set[str]:
    inspector = inspect(engine)
    if table not in inspector.get_table_names():
        return set()
    return {col["name"] for col in inspector.get_columns(table)}


def ensure_dev_columns(engine: Engine) -> Iterable[str]:
    """
    Add any dev columns missing from the database. Returns the list of
    columns that were added (useful for logging on startup).
    """
    if not engine.url.drivername.startswith("sqlite"):
        return []  # Postgres uses Alembic

    added: list[str] = []
    with engine.begin() as conn:
        for table, column, sql_type in _DEV_COLUMNS:
            cols = _existing_columns(engine, table)
            if not cols:
                continue  # table doesn't exist yet — create_all will handle it
            if column in cols:
                continue
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {sql_type}"))
            added.append(f"{table}.{column}")
    return added
