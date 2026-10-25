"""Latency / throughput / cost / event-loop-stall benchmark for the Prayaas AI pipeline.

    python benchmark.py run --label old --runs 40 --concurrency 4 --out results/old.json
    python benchmark.py run --label new --runs 40 --concurrency 4 --out results/new.json
    python benchmark.py compare results/old.json results/new.json

Prices are per 1M tokens. Use the actual provider/model pricing and pass it in;
they are not hardcoded here because they change.
"""
import argparse
import asyncio
import json
import hashlib
import os
import platform
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import adapter
from common import LoopLagMonitor, load_jsonl, percentile

DEFAULT_TEXTS = [
    "Water is leaking from the main pipe near Wing B gate, the road is flooded.",
    "Streetlight near the parking lot has not worked for a week, very dark at night.",
    "Lift in Wing D is stuck again and senior citizens cannot reach upper floors.",
    "Garbage has not been collected from Wing A for four days and the smell is bad.",
    "Security guard at the main gate let a visitor in without any entry record.",
]


async def timed_call(text):
    t0 = time.perf_counter()
    try:
        out = await adapter.run_pipeline(text)
        return time.perf_counter() - t0, out or {}, None
    except Exception as exc:  # noqa: BLE001
        return time.perf_counter() - t0, getattr(exc, "metrics", {}), repr(exc)


