"""Adapter for mock, offline provider-stub, and live Prayaas pipelines.

Contract
--------
run_pipeline(text) -> dict with:
    category   (str)            required for run_eval
    severity   (str)            required for run_eval
    confidence (float 0..1)     optional, enables the confidence-vs-coverage table
    usage      {"prompt_tokens": int, "completion_tokens": int}   optional, enables cost numbers

find_duplicate(text, existing) -> id (str) of the matching item in `existing`, or None.
    existing is a list of {"id": str, "text": str}.

Modes
-----
PRAYAAS_ADAPTER=mock   (default) synthetic pipeline so you can check the harness runs.
PRAYAAS_ADAPTER=real   calls your backend. Set PRAYAAS_BACKEND to the backend folder.
PRAYAAS_ADAPTER=stub   runs the actual backend with a fixed-delay SDK stub; no network.

Old vs new comparison
---------------------
    git worktree add ../prayaas-old <old-commit-sha>
    PRAYAAS_ADAPTER=real PRAYAAS_BACKEND=../prayaas-old/backend  python benchmark.py run --label old ...
    PRAYAAS_ADAPTER=real PRAYAAS_BACKEND=../backend              python benchmark.py run --label new ...
Two separate processes on purpose: both versions are called `agent.pipeline`, so they can't share one interpreter.
"""
import asyncio
import os
import random
import re
import sys
import time
import tempfile
import uuid
from contextvars import ContextVar
from pathlib import Path

MODE = os.environ.get("PRAYAAS_ADAPTER", "mock")
MOCK_STYLE = os.environ.get("PRAYAAS_MOCK_STYLE", "new")  # "old" = two blocking-ish calls
if MODE not in ("mock", "real", "stub"):
    raise ValueError("PRAYAAS_ADAPTER must be mock, stub, or real")

STUB_LATENCY_MS = float(os.environ.get("PRAYAAS_STUB_LATENCY_MS", "100"))
BENCH_MODEL = os.environ.get("PRAYAAS_BENCH_MODEL", "gemini-2.5-flash-lite")
CACHE_POLICY = "natural"

CATEGORIES = {"infrastructure", "safety", "sanitation", "noise", "maintenance", "security", "utilities", "other"}
_backend_ready = False
_sandbox = None
_usage_calls = ContextVar("eval_usage_calls", default=None)
_request_scope = ContextVar("eval_request_scope", default=None)


def configure_benchmark(*, mode=None, latency_ms=100, model=None, cache_policy="cold"):
    global MODE, STUB_LATENCY_MS, BENCH_MODEL, CACHE_POLICY
    if _backend_ready:
        raise RuntimeError("Configure the benchmark before importing the backend")
    MODE = mode or MODE
    STUB_LATENCY_MS = latency_ms
    BENCH_MODEL = model or BENCH_MODEL
    CACHE_POLICY = cache_policy


def _measure_provider(fn, kind):
    def measured(*args, **kwargs):
        calls = _usage_calls.get()
        event = {"kind": kind, "model": kwargs.get("model", "unknown"), "usage": None, "ok": False}
        started = time.perf_counter()
        try:
            response = fn(*args, **kwargs)
            event["ok"] = True
            meta = getattr(response, "usage_metadata", None)
            if kind == "generation" and meta is not None and meta.prompt_token_count is not None and meta.candidates_token_count is not None:
                event["usage"] = {"prompt_tokens": meta.prompt_token_count,
                                  "completion_tokens": meta.candidates_token_count + (getattr(meta, "thoughts_token_count", 0) or 0)}
            return response
        finally:
            event["elapsed_s"] = time.perf_counter() - started
            if calls is not None:
                calls.append(event)
    return measured


def _call_metrics(calls):
    generated = [item for item in calls if item["kind"] == "generation"]
    return {"generation_calls": len(generated),
            "embedding_calls": sum(item["kind"] == "embedding" for item in calls),
            "generation_wait_s": sum(item["elapsed_s"] for item in generated),
            "provider_models": sorted({item["model"] for item in generated})}


class PipelineFailure(Exception):
    def __init__(self, cause, metrics):
        # Provider error bodies can contain request data. Keep failure metadata only.
        super().__init__(f"{type(cause).__name__}; status={getattr(cause, 'status_code', 'unknown')}")
        self.metrics = metrics


