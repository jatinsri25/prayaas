# Low-quota community features

## Scope

This application currently represents one society workspace, with public and private
groups. There is no society tenant model. Digests aggregate this deployment and are
restricted to `society_admin` / `superadmin`; do not share one deployment between
unrelated societies without introducing tenant-scoped storage and authorization.

### Bilingual reporting

- `/problems/new` accepts English, Hindi, and Hinglish. The English / Hindi control
  persists locally and changes the reporting, search, and committee interface copy.
  It is not a translation of every page in the application.
- The existing draft generation returns `description_en` and `description_hi` in
  one structured response, alongside report metadata and three suggested actions.
  Longer bilingual output uses more output tokens, even without an additional call.
- Residents see their original text and both editable descriptions before posting.
  The saved original is PII-masked. A manual report needs only one language; no
  missing translation is fabricated. Existing reports can lack translations.
- After posting, editing one description clears the other to avoid displaying a
  stale translation. Review text and any suggested actions before sharing them.
- The manual button is available before generation, while waiting, and after an
  error. It posts without generation, transcription, or background embedding calls.
  Voice-only users must type their details if transcription is unavailable.
- Existing voice intake still requires a separate transcription call. The browser
  does not attach the raw recording to the final report. This is not a meeting
  transcription or photo-analysis feature.

### Reporting without AI

- Bilingual starters for utilities, maintenance, sanitation, or another issue show
  questions, not invented complaint text. Choosing a starter never overwrites input.
- Optional location, duration, and impact fields are appended verbatim to the input
  and carried into the manual review. Unknown fields remain blank. The combined
  text is limited to 5,000 characters before either AI or manual review.
- The notebook saves only after explicit local-storage consent and a Save click.
  It stores one snapshot per resident/browser, including editable review text but
  no audio, AI suggestions, scores, group destination, or credentials. Restoring a
  review makes it a manual draft; review it again before posting.
- Local copies are not encrypted and are unsuitable for shared devices. They
  expire after seven days and are removed when next read, after successful posting,
  on explicit deletion, or at sign-out. Saving is not automatic. Storage failures
  are shown, and never prevent reporting. This is not offline submission or sync.

### AI availability and recovery

The application defaults to `PRAYAAS_MODEL_CHAIN=gemini-3.5-flash-lite,gemini-3.8-flash`.
Report generation and transcription use the first model, without provider-error
fallbacks. The chain remains for legacy RAG. A voice report normally needs one
transcription call plus one structured drafting call; a text report needs one.

On 2026-10-23 (Asia/Kolkata), a minimal generation request to the previously
configured `gemini-2.5-flash-lite` returned 404 although model metadata lookup
succeeded. The replacement model accepted generation. A synthetic spoken report
then completed transcription and bilingual structured generation in two calls,
with three actions and no posting, using an isolated temporary database. This is
a connectivity/contract smoke test, **not** a quality or comparative latency result.
Google documents restricted legacy 2.5 access and recommends current models for
new projects: https://ai.google.dev/gemini-api/docs/deprecations.
Historical benchmark artifacts and their pinned model have not been changed.

`GET /api/problems/ai-status` requires authentication and is not cached. It checks
local configuration, UTC daily budgets, and known provider failures, never the
provider. `eligible` means a request may be attempted, not that Gemini is healthy.
Quota reset and retry timestamps are local policy, not a promise of recovery.
The UI's Check status action costs no AI calls. Existing cached drafts can still
be returned during a cooldown, so the draft action remains available.

Text and voice share safe errors for credentials, unavailable models, quota,
rejected input, timeouts, and service outages. Provider response bodies/keys are
never returned or logged. `ai_provider_state` stores only an error category and
retry time under a credential/model fingerprint: ten minutes for configuration
errors, thirty seconds for transient errors, configured cooldown for quota.
A new key or model does not inherit a previous configuration failure. A bad
individual input (400) does not block other residents. New feature tables are
created at API startup by the existing metadata initialization.

### Search

`POST /api/insights/search` accepts `mode: "ai"` and a query, or `mode: "filters"`
and a filter object. It validates a strict Pydantic schema for status, the eight
Prayaas categories, location, up to four topic alternatives, inclusive start date,
exclusive end date, and sort order. Unknown keys, SQL, and invalid dates are rejected.
Fixed SQLAlchemy expressions execute those filters; model text is never SQL.

Residents see only ungrouped reports, public groups, groups they belong to, or their
own reports. Society administrators can see all reports. Interpretation is cached
for 15 minutes per user, but results and permissions are checked on every request.
The UI exposes interpreted filters for correction. Basic filters never call AI.
Dates use Asia/Kolkata; results are capped at 50 with a `has_more` indicator.

### Weekly committee draft