async def run(args):
    if args.runs < 1 or args.concurrency < 1 or args.warmup < 0:
        raise ValueError("Runs/concurrency must be positive; warmup cannot be negative")
    if any(price is not None and price < 0 for price in (args.price_in, args.price_out)):
        raise ValueError("Prices cannot be negative")
    texts = [r["text"] for r in load_jsonl(args.dataset)] if args.dataset else DEFAULT_TEXTS
    if not texts or any(not isinstance(text, str) or not text.strip() for text in texts):
        raise ValueError("Dataset must contain non-empty report texts")
    adapter.prepare()
    warm_results = [await timed_call(t) for t in texts[: args.warmup]]

    jobs = [texts[i % len(texts)] for i in range(args.runs)]
    sem = asyncio.Semaphore(args.concurrency)
    results = []

    async def worker(text):
        async with sem:
            results.append(await timed_call(text))

    async with LoopLagMonitor() as mon:
        t0 = time.perf_counter()
        await asyncio.gather(*(worker(t) for t in jobs))
        wall = time.perf_counter() - t0

    ok = [(lat, out) for lat, out, err in results if err is None]
    errors = [err for _, _, err in results if err]
    lats = [lat for lat, _ in ok]
    usages = [out["usage"] for _, out in ok if isinstance(out.get("usage"), dict)
              and all(isinstance(out["usage"].get(k), int) and out["usage"][k] >= 0
                      for k in ("prompt_tokens", "completion_tokens"))]
    known_usage = bool(ok) and len(usages) == len(ok)
    pt = sum(u["prompt_tokens"] for u in usages)
    ct = sum(u["completion_tokens"] for u in usages)
    models = sorted({model for _, out, _ in results for model in (out.get("provider_models") or [out.get("model") or "unknown"])})
    can_price = adapter.MODE == "real" and known_usage and not errors and len(models) == 1 and args.price_in is not None and args.price_out is not None
    cost = (pt * args.price_in + ct * args.price_out) / 1e6 if can_price else None
    backend = Path(os.environ.get("PRAYAAS_BACKEND", str(Path(__file__).resolve().parent.parent / "backend"))).resolve()
    source = hashlib.sha256()
    harness = hashlib.sha256()
    for name in ("adapter.py", "benchmark.py", "provider_stub.py", "common.py"):
        harness.update(name.encode() + Path(__file__).with_name(name).read_bytes())
    git_revision, git_dirty = None, None
    if adapter.MODE in ("real", "stub"):
        for path in sorted((backend / "agent").glob("*.py")):
            source.update(path.name.encode() + path.read_bytes())
        revision = subprocess.run(["git", "-C", str(backend), "rev-parse", "HEAD"], capture_output=True, text=True)
        status = subprocess.run(["git", "-C", str(backend), "status", "--porcelain"], capture_output=True, text=True)
        git_revision = revision.stdout.strip() if revision.returncode == 0 else None
        git_dirty = bool(status.stdout.strip()) if status.returncode == 0 else None
    counted = adapter.MODE in ("real", "stub")
    generation_calls = sum(out.get("generation_calls", 0) for _, out, _ in results) if counted else None
    warmup_calls = sum(out.get("generation_calls", 0) for _, out, _ in warm_results) if counted else None
    provider_waits = [out["generation_wait_s"] for _, out in ok if "generation_wait_s" in out]
    overheads = [max(0, lat - out["generation_wait_s"]) for lat, out in ok if "generation_wait_s" in out]
    stub = adapter.MODE == "stub"
    if stub:
        import provider_stub

    summary = {
        "label": args.label,
        "when": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "python": platform.python_version(),
        "adapter_mode": adapter.MODE,
        "simulated": adapter.MODE != "real",
        "scope": "text pipeline; isolated empty DB; excludes HTTP/audio/dedup; per-report latency excludes admission queue",
        "backend_path": str(backend) if counted else None,
        "source_sha256": source.hexdigest() if counted else None,
        "harness_sha256": harness.hexdigest(),
        "git_revision": git_revision,
        "git_dirty": git_dirty,
        "pinned_model": adapter.BENCH_MODEL if counted else None,
        "response_cache_policy": adapter.CACHE_POLICY if counted else None,
        "stub_latency_ms": adapter.STUB_LATENCY_MS if stub else None,
        "stub_fixture": provider_stub.FIXTURE_VERSION if stub else None,
        "stub_network_attempts": provider_stub.network_attempts if stub else None,
        "embedding_policy": "zero-delay SDK stub; normal embedding LRU retained" if stub else "live embeddings; normal LRU retained",
        "dataset_sha256": hashlib.sha256(json.dumps(texts, ensure_ascii=False).encode()).hexdigest(),
        "warmup": min(args.warmup, len(texts)),
        "warmup_errors": sum(err is not None for _, _, err in warm_results),
        "warmup_generation_calls": warmup_calls,
        "generation_calls": generation_calls,
        "generation_calls_per_success": sum(out.get("generation_calls", 0) for _, out in ok) / len(ok) if counted and ok else None,
        "generation_calls_including_warmup": generation_calls + warmup_calls if counted else None,
        "embedding_calls": sum(out.get("embedding_calls", 0) for _, out, _ in results) if counted else None,
        "response_cache_hits": sum(bool(out.get("cache_hit")) for _, out in ok) if counted else None,
        "mean_generation_wait_s": round(sum(provider_waits) / len(provider_waits), 6) if provider_waits else None,
        "mean_non_generation_s": round(sum(overheads) / len(overheads), 6) if overheads else None,
        "wall_s": round(wall, 3),
        "runs": len(results),
        "ok": len(ok),
        "error_rate": round(len(errors) / len(results), 4),
        "concurrency": args.concurrency,
        "p50_s": round(percentile(lats, 50), 3) if lats else None,
        "p95_s": round(percentile(lats, 95), 3) if lats else None,
        "mean_s": round(sum(lats) / len(lats), 3) if lats else None,
        "throughput_rps": round(len(ok) / wall, 3),
        "usage_coverage": len(usages) / len(ok) if ok else 0,
        "tokens_per_report": round((pt + ct) / len(ok), 1) if known_usage else None,
        "cost_per_report_usd": round(cost / len(ok), 6) if cost is not None else None,
        "price_in_per_million": args.price_in,
        "price_out_per_million": args.price_out,
        "models": models,
        "error_examples": errors[:3],
        "loop_stall_max_ms": round(mon.max_ms, 1),
        "loop_stall_p99_ms": round(mon.p99_ms, 1) if len(mon.lags) >= 100 else None,
        "loop_stall_samples": len(mon.lags),
        "per_report_generation_calls": [out.get("generation_calls") for _, out, _ in results] if counted else None,
    }
    if adapter.MODE == "mock":
        print("MOCK MODE: these numbers are synthetic. Do not quote them.\n")
    elif stub:
        print("SIMULATED PROVIDER: actual checkout, fixed SDK latency, network disabled. Not live latency, throughput, token cost, or quality.\n")
    for k, v in summary.items():
        print(f"{k:22} {v}")
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(summary, indent=2))
        print(f"\nSaved {args.out}")
    if not ok:
        raise SystemExit(1)