def prepare():
    """Load a selected checkout once, outside timed runs, using an isolated DB."""
    global _backend_ready, _sandbox
    if MODE == "mock" or _backend_ready:
        return
    project = Path(__file__).resolve().parent.parent
    backend = Path(os.environ.get("PRAYAAS_BACKEND", str(project / "backend"))).resolve()
    if not (backend / "agent" / "pipeline.py").is_file():
        raise ValueError(f"No Prayaas backend found at {backend}")
    sys.path.insert(0, str(backend))
    if MODE == "stub":
        from provider_stub import disable_network
        disable_network()
        os.environ["GOOGLE_API_KEY"] = ""
        # Only the isolated benchmark DB is affected. No provider is contacted.
        os.environ["PRAYAAS_AI_DAILY_CALL_LIMIT"] = "100000000"
    else:
        from dotenv import load_dotenv
        load_dotenv(os.environ.get("PRAYAAS_ENV_FILE", str(project / ".env")))
        if not os.environ.get("GOOGLE_API_KEY"):
            raise ValueError("Real mode requires GOOGLE_API_KEY; no mock fallback is allowed")
    _sandbox = tempfile.TemporaryDirectory(prefix="prayaas-eval-")
    # Never read resident reports or write audit events to the development DB.
    os.environ["DATABASE_URL"] = "sqlite:///" + str(Path(_sandbox.name) / "eval.db")
    from database import Base, engine
    import models
    from agent import pipeline, dedup, confidence_gate, embeddings
    Base.metadata.create_all(engine)
    # Pin both revisions to the same model, including the baseline's hardcoded chain.
    confidence_gate.MODEL_CHAIN[:] = [BENCH_MODEL]
    if MODE == "stub":
        from provider_stub import make_client
        client = make_client(STUB_LATENCY_MS, embeddings.EMBEDDING_DIM)
        client.models.embed_content = _measure_provider(client.models.embed_content, "embedding")
        confidence_gate._client = client
        pipeline._client = client
        embeddings._get_client = lambda: client
    else:
        get_client = embeddings._get_client
        wrapped_clients = set()
        def measured_embedding_client():
            client = get_client()
            if client is not None and id(client) not in wrapped_clients:
                client.models.embed_content = _measure_provider(client.models.embed_content, "embedding")
                wrapped_clients.add(id(client))
            return client
        embeddings._get_client = measured_embedding_client
    def unavailable_embedding(text):
        raise RuntimeError("Real embedding unavailable; synthetic fallback is excluded from real evals")
    embeddings._pseudo_embedding = unavailable_embedding
    # Measure provider-reported usage on both revisions without editing baseline code.
    # ContextVars propagate into asyncio.to_thread, keeping concurrent calls separate.
    if confidence_gate._client is not None:
        confidence_gate._client.models.generate_content = _measure_provider(confidence_gate._client.models.generate_content, "generation")
    if CACHE_POLICY == "cold" and hasattr(pipeline, "structured_call"):
        original = pipeline.structured_call
        def uncached_call(*args, **kwargs):
            # Keep cache/DB overhead, but force a miss per report without racing
            # cache deletion against concurrent workers or changing input text.
            kwargs["scope"] = "benchmark:" + _request_scope.get()
            return original(*args, **kwargs)
        pipeline.structured_call = uncached_call
    _backend_ready = True


# ----------------------------------------------------------------------------
# REAL WIRING: edit these
# ----------------------------------------------------------------------------
def _normalize(raw: dict) -> dict:
    """Map your pipeline's output shape onto the contract above."""
    problem = raw.get("formatted_problem") or raw.get("problem") or raw
    return {
        "category": problem.get("category"),
        "severity": problem.get("severity"),
        "confidence": raw.get("confidence_score", raw.get("confidence")),
        "usage": raw.get("usage"),
        "usage_by_model": raw.get("usage_by_model", []),
        "model": raw.get("last_model_used"),
    }


async def _real_run_pipeline(text: str) -> dict:
    prepare()
    from agent.pipeline import run_ai_pipeline
    calls = []
    token = _usage_calls.set(calls)
    scope = _request_scope.set(uuid.uuid4().hex)
    try:
        raw = await run_ai_pipeline(text, user_id=None)
        result = _normalize(raw)
        if not result["category"] or not result["severity"] or result["confidence"] == 0:
            raise ValueError("Pipeline returned a failed/fallback draft, not a valid AI result")
    except Exception as exc:
        raise PipelineFailure(exc, _call_metrics(calls)) from exc
    finally:
        _usage_calls.reset(token)
        _request_scope.reset(scope)
    generated = [item for item in calls if item["kind"] == "generation"]
    result["usage_by_model"] = [{"model": item["model"], **item["usage"]} for item in generated if item["usage"] is not None]
    result["usage"] = {key: sum(item["usage"][key] for item in generated)
                       for key in ("prompt_tokens", "completion_tokens")} if generated and all(item["usage"] is not None for item in generated) else None
    result.update(_call_metrics(calls), cache_hit=bool(raw.get("cache_hit")))
    return result


