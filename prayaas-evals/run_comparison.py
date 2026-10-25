"""Run isolated old/new benchmarks twice, sequentially, with identical settings."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--old-backend", required=True)
    parser.add_argument("--new-backend", default="../backend")
    parser.add_argument("--runs", type=int, default=40)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--warmup", type=int, default=2)
    parser.add_argument("--mode", choices=("stub", "real"), default="stub")
    parser.add_argument("--stub-latency-ms", type=float, default=100)
    parser.add_argument("--model", default="gemini-2.5-flash-lite")
    parser.add_argument("--out-dir", help="Defaults to results/stub or results/live")
    parser.add_argument("--allow-live", action="store_true", help="Explicitly allow provider usage for the live matrix")
    args = parser.parse_args()
    if args.runs < 1 or args.concurrency < 1 or args.warmup < 0:
        parser.error("Runs/concurrency must be positive and warmup nonnegative")
    if args.mode == "real" and not args.allow_live:
        parser.error("Live runs consume quota. Use --allow-live only after arranging sufficient quota on the same model.")
    output = Path(args.out_dir or ("results/stub" if args.mode == "stub" else "results/live"))
    output.mkdir(parents=True, exist_ok=True)
    expected = (args.runs + min(args.warmup, 5)) * 6
    print(f"Mode={args.mode}. Two repeats per side: expected {expected} generation attempts including warmup, before retries; embeddings extra.", flush=True)
    if args.mode == "stub":
        print("SIMULATED provider timings; no API key or network usage.", flush=True)
    collected = {"old": [], "new": []}
    for repeat in (1, 2):
        for label, backend in (("old", args.old_backend), ("new", args.new_backend)):
            name = f"{label}-{repeat}"
            env = {**os.environ, "PRAYAAS_ADAPTER": args.mode, "PRAYAAS_BACKEND": str(Path(backend).resolve())}
            command = [sys.executable, "benchmark.py", "run", "--label", name,
                       "--mode", args.mode, "--model", args.model, "--response-cache", "cold",
                       "--stub-latency-ms", str(args.stub_latency_ms), "--warmup", str(args.warmup),
                       "--runs", str(args.runs), "--concurrency", str(args.concurrency),
                       "--out", str(output / f"{name}.json")]
            print(f"\nRunning {name} on {env['PRAYAAS_BACKEND']}", flush=True)
            result = subprocess.run(command, env=env, check=False)
            if result.returncode:
                raise SystemExit(f"{name} failed. Inspect the saved result before spending more API quota.")
            summary = json.loads((output / f"{name}.json").read_text())
            if summary["error_rate"] or summary["warmup_errors"]:
                raise SystemExit(f"{name} had failed requests. Fix provider availability before comparing latency.")
            collected[label].append(summary)
    for label, rows in collected.items():
        if len({row["source_sha256"] for row in rows}) != 1:
            raise SystemExit(f"{label} source changed between repeats; comparison rejected")
    selected = {label: max(rows, key=lambda row: (row["p95_s"], row["mean_s"])) for label, rows in collected.items()}
    print("\nSelecting the larger p95 repeat per side, with mean as a tie-breaker.", flush=True)
    comparison = subprocess.run([sys.executable, "benchmark.py", "compare",
        str(output / f"{selected['old']['label']}.json"), str(output / f"{selected['new']['label']}.json")],
        capture_output=True, text=True, check=True)
    (output / "comparison.txt").write_text(comparison.stdout)
    (output / "selection.json").write_text(json.dumps({"rule": "max p95, then max mean; independently per side",
        "mode": args.mode, "selected": {label: row["label"] for label, row in selected.items()}}, indent=2))
    print(comparison.stdout)


if __name__ == "__main__":
    main()