`GET /api/insights/digest` reads the last completed Monday-to-Monday week in
Asia/Kolkata. `POST` prepares it once. `PATCH /api/insights/digest/{week_start}`
requires the current revision and returns 409 rather than overwriting another edit.

The snapshot counts reports **created that week** and their statuses at preparation
time. It does not measure how many old reports were resolved during that week.
The model sees aggregate counts and up to five PII-masked issue titles/IDs, ranked
by severity and votes. Returned and inline source IDs are checked against that set.
Source validation does not prove that the prose is factually correct. The committee
must review it, including the equivalence of English and Hindi summaries.

An atomic database claim prevents concurrent runs from spending twice. On quota
errors, outages, invalid citations, or an empty week, a deterministic bilingual
counts-only draft remains available. A crashed job recovers to counts-only after
two minutes on the next read/run. Re-running never regenerates an existing week or
overwrites human edits. A draft has one normal generation attempt, plus at most one
schema retry. Nothing is emailed, published, or sent to a vendor automatically.

## Scheduling and migration

From `backend`, using the same environment and database as the API:

```sh
venv/bin/python -m scripts.weekly_digest
# Explicit zero-provider mode:
venv/bin/python -m scripts.weekly_digest --without-ai
```

The scheduler entrypoint is implemented, but **no host scheduler is installed by
this change**. Configure a deployment scheduler to run Mondays at 09:00
Asia/Kolkata (03:30 UTC). Example for a cron host whose timezone is UTC, replacing
the application path:

```cron
30 3 * * 1 cd /srv/prayaas/backend && /srv/prayaas/backend/venv/bin/python -m scripts.weekly_digest
```

Use a dedicated scheduler or container job, not a background timer inside every
API worker. SQLite development columns are added on API startup. Existing
PostgreSQL deployments must apply `backend/migrations/20261022_bilingual.sql`
before starting the new API. New feature tables are created by the existing
metadata initialization. Back up the database before production migration.

## Quota and cache behavior

`agent/structured.py` provides `structured_call(prompt, schema, ...)` with strict
validation, one schema-only retry, no provider-error retry, user-scoped hashed
cache keys, and cross-worker database leases. Normal generation timeout is 20
seconds per attempt. Concurrent identical requests wait for the first response.
Schema/model/prompt changes invalidate cached responses. Report TTL is 24 hours;
search TTL is 15 minutes; weekly generation TTL is eight days.

Call reservations survive restarts and do not depend on Redis. Defaults:

```dotenv
PRAYAAS_AI_DAILY_CALL_LIMIT=20
PRAYAAS_AI_USER_DAILY_CALL_LIMIT=10
PRAYAAS_AI_COOLDOWN_SECONDS=900
```

Budgets reset by UTC calendar day. Every provider attempt, including failed calls
and schema retries, reserves a call. A 429 starts a deployment-wide cooldown.
Scheduled digests consume the global budget; authenticated report/search/audio
requests also consume the per-user budget. Cache hits consume neither. These are
local caps, not a guarantee about a provider's actual quota or billing. Legacy RAG
and embedding operations are separate and not covered by this new call guard.
Optional semantic dedup/indexing can therefore add embedding calls to AI reports.
Manual posting and basic search remain independent of every provider.

## Privacy and evaluation

Application logs contain task, input hash prefix, model, timing, cache status, and
failure type, not raw prompts or outputs. Generation events retain usage/heuristic
metadata. Do not enable raw request-body logging at a proxy. Cache response bodies
contain generated text in the application database; they are not anonymized data.
Expired cache rows are removed on subsequent structured calls, not on a dedicated
retention timer. Apply database access controls, backup retention, and deletion
policies. Reports and saved committee drafts follow normal application retention.

Existing regex redaction handles common phone/email/Aadhaar/PAN/card/IFSC patterns.
It does **not** reliably remove names, addresses, flat numbers, faces, or private
details inside recordings. The voice interface warns that raw audio goes to the
provider before transcription can be redacted. Photo and meeting-audio expansion
is deferred until consent, EXIF removal, and face handling are implemented.

These logs do not become a labelled evaluation dataset automatically. Regression
fixtures and mocked responses are synthetic, not independent labels. No translation
adequacy, search accuracy, or real-world cost/latency improvement is claimed here.
Use consented, de-identified real complaints and blinded independent labelling for
quality claims. Heuristic confidence is not a probability of correctness or evidence
that an issue is resolved.

## Checks

```sh
cd backend
venv/bin/python -m unittest discover -s tests -v
cd ../frontend
npx tsc --noEmit
node --test tests/auth-recovery.test.mjs
npm run build
# With the local launcher running and Playwright installed:
node tests/features-smoke.mjs
```

Feature smoke tests use the real local manual-report/search APIs and mock AI output
for UI checks. They never call a live model and remove their uniquely named test
resident and report. `PLAYWRIGHT_MODULE` can point to a shared Playwright install.