async def _real_find_duplicate(text: str, existing: list):
    prepare()
    if not existing:
        return None

    def find():
        import json
        from sqlalchemy import create_engine
        from sqlalchemy.orm import Session
        from database import Base
        from models import Problem
        from agent.dedup import find_duplicates
        from agent.embeddings import embed_text
        from agent.pii import redact_pii

        # Each query gets only its earlier labelled items, including under concurrency.
        engine = create_engine("sqlite:///:memory:")
        try:
            Base.metadata.create_all(engine)
            with Session(engine) as db:
                ids = {}
                for index, item in enumerate(existing, start=1):
                    ids[index] = item["id"]
                    clean, _ = redact_pii(item["text"])
                    db.add(Problem(id=index, title=item["text"][:200], raw_input=clean,
                                   formatted_description=clean, author_id=1, status="Open",
                                   embedding_json=json.dumps(embed_text(clean))))
                db.commit()
                clean, _ = redact_pii(text)
                matches = find_duplicates(db, raw_text=clean, top_k=1)
                return ids[matches[0]["problem_id"]] if matches else None
        finally:
            engine.dispose()

    return await asyncio.to_thread(find)


# ----------------------------------------------------------------------------
# Mock mode (synthetic: numbers from this are NOT quotable)
# ----------------------------------------------------------------------------
_CATS = {
    "water": ["water", "pipe", "leak", "pressure", "paani"],
    "electricity": ["power", "light", "bijli", "electric", "spark"],
    "lift": ["lift", "elevator"],
    "security": ["security", "gate", "guard", "cctv", "camera"],
    "waste": ["garbage", "kachra", "smell", "waste"],
    "parking": ["parking", "parked"],
}


def _mock_category(text):
    t = text.lower()
    for cat, words in _CATS.items():
        if any(w in t for w in words):
            return cat
    return "other"


def _mock_severity(text):
    t = text.lower()
    if any(w in t for w in ["spark", "danger", "fire", "shock"]):
        return "critical"
    if any(w in t for w in ["stuck", "flood", "leak", "sleeping"]):
        return "high"
    if any(w in t for w in ["pressure", "parking"]):
        return "low"
    return "medium"


async def _mock_run_pipeline(text: str) -> dict:
    rng = random.Random(text)
    if MOCK_STYLE == "old":
        time.sleep(0.12)  # blocking call on the event loop (the bug)
        await asyncio.sleep(0.5 + rng.random() * 0.2)  # LLM call 1
        await asyncio.sleep(0.5 + rng.random() * 0.2)  # LLM call 2
        usage = {"prompt_tokens": 1800, "completion_tokens": 450}
    else:
        await asyncio.sleep(0.55 + rng.random() * 0.2)  # single structured call
        usage = {"prompt_tokens": 1100, "completion_tokens": 420}
    return {
        "category": _mock_category(text),
        "severity": _mock_severity(text),
        "confidence": round(0.55 + rng.random() * 0.43, 2),
        "usage": usage,
    }


def _tokens(text):
    return {w for w in re.findall(r"[a-z]+", text.lower()) if len(w) > 3}


async def _mock_find_duplicate(text: str, existing: list):
    await asyncio.sleep(0.01)
    a = _tokens(text)
    best, best_score = None, 0.0
    for item in existing:
        b = _tokens(item["text"])
        if not a or not b:
            continue
        score = len(a & b) / len(a | b)
        if score > best_score:
            best, best_score = item["id"], score
    return best if best_score >= 0.2 else None


# ----------------------------------------------------------------------------
# Public API used by benchmark.py and run_eval.py
# ----------------------------------------------------------------------------
async def run_pipeline(text: str) -> dict:
    return await (_mock_run_pipeline(text) if MODE == "mock" else _real_run_pipeline(text))


async def find_duplicate(text: str, existing: list):
    return await (_mock_find_duplicate(text, existing) if MODE == "mock" else _real_find_duplicate(text, existing))
