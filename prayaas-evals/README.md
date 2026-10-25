# Prayaas Evals

The supplied harness is wired to the real text pipeline and semantic duplicate
checker. `benchmark.py` defaults to mock; `run_comparison.py` defaults to offline
provider-stub mode. Mock outputs are synthetic, not evidence
of latency, cost, or quality. See [RESULTS.md](RESULTS.md) for this run's limitations.

## Sanity Checks

The harness itself uses only the standard library (Python 3.10+ recommended).
Real mode additionally needs the backend's installed dependencies. The current
local backend uses Python 3.9; benchmark JSON records that version explicitly.
Upgrade the backend runtime before deployment; Google warns that it is EOL.

From this directory:

```bash
python benchmark.py run --label demo --runs 20 --out results/mock-benchmark.json
python run_eval.py --dataset data/sample_labelled.jsonl --out results/mock-eval.json --report results/mock-eval.md
../backend/venv/bin/python -m unittest test_harness test_stub_pipeline -v
```

## Real Adapter

`adapter.py` calls `agent.pipeline.run_ai_pipeline` directly. It preserves the
original async behavior so blocking I/O really registers on the loop-lag monitor.
Provider-reported token usage is captured for both revisions with per-request
ContextVars, including fallback generation calls and thinking tokens. Missing
usage remains unknown. Failed generic fallback drafts count as errors, not success.

The selected backend is imported before timing. Its database is replaced with a
temporary database. No live resident reports, admin corrections, or audit rows
are read or modified. Duplicate checks use a separate in-memory database per
query, containing only earlier dataset rows, with the real embedding and dedup
implementation. They are text-only checks, not a geofencing evaluation.
Real mode rejects the embedding service's synthetic hash fallback if the provider
is unavailable, rather than passing synthetic vectors off as semantic matching.

Credentials load from this project's `.env`, or `PRAYAAS_ENV_FILE`. Never put
credentials or resident information in this directory. `PRAYAAS_BACKEND` selects
a source checkout, not a server URL. Always run old/new in separate processes.

## Offline Provider Stub

`--mode stub` runs each checkout's actual `run_ai_pipeline`, not a second mock
implementation of the pipeline. It replaces the SDK `generate_content` boundary
with the same synchronous fixed delay on both sides, returning valid shape-only
fixtures for baseline formatting, baseline solutions, or the combined bilingual
response. It does not read credentials. A Python audit guard blocks socket
connections even if a new path accidentally reaches a real client.

Generation calls are counted per request using ContextVars, including worker
threads, retries, and failures. Embeddings use a separate zero-delay SDK stub;
their calls are counted separately and their existing LRU cache stays enabled.
These vectors do not represent semantic similarity. Stub mode cannot run quality
evaluation, and token usage/cost are always unknown, even when prices are passed.

```bash
../backend/venv/bin/python run_comparison.py --mode stub \
  --old-backend /Users/jatinsrivastava/.codex/worktrees/pipeline-baseline/Prayaas/backend \
  --new-backend ../backend --runs 40 --concurrency 4 --stub-latency-ms 100
```

Outputs go to `results/stub/`, separate from historical live failures. Every JSON
and comparison is labelled simulated. Both sides use the same model identifier,
inputs, fixed delay, warmup, interpreter, and concurrency. No provider token or
quota is used. The integration tests export immutable baseline source from Git
into a temporary directory and run it and the working tree in separate processes.
They assert the 2-to-1 **generation** count and concurrent event-loop responsiveness.
They also test cache accounting and network denial. These are controlled software
test findings, not production latency, throughput, or translation-quality evidence.

`--response-cache cold` is the benchmark default: a unique scope per invocation
forces a response-cache miss without changing complaint text or deleting cache
rows during concurrent requests. Database/cache lookup overhead remains included.
Warmup cannot accidentally turn measured reports into cached successes. Use
`--response-cache natural` only for a separately labelled cache experiment.
Never compare different policies. Generation/model fallback is pinned off for
both revisions; a structured schema retry can still add a call.

Per-report latency begins after admission to the concurrency semaphore. Batch
wall time includes queueing. `mean_non_generation_s` is elapsed time minus measured
synchronous generation wait, not CPU-only overhead: it includes database work,
thread scheduling, embeddings, and other pipeline work. Loop-lag sample count is
reported; a fully blocked batch may produce only one overdue timer sample.
Loop-lag p99 is left unknown unless at least 100 timer samples were collected.

## Repeatable Performance Runs

The preserved baseline is commit `732c500`, before the optimization:

