# Validation Results

Initial live checks: 2026-10-21. Offline structural verification: 2026-10-22.
No live performance or model-quality improvement has been established.

## Offline Structural Verification

The provider-stub benchmark runs the actual baseline commit `732c500` and the
optimized **uncommitted working tree**, not two invented mock pipelines. Source
hashes and dirty-worktree status are recorded. Each generation gets the same
100 ms synchronous SDK-boundary delay and a valid shape-only fixture. Embeddings
use a separate zero-delay fixture. Networking is blocked, response-cache misses
are forced per report, and both revisions use the same model identifier.

Two repeats, 40 reports per version per repeat, concurrency 4, two warmups:

| Run | Successful measured reports | Measured generation calls | Calls/report | Warmup generation calls |
| --- | ---: | ---: | ---: | ---: |
| stub old-1 | 40 / 40 | 80 | 2 | 4 |
| stub old-2 | 40 / 40 | 80 | 2 | 4 |
| stub new-1 | 40 / 40 | 40 | 1 | 2 |
| stub new-2 | 40 / 40 | 40 | 1 | 2 |

All four runs had zero response-cache hits and zero network attempts. Token
usage and cost are unknown, not zero-cost production estimates. This confirms
**2 to 1 generation calls for valid, uncached text drafts** in these versions.
Embeddings/transcription are separate calls; retries can increase generation calls.

The integration test also confirms event-loop responsiveness under concurrent
fixed-delay stub work. This is an offline test result, not a production stall
measurement. The baseline's fully blocked batch yields only one overdue timer
sample; p99 is therefore withheld. Raw simulated timings and the deterministic
larger-p95 repeat selection are in [results/stub/comparison.txt](results/stub/comparison.txt)
and [results/stub/selection.json](results/stub/selection.json). Do not put simulated
latency/throughput percentages on a resume.

Verification on 2026-10-22: 32 backend tests, 15 harness/stub integration tests,
and 6 frontend auth/stream unit tests passed. The network guard, model/settings
matching, failed-run rejection, cache accounting, and unknown token-cost behavior
are covered. These counts supersede the earlier 27-test description.

A supported resume statement is: "Reduced the normal text-draft generation path
from two LLM calls to one; made generation non-blocking, cancellable, and streamed,
with call counts and concurrent responsiveness verified using a stubbed provider."
The resume file itself has not been changed.

## Completed

- Mock benchmark: 20 calls; confirms that the harness runs. Synthetic metrics.
- Mock quality evaluation: 14 format-example rows; synthetic, non-independent labels.
- Live preflight: one structured report successfully generated with Gemini.
- Unit tests cover schema validation, one-call generation, safety/budget gates,
  cancellation, no unnecessary embeddings, event-loop responsiveness, and streaming.
- Browser checks cover cancellation/input preservation, error recovery, mobile
  layout, reduced motion, draft review, and duplicate-submit prevention.
- Final real browser request verified streamed progress followed by the provider
  quota error, with the resident's input preserved. Login/dashboard regression
  checks and the production frontend build passed.

## Live Comparison Blocked

The requested 40-call, concurrency-4 matrix started against baseline commit
`732c500` and the optimized source, in separate processes and isolated databases.

| Run | Successful | Failed | Interpretation |
| --- | ---: | ---: | --- |
| old-1 | 5 / 40 | 35 / 40 | Generic fallback drafts rejected as failures |
| new-1 | 0 / 40 | 40 / 40 | No valid generated drafts; no latency sample |

The provider subsequently confirmed HTTP 429 RESOURCE_EXHAUSTED for
`generate_content_free_tier_requests`, limit 20 for `gemini-2.5-flash-lite`,
with a retry delay of roughly 22 hours 44 minutes. This is a provider quota,
not a local backend reachability failure. Further runs were stopped.
The previous fallback (`gemini-2.5-flash`) also returned 404 for this key.
The configurable fallback was changed to `gemini-3.8-flash`, confirmed as listed
with `generateContent` support; successful generation on that fallback remains
unverified. The final end-to-end request still returned a quota error.

No event-loop comparison is valid for these live runs. The new run had zero
successful reports and was mostly idle; its stall samples are not comparable to
the baseline workload. Do not quote either run as evidence of a responsiveness,
latency, throughput, or cost improvement.

There is no valid repeated old/new comparison and no cost saving claim. Restore
provider quota (enable billing/sufficient allowance on the same model, or spread
lower-volume matched runs over days), then run
both sides twice and report the slower-looking repeats. Saved JSON identifies
the exact source hashes measured; later quota-error/timeout handling changes
require a fresh run.

The complete two-repeat, 40-report-per-side matrix needs at least 240 generation
attempts before warmup, or 252 with the harness's two warmups per side per repeat.
Embedding calls and schema retries are additional. One daily reset at the observed
20-request/model allowance does not fund that matrix. With that allowance and no
retries or other use, two calls per valid report permit 10 reports/day; one call
permits 20. This is generation-quota arithmetic, not measured throughput. The
replacement credential's quota has not been checked and may differ.

## Quality Not Measured

No independently labelled complaints were supplied. The sample taxonomy is not
Prayaas's taxonomy. Real accuracy, F1, calibration, and inter-rater agreement are
unmeasured. No fabricated dataset was created.
