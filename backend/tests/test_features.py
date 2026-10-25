"""Synthetic regression fixtures, NOT a labelled AI quality evaluation."""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import patch, Mock

# This module sets a temporary DB and removes provider credentials before imports.
from test_pipeline import DRAFT, USAGE
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from database import Base, engine, SessionLocal
from auth import get_current_user
from agent import confidence_gate as gate, pipeline, structured, digest, availability
from agent.search import SearchFilters, apply_filters, interpret_query
from routers import problems, insights
import models


class FeatureTests(unittest.TestCase):
    def setUp(self):
        assert "prayaas-tests-" in engine.url.database
        Base.metadata.drop_all(engine)
        Base.metadata.create_all(engine)
        with SessionLocal.begin() as db:
            db.add_all([models.User(id=i, name=f"Test {i}", email=f"test{i}@example.com", flat_number="Test",
                                   hashed_password="unused", role=role) for i, role in [(1, "resident"), (2, "resident"), (3, "society_admin")]])
        self.app = FastAPI()
        self.app.include_router(problems.router)
        self.app.include_router(insights.router)
        self.as_user(1)
        self.client = TestClient(self.app)

    def tearDown(self):
        Base.metadata.drop_all(engine)
        Base.metadata.create_all(engine)

    def as_user(self, user_id):
        with SessionLocal() as db:
            user = db.get(models.User, user_id)
            db.expunge(user)
        self.user = user
        self.app.dependency_overrides[get_current_user] = lambda: user

    def problem(self, title="Water pipe leaking", **kwargs):
        with SessionLocal.begin() as db:
            row = models.Problem(title=title, formatted_description="Water leak by the gate",
                description_en="Water leak by the gate", description_hi="गेट पर पानी का रिसाव",
                author_id=kwargs.pop("author_id", 1), category=kwargs.pop("category", "Utilities"),
                status=kwargs.pop("status", "Open"), severity="Medium", location="Wing B", **kwargs)
            db.add(row)
            db.flush()
            return row.id

    def draft_call(self, prompt="A report", user_id=1):
        return structured.structured_call(prompt, pipeline.DraftContent, task_type="test", user_id=user_id)

    def test_bilingual_one_call_cached_and_user_scoped(self):
        with patch.object(gate, "_raw_call", return_value=(json.dumps(DRAFT), USAGE)) as call:
            first = self.draft_call("Contact test@example.com about the lights")
            with patch.dict(os.environ, {"PRAYAAS_AI_DAILY_CALL_LIMIT": "0"}):
                cached = self.draft_call("Contact test@example.com about the lights")
            self.assertEqual(call.call_count, 1)
            self.assertNotIn("test@example.com", call.call_args.args[1])
            self.assertTrue(cached.cache_hit)
            self.assertEqual(cached.usage["completion_tokens"], 0)
            self.assertEqual(first.parsed["description_hi"], DRAFT["description_hi"])
            self.draft_call("Contact test@example.com about the lights", 2)
            self.assertEqual(call.call_count, 2)

    def test_retry_only_on_schema_failure_and_only_once(self):
        invalid = {**DRAFT, "description_hi": "This is not Hindi"}
        with patch.object(gate, "_raw_call", side_effect=[(json.dumps(invalid), USAGE), (json.dumps(DRAFT), USAGE)]) as call:
            result = self.draft_call()
            self.assertEqual(call.call_count, 2)
            self.assertEqual(result.escalations, 1)
        with patch.object(gate, "_raw_call", return_value=("not json", USAGE)) as call:
            with self.assertRaises(HTTPException):
                self.draft_call("another report")
            self.assertEqual(call.call_count, 2)
        with patch.object(gate, "_raw_call", side_effect=TimeoutError("timeout")) as call:
            with self.assertRaises(HTTPException):
                self.draft_call("network failure")
            self.assertEqual(call.call_count, 1)

    def test_concurrent_identical_inputs_spend_one_call(self):
        def response(*args, **kwargs):
            time.sleep(.15)
            return json.dumps(DRAFT), USAGE
        with patch.object(gate, "_raw_call", side_effect=response) as call, ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.draft_call(), range(4)))
        self.assertEqual(call.call_count, 1)
        self.assertEqual(sum(result.cache_hit for result in results), 3)

    def test_atomic_budget_without_redis_and_rollback_on_user_limit(self):
        def reserve(_):
            try:
                structured.reserve_call()
                return True
            except HTTPException:
                return False
        with patch.dict(os.environ, {"PRAYAAS_AI_DAILY_CALL_LIMIT": "2"}), ThreadPoolExecutor(max_workers=6) as pool:
            self.assertEqual(sum(pool.map(reserve, range(8))), 2)
        with SessionLocal.begin() as db:
            db.query(models.AICallBudget).delete()
        with patch.dict(os.environ, {"PRAYAAS_AI_USER_DAILY_CALL_LIMIT": "1"}):
            structured.reserve_call(1)
            with self.assertRaises(HTTPException):
                structured.reserve_call(1)
        with SessionLocal() as db:
            self.assertEqual(db.query(models.AICallBudget).filter(models.AICallBudget.key.like("global:%")).one().calls, 1)

    def test_provider_quota_sets_cooldown_without_extra_model_calls(self):
        class QuotaError(Exception):
            code = 429
        with patch.object(gate, "_raw_call", side_effect=QuotaError("RESOURCE_EXHAUSTED")) as call:
            for text in ["first report", "different report"]:
                with self.assertRaises(HTTPException) as error:
                    self.draft_call(text)
                self.assertEqual(error.exception.status_code, 429)
            self.assertEqual(call.call_count, 1)

    def test_provider_errors_are_safe_specific_and_not_retried(self):
        for status, code in [(400, "request_rejected"), (401, "credentials"), (403, "credentials"),
                             (404, "model_unavailable"), (429, "quota"), (503, "unavailable"), (504, "timeout")]:
            with self.subTest(status=status):
                with SessionLocal.begin() as db:
                    db.query(models.AIProviderState).delete()
                    db.query(models.AICallBudget).delete()
                error = RuntimeError("private-provider-response-with-secret")
                error.code = status
                with patch.object(gate, "_raw_call", side_effect=error) as call:
                    with self.assertRaises(HTTPException) as result:
                        self.draft_call(str(status))
                    self.assertEqual(result.exception.detail, availability.MESSAGES[code])
                    self.assertNotIn("secret", result.exception.detail)
                    self.assertEqual(call.call_count, 1)
                if status != 400:
                    with patch.object(gate, "_raw_call") as call:
                        with self.assertRaises(HTTPException):
                            self.draft_call("a different report")
                        call.assert_not_called()
                else:
                    self.assertIsNone(availability.known_failure(gate.MODEL_CHAIN[0]))

    def test_cached_report_survives_provider_failure_and_expiry_allows_recovery(self):
        with patch.object(gate, "_raw_call", return_value=(json.dumps(DRAFT), USAGE)):
            self.draft_call("cached report")
        error = RuntimeError("model missing")
        error.code = 404
        availability.provider_error(error, gate.MODEL_CHAIN[0])
        with patch.object(gate, "_raw_call") as call:
            self.assertTrue(self.draft_call("cached report").cache_hit)
            call.assert_not_called()
        with patch.dict(os.environ, {"GOOGLE_API_KEY": "replacement-test-key"}):
            self.assertIsNone(availability.known_failure(gate.MODEL_CHAIN[0]))
        self.assertIsNone(availability.known_failure("different-model"))
        with SessionLocal.begin() as db:
            db.query(models.AIProviderState).update({"retry_at": datetime.utcnow() - timedelta(seconds=1)})
        with patch.object(gate, "_raw_call", return_value=(json.dumps(DRAFT), USAGE)) as call:
            self.assertFalse(self.draft_call("new report").cache_hit)
            self.assertEqual(call.call_count, 1)

    def test_concurrent_provider_failures_upsert_one_local_state(self):
        error = RuntimeError('provider unavailable')
        error.code = 503
        with ThreadPoolExecutor(max_workers=4) as pool:
            errors = list(pool.map(lambda _: availability.provider_error(error, gate.MODEL_CHAIN[0]), range(8)))
        self.assertTrue(all(item.status_code == 503 for item in errors))
        with SessionLocal() as db:
            self.assertEqual(db.query(models.AIProviderState).count(), 1)

    def test_local_status_never_calls_provider_or_claims_it_is_healthy(self):
        with patch.object(gate, "_raw_call") as call, patch.object(pipeline, "_client") as audio:
            response = self.client.get('/api/problems/ai-status')
            self.assertEqual(response.json()['code'], 'unconfigured')
            self.assertEqual(response.headers['cache-control'], 'no-store')
            with patch.dict(os.environ, {"GOOGLE_API_KEY": "synthetic-key"}):
                status = self.client.get('/api/problems/ai-status').json()
                self.assertEqual(status['code'], 'eligible')
                self.assertIn('only when', status['message'])
                with patch.dict(os.environ, {"PRAYAAS_AI_USER_DAILY_CALL_LIMIT": "0"}):
                    status = self.client.get('/api/problems/ai-status').json()
                    self.assertEqual(status['code'], 'daily_limit')
                    self.assertFalse(status['can_attempt'])
                    self.assertTrue(status['retry_at'].endswith('Z'))
                error = RuntimeError('bad key')
                error.code = 403
                availability.provider_error(error, gate.MODEL_CHAIN[0])
                status = self.client.get('/api/problems/ai-status').json()
                self.assertEqual(status['code'], 'credentials')
                self.assertNotIn('synthetic-key', json.dumps(status))
            call.assert_not_called()
            audio.models.generate_content.assert_not_called()
        self.app.dependency_overrides.clear()
        self.assertIn(self.client.get('/api/problems/ai-status').status_code, (401, 403))

    def test_audio_failure_reaches_stream_and_manual_post_still_works(self):
        error = RuntimeError("private-model-response")
        error.code = 404
        provider = Mock()
        provider.models.generate_content.side_effect = error
        with patch.object(pipeline, "_client", provider), patch.object(problems, "validate_audio_file"), patch.object(gate, "_raw_call") as generate:
            for endpoint in ('/api/problems/process/stream', '/api/problems/process'):
                response = self.client.post(endpoint, files={'audio': ('recording.webm', b'synthetic', 'audio/webm')})
                if endpoint.endswith('/stream'):
                    event = json.loads(response.text.splitlines()[-1])
                    self.assertEqual(event['type'], 'error')
                    self.assertEqual(event['detail'], availability.MESSAGES['model_unavailable'])
                else:
                    self.assertEqual(response.status_code, 503)
                    self.assertEqual(response.json()['detail'], availability.MESSAGES['model_unavailable'])
            self.assertEqual(provider.models.generate_content.call_count, 1)
            generate.assert_not_called()
            posted = self.client.post('/api/problems', data={
                'title': 'Corridor lights need repair', 'formatted_description': 'The corridor is dark.',
                'drafting_mode': 'manual', 'category': 'Maintenance', 'severity': 'Medium',
            })
            self.assertEqual(posted.status_code, 200, posted.text)
            generate.assert_not_called()

    def test_expired_cache_is_regenerated_and_old_body_removed(self):
        with patch.object(gate, "_raw_call", return_value=(json.dumps(DRAFT), USAGE)) as call:
            self.draft_call()
            with SessionLocal.begin() as db:
                db.query(models.StructuredCache).update({"expires_at": datetime.utcnow() - timedelta(seconds=1)})
            self.assertFalse(self.draft_call().cache_hit)
            self.assertEqual(call.call_count, 2)
        with SessionLocal() as db:
            self.assertEqual(db.query(models.StructuredCache).count(), 1)

    def test_private_corrections_never_become_another_residents_prompt(self):
        with SessionLocal.begin() as db:
            db.add(models.Group(id=1, name="Private", created_by=2, is_public=False))
        hidden = self.problem(author_id=2, group_id=1)
        with SessionLocal.begin() as db:
            db.add(models.AICorrection(problem_id=hidden, admin_id=2, field_name="title",
                original_value="Private original", corrected_value="Private correction", embedding_json="[1, 0]"))
        with patch.object(pipeline, "embed_text", return_value=[1, 0]) as embed:
            self.assertEqual(pipeline._retrieve_similar_corrections("water", "title", user_id=1), [])
            embed.assert_not_called()
            self.assertEqual(pipeline._retrieve_similar_corrections("water", "title", user_id=2), [("Private original", "Private correction")])

    def test_stale_digest_recovers_without_provider_call(self):
        now = datetime(2026, 10, 22, tzinfo=timezone.utc)
        first = digest.generate_digest(now=now, use_ai=False)
        with SessionLocal.begin() as db:
            db.query(models.WeeklyDigest).update({"generation_mode": "preparing", "created_at": datetime.utcnow() - timedelta(minutes=3)})
        with patch.object(gate, "_raw_call") as call:
            recovered = digest.generate_digest(now=now)
            self.assertEqual(recovered['generation_mode'], 'counts_only')
            self.assertEqual(recovered['summary_hi'], first['summary_hi'])
            call.assert_not_called()

    def test_scheduler_entrypoint_is_repeatable_without_ai(self):
        with tempfile.TemporaryDirectory(prefix="prayaas-digest-cli-") as directory:
            env = {**os.environ, "DATABASE_URL": f"sqlite:///{directory}/test.db", "GOOGLE_API_KEY": ""}
            command = [sys.executable, "-m", "scripts.weekly_digest", "--without-ai"]
            results = [subprocess.run(command, cwd=Path(__file__).resolve().parents[1], env=env,
                capture_output=True, text=True, timeout=30) for _ in range(2)]
            for result in results:
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("mode=counts_only; nothing sent", result.stdout)
            self.assertEqual(results[0].stdout, results[1].stdout)

    def test_manual_hindi_post_works_with_zero_quota_and_masks_pii(self):
        with patch.dict(os.environ, {"PRAYAAS_AI_DAILY_CALL_LIMIT": "0"}), patch.object(gate, "_raw_call") as call, patch.object(problems, "_index_problem") as index:
            result = self.client.post('/api/problems', data={
                "title": "गेट के पास पानी का रिसाव", "formatted_description": "पानी बह रहा है। test@example.com",
                "description_hi": "पानी बह रहा है। test@example.com", "raw_input": "पानी बह रहा है। test@example.com",
                "input_language": "hi", "drafting_mode": "manual", "category": "Utilities", "severity": "Medium",
            })
            self.assertEqual(result.status_code, 200, result.text)
            self.assertNotIn("test@example.com", result.json()["raw_input"])
            self.assertEqual(result.json()["drafting_mode"], "manual")
            self.assertIsNone(result.json()["last_model_used"])
            call.assert_not_called()
            index.assert_not_called()
        for payload in [{"title": "", "formatted_description": "x"}, {"title": "x", "formatted_description": "y", "category": "water"}]:
            self.assertEqual(self.client.post('/api/problems', data=payload).status_code, 422)

    def test_search_scoping_dates_and_wildcards(self):
        match = self.problem(created_at=datetime(2026, 10, 1))
        self.problem(title="Old water report", created_at=datetime(2026, 9, 29))
        with SessionLocal.begin() as db:
            db.add(models.Group(id=1, name="Private", created_by=2, is_public=False))
        hidden = self.problem(title="Private water report", author_id=2, group_id=1, created_at=datetime(2026, 10, 2))
        filters = SearchFilters(status="Open", keywords=["water", "पानी"], location="Wing B", created_after="2026-10-01", created_before="2026-11-01")
        with SessionLocal() as db:
            self.assertEqual([row.id for row in apply_filters(db, self.user, filters)], [match])
            self.assertEqual(apply_filters(db, self.user, SearchFilters(keywords=["%"])), [])
        self.assertEqual(self.client.get(f'/api/problems/{hidden}').status_code, 404)
        self.assertNotIn(hidden, [row['id'] for row in self.client.get('/api/problems').json()])
        with patch.object(gate, "_raw_call") as call:
            basic = self.client.post('/api/insights/search', json={"mode": "filters", "filters": filters.model_dump(mode="json")})
            self.assertEqual(basic.status_code, 200, basic.text)
            self.assertEqual([row['id'] for row in basic.json()['results']], [match])
            call.assert_not_called()

    def test_search_never_accepts_sql_or_extra_keys(self):
        with self.assertRaises(ValueError):
            SearchFilters.model_validate({"sql": "DROP TABLE users"})
        with self.assertRaises(ValueError):
            SearchFilters.model_validate({"status": "All", "created_after": "bad"})
        result = self.client.post('/api/insights/search', json={"mode": "filters", "filters": {"sql": "SELECT * FROM users"}})
        self.assertEqual(result.status_code, 422)
        with patch.object(gate, "_raw_call", return_value=(json.dumps({"sql": "DELETE FROM users"}), USAGE)):
            result = self.client.post('/api/insights/search', json={"query": "show all reports"})
            self.assertEqual(result.status_code, 503)
        with SessionLocal() as db:
            self.assertEqual(db.query(models.User).count(), 3)

    def test_search_cache_does_not_cache_results_or_permissions(self):
        filters = SearchFilters(keywords=["water"])
        with patch.object(gate, "_raw_call", return_value=(filters.model_dump_json(), USAGE)) as call:
            first = self.client.post('/api/insights/search', json={"query": "water reports"}).json()
            self.problem()
            second = self.client.post('/api/insights/search', json={"query": "water reports"}).json()
            self.assertEqual(first["results"], [])
            self.assertEqual(len(second["results"]), 1)
            self.assertTrue(second["cache_hit"])
            self.assertEqual(call.call_count, 1)

    def test_weekly_digest_boundaries_one_call_and_edit_conflict(self):
        now = datetime(2026, 10, 22, tzinfo=timezone.utc)
        self.assertEqual(tuple(map(str, digest.completed_week(now))), ("2026-10-12", "2026-10-19"))
        source_id = self.problem(created_at=datetime(2026, 10, 14))
        self.problem(title="Next week", created_at=datetime(2026, 10, 18, 18, 30))  # Monday midnight IST
        response = {"summary_en": f"Review the water report [#{source_id}].", "summary_hi": f"पानी की रिपोर्ट देखें [#{source_id}]।", "source_ids": [source_id]}
        self.as_user(3)
        with patch.object(gate, "_raw_call", return_value=(json.dumps(response), USAGE)) as call:
            first = digest.generate_digest(3, now=now)
            second = digest.generate_digest(3, now=now)
            self.assertEqual(call.call_count, 1)
            self.assertEqual(first, second)
            self.assertEqual(first['snapshot']['total'], 1)
        edit = {"summary_en": "Reviewed by the committee", "summary_hi": "समिति ने समीक्षा की", "revision": 1}
        updated = self.client.patch('/api/insights/digest/2026-10-12', json=edit)
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()['revision'], 2)
        self.assertEqual(self.client.patch('/api/insights/digest/2026-10-12', json=edit).status_code, 409)
        with patch.object(gate, "_raw_call") as call:
            self.assertEqual(digest.generate_digest(now=now)['summary_en'], edit['summary_en'])
            call.assert_not_called()
        self.as_user(1)
        self.assertEqual(self.client.get('/api/insights/digest').status_code, 403)
        self.assertEqual(self.client.post('/api/insights/digest').status_code, 403)
        self.assertEqual(self.client.patch('/api/insights/digest/2026-10-12', json=edit).status_code, 403)

    def test_digest_quota_fallback_and_no_fabricated_sources(self):
        now = datetime(2026, 10, 22, tzinfo=timezone.utc)
        source_id = self.problem(created_at=datetime(2026, 10, 14))
        with patch.dict(os.environ, {"PRAYAAS_AI_DAILY_CALL_LIMIT": "0"}), patch.object(gate, "_raw_call") as call:
            result = digest.generate_digest(now=now)
            self.assertEqual(result['generation_mode'], 'counts_only')
            self.assertEqual(result['source_ids'], [source_id])
            call.assert_not_called()
        with SessionLocal.begin() as db:
            db.query(models.WeeklyDigest).delete()
        invalid = {"summary_en": "Fixed by vendor [#9999]", "summary_hi": "ठीक हुआ [#9999]", "source_ids": [9999]}
        with patch.object(gate, "_raw_call", return_value=(json.dumps(invalid), USAGE)):
            result = digest.generate_digest(now=now)
            self.assertEqual(result['generation_mode'], 'counts_only')
            self.assertNotIn('9999', result['summary_en'])

    def test_concurrent_digest_does_not_spend_twice(self):
        now = datetime(2026, 10, 22, tzinfo=timezone.utc)
        source_id = self.problem(created_at=datetime(2026, 10, 14))
        def response(*args, **kwargs):
            time.sleep(.15)
            return json.dumps({"summary_en": "Review the week.", "summary_hi": "सप्ताह की समीक्षा करें।", "source_ids": [source_id]}), USAGE
        with patch.object(gate, "_raw_call", side_effect=response) as call, ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(lambda _: digest.generate_digest(now=now), range(3)))
            self.assertEqual(call.call_count, 1)

    def test_correction_clears_stale_translation_without_ai_call(self):
        issue = self.problem()
        self.assertEqual(self.client.patch(f'/api/problems/{issue}/ai-fields', json={"title": "<b></b>"}).status_code, 422)
        with patch.object(problems, "embed_text") as embed:
            result = self.client.patch(f'/api/problems/{issue}/ai-fields', json={"formatted_description": "The leak was at the side gate."})
            self.assertEqual(result.status_code, 200, result.text)
            self.assertIsNone(result.json()['description_hi'])
            self.assertEqual(result.json()['description_en'], "The leak was at the side gate.")
            embed.assert_not_called()


if __name__ == '__main__':
    unittest.main()