```bash
PRAYAAS_AI_DAILY_CALL_LIMIT=100 ../backend/venv/bin/python run_comparison.py --mode real --allow-live \
  --old-backend /Users/jatinsrivastava/.codex/worktrees/pipeline-baseline/Prayaas/backend \
  --new-backend ../backend --runs 40 --concurrency 4 --model gemini-2.5-flash-lite
```

Do not run the live command until the same project's quota/billing supports it.
The local call-budget override above affects only each temporary benchmark DB;
it does not raise provider limits or enable billing.

This runs old/new twice, sequentially, with identical warmup, inputs, interpreter,
and concurrency. It stops on failed requests instead of burning more quota on an
invalid comparison. Ensure sufficient provider quota first: the full matrix
requires at least 240 measured generation attempts: `2 * 40 * (2 + 1)`.
Two warmups per side per repeat add 12, for **252 before retries**, with embeddings
extra. At the previously observed 20/day/model allowance, resetting once cannot
fund the matrix. The ideal generation-only capacity is 10 baseline or 20 optimized
uncached valid reports per day, assuming no retries, warmups, or other consumers.
That is conditional quota arithmetic, not a measured production throughput gain.
Arrange sufficient quota on the **same model**, or reduce volume and spread
matched runs over several days, recording timing/environment differences.

The runner selects the larger p95 repeat independently for each side (mean breaks
ties), saves the selection rule, and writes the comparison. Do not cherry-pick
fast runs. It rejects source changes between repeats. Live outputs go to
`results/live/`. To compare chosen outputs directly:

```bash
python benchmark.py compare results/stub/old-1.json results/stub/new-1.json
```

Results include dataset/source/harness hashes, Git revision and dirty-worktree
status, generation/embedding call counts, warmup counts, cache hits, success/error
counts, p50/p95, throughput,
loop lag, usage coverage, and model names. They measure the text pipeline against
an empty DB, not HTTP/auth, voice transcription, posting, or duplicate-check latency.
Any failed measured or warmup call makes a comparison invalid, including its
event-loop stall comparison. The compare command refuses mixed models, modes,
delays, cache policies, datasets, prices, or harness versions. Rerun measurements
if the source hash changes. Shared-machine workload and provider variation affect
results; quality is a separate test, not implied by a successful API call.

For cost, pass `--price-in` and `--price-out` to `benchmark.py run` using the actual
[Gemini model pricing](https://ai.google.dev/gemini-api/docs/pricing), not OpenAI
pricing. Missing rates, missing usage, failed calls, or mixed-model runs result in
`null`, never a false zero-dollar claim. Estimates exclude embeddings, audio,
infrastructure, and free-tier/billing adjustments.

## Quality Data

`data/sample_labelled.jsonl` is only a model-written format/mock fixture. Its
invented taxonomy is incompatible with Prayaas, and it is not independent data.
Real mode refuses it before spending tokens. No labels were fabricated or mapped
after viewing predictions. No real quality accuracy/F1 is currently available.

Use real, consented complaints, anonymized before committing them. Have humans
agree on category boundaries before independently labelling. The supported labels
(case-insensitive) are Infrastructure, Safety, Sanitation, Noise, Maintenance,
Security, Utilities, Other. Severities are Low, Medium, High, Critical.

Document Safety/Security, Infrastructure/Maintenance, and Utilities/Infrastructure
tie-break rules. Get a second independent labeller on 30-50 items and report
agreement (for example Cohen's kappa). Record sampling/oversampling methods,
class counts, and uncertainty. Do not quote per-class metrics from tiny samples.
Keep predictions hidden until labels are finalized; confidence scores are
heuristics, not calibrated probabilities of correctness.

After obtaining 50-100+ independently labelled rows:

```bash
PRAYAAS_ADAPTER=real ../backend/venv/bin/python run_eval.py \
  --dataset data/my_labelled.jsonl --out results/eval.json --report results/eval.md
```

Each `duplicate_of` must reference an earlier ID. The harness validates this and
the taxonomy, but cannot verify consent, independence, or labelling quality.

## Implementation Notes

The optimized pipeline requests report fields and three solutions in one
[structured JSON response](https://ai.google.dev/gemini-api/docs/generate-content/structured-output).
Local Pydantic validation remains mandatory. Sync SDK/database work runs in
worker threads. The current report path uses the primary model with at most one
schema-only retry and bounded provider timeouts; it no longer uses confidence-based
model escalation. Benchmark mode explicitly pins the same model on both revisions.
Cancelling stops the browser wait and subsequent pipeline stages/fallbacks. An
already running synchronous provider call can finish within its timeout and may
still incur provider usage. Background indexing is best-effort, not a durable queue.