def pct_drop(before, after):
    return (before - after) / before * 100 if before else float("nan")


def compare(args):
    a = json.loads(Path(args.before).read_text())
    b = json.loads(Path(args.after).read_text())
    for field in ("adapter_mode", "concurrency", "runs", "warmup", "dataset_sha256", "python", "models",
                  "pinned_model", "response_cache_policy", "stub_latency_ms", "stub_fixture", "embedding_policy", "scope",
                  "harness_sha256", "price_in_per_million", "price_out_per_million"):
        if a.get(field) != b.get(field):
            raise ValueError(f"Cannot compare runs with different {field}")
    if any(run.get("error_rate") or not run.get("ok") or run.get("warmup_errors") for run in (a, b)):
        raise ValueError("Cannot compare failed or partially successful runs, including event-loop stalls. Rerun both sides successfully.")
    if a.get("stub_network_attempts") or b.get("stub_network_attempts"):
        raise ValueError("Unexpected network attempts invalidate an offline stub comparison")
    if a["adapter_mode"] == "stub":
        print("SIMULATED PROVIDER COMPARISON: fixed-delay SDK stub, not production measurements.\n")
    rows = [
        ("p50 latency (s)", "p50_s"),
        ("p95 latency (s)", "p95_s"),
        ("mean latency (s)", "mean_s"),
        ("generation calls / successful report", "generation_calls_per_success"),
        ("non-generation time (s)", "mean_non_generation_s"),
        ("tokens / report", "tokens_per_report"),
        ("cost / report (USD)", "cost_per_report_usd"),
        ("event-loop stall max (ms)", "loop_stall_max_ms"),
        ("event-loop stall p99 (ms)", "loop_stall_p99_ms"),
        ("error rate", "error_rate"),
    ]
    print(f"| metric | {a['label']} | {b['label']} | change |")
    print("|---|---|---|---|")
    for name, key in rows:
        change = "n/a" if not a.get(key) or b.get(key) is None else f"{-pct_drop(a[key], b[key]):+.2f}%"
        print(f"| {name} | {a.get(key)} | {b.get(key)} | {change} |")
    tp_gain = f"{(b['throughput_rps'] / a['throughput_rps'] - 1) * 100:+.0f}%" if a["throughput_rps"] else "n/a"
    print(f"| throughput (req/s) | {a['throughput_rps']} | {b['throughput_rps']} | {tp_gain} |")

    if a["adapter_mode"] == "mock":
        print("\nMOCK MODE: synthetic comparison, not evidence of a performance improvement.")
    elif a["adapter_mode"] == "stub":
        print("\nOnly claim structural call counts and responsiveness under the specified stub. Output fixtures do not test quality.")
    else:
        print("\nRepeat both runs. Report the slower run and evaluate quality separately before making claims.")
    print("Missing usage/prices are unknown, never free. Cost excludes embedding and transcription calls.")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--label", required=True)
    r.add_argument("--mode", choices=("mock", "stub", "real"), default=adapter.MODE)
    r.add_argument("--stub-latency-ms", type=float, default=adapter.STUB_LATENCY_MS)
    r.add_argument("--model", default=adapter.BENCH_MODEL, help="Pin the same generation model on both revisions; disables model fallback")
    r.add_argument("--response-cache", choices=("cold", "natural"), default="cold", help="Cold assigns each report a unique cache scope without altering its text")
    r.add_argument("--runs", type=int, default=40)
    r.add_argument("--concurrency", type=int, default=4)
    r.add_argument("--warmup", type=int, default=2)
    r.add_argument("--dataset", help="JSONL with a 'text' field (defaults to 5 built-in samples)")
    r.add_argument("--price-in", type=float, help="USD per 1M prompt tokens for the actual model")
    r.add_argument("--price-out", type=float, help="USD per 1M completion tokens for the actual model")
    r.add_argument("--out")
    c = sub.add_parser("compare")
    c.add_argument("before")
    c.add_argument("after")
    args = ap.parse_args()
    if args.cmd == "run":
        adapter.configure_benchmark(mode=args.mode, latency_ms=args.stub_latency_ms, model=args.model, cache_policy=args.response_cache)
        asyncio.run(run(args))
    else:
        compare(args)


if __name__ == "__main__":
    main()
