import asyncio
import copy
import json
import os
import tempfile
import time
import unittest
from threading import Event
from unittest.mock import patch, Mock

_sandbox = tempfile.TemporaryDirectory(prefix="prayaas-tests-")
os.environ["DATABASE_URL"] = "sqlite:///" + _sandbox.name + "/test.db"
os.environ.pop("GOOGLE_API_KEY", None)

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from database import Base, engine, SessionLocal
from agent import confidence_gate as gate, pipeline, dedup
from routers import problems
from auth import get_current_user
import schemas
import auth
from middleware import lockout
from agent import token_budget
import models

Base.metadata.create_all(engine)

DRAFT = {
    "title": "Repair corridor lights on the third floor of Block B",
    "category": "Maintenance", "severity": "Medium", "location": "Block B, third floor",
    "description_en": "Two corridor lights have stopped working. Residents have difficulty walking at night. An electrician should inspect them.",
    "description_hi": "गलियारे की दो लाइटें काम नहीं कर रही हैं। रात में चलने में परेशानी होती है। बिजली मिस्त्री से जांच कराएं।",
    "affected_residents": "Block B residents",
    "solutions": [{"action": "Arrange a qualified electrician to inspect the lights.",
                   "responsible_party": "Maintenance electrician", "timeline": "Within 24 hours", "priority": i}
                  for i in (1, 2, 3)],
}
USAGE = {"prompt_tokens": 100, "completion_tokens": 200}


class GateTests(unittest.TestCase):
    def run_gate(self, responses, **kwargs):
        with patch.object(gate, "_raw_call", side_effect=responses) as call:
            result = gate.gated_call("test report", task_type="report_draft",
                                     required_fields=pipeline.FORMAT_REQUIRED_FIELDS + ["solutions"],
                                     validate=lambda data: pipeline.DraftContent.model_validate(data).model_dump(),
                                     **kwargs)
        return result, call

    def test_single_call_and_real_usage(self):
        result, call = self.run_gate([(json.dumps(DRAFT), USAGE)])
        self.assertEqual(call.call_count, 1)
        self.assertTrue(result.auto_resolved)
        self.assertEqual(result.usage, USAGE)

    def test_malformed_solutions_escalate(self):
        invalid = {**DRAFT, "solutions": [{"action": "bad"}]}
        result, call = self.run_gate([(json.dumps(invalid), USAGE), (json.dumps(DRAFT), USAGE)])
        self.assertEqual(call.call_count, 2)
        self.assertEqual(result.escalations, 1)
        self.assertEqual(result.usage, {"prompt_tokens": 200, "completion_tokens": 400})

    def test_schema_rejects_bad_categories_priorities_and_blank_fields(self):
        for field, value in [("category", "water"), ("severity", "urgent"), ("title", "   ")]:
            with self.assertRaises(ValueError):
                pipeline.DraftContent.model_validate({**DRAFT, field: value})
        invalid = copy.deepcopy(DRAFT)
        invalid["solutions"][1]["priority"] = 1
        with self.assertRaises(ValueError):
            pipeline.DraftContent.model_validate(invalid)

    def test_best_valid_attempt_survives_later_failure(self):
        with patch.object(gate, "compute_confidence", return_value=0.6):
            result, call = self.run_gate([(json.dumps(DRAFT), USAGE), RuntimeError("unavailable key")])
        self.assertEqual(result.parsed, DRAFT)
        self.assertFalse(result.auto_resolved)
        self.assertIsNone(result.usage)  # Failed attempts have unknown provider usage.
        self.assertNotIn("unavailable key", str(result.errors))

    def test_cancelled_gate_makes_no_provider_call(self):
        cancelled = Event()
        cancelled.set()
        result, call = self.run_gate([], cancelled=cancelled)
        self.assertEqual(call.call_count, 0)
        self.assertIsNone(result.parsed)

    def test_deadline_stops_fallbacks(self):
        def slow(*args, **kwargs):
            time.sleep(0.03)
            return "invalid", USAGE
        with patch.object(gate, "_raw_call", side_effect=slow) as call, \
             patch.object(gate.time, "monotonic", side_effect=[0, 0, 41, 41, 41]):
            result = gate.gated_call("report", task_type="test", timeout_seconds=40)
        self.assertEqual(call.call_count, 1)
        self.assertFalse(result.auto_resolved)

    def test_empty_corrections_and_duplicate_candidates_skip_embedding(self):
        with patch.object(pipeline, "embed_text") as embedding:
            self.assertEqual(pipeline._retrieve_similar_corrections("report", "title"), [])
            embedding.assert_not_called()
        with SessionLocal() as db, patch.object(dedup, "embed_text") as embedding:
            self.assertEqual(dedup.find_duplicates(db, raw_text="report"), [])
            embedding.assert_not_called()

    def test_redis_clients_are_published_only_after_successful_ping(self):
        for module in (auth, lockout, token_budget):
            with self.subTest(module=module.__name__), patch.object(module, "_redis_client", None):
                client = Mock()
                client.ping.side_effect = lambda: self.assertIsNone(module._redis_client)
                with patch("redis.from_url", return_value=client) as connect:
                    self.assertIs(module._get_redis(), client)
                    self.assertEqual(connect.call_args.kwargs["socket_connect_timeout"], 1)


class PipelineTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        with SessionLocal.begin() as db:
            db.query(models.StructuredCache).delete()
            db.query(models.AICallBudget).delete()
            db.query(models.AIProviderState).delete()

    async def test_safety_single_call_and_responsive_loop(self):
        def slow(*args, **kwargs):
            time.sleep(0.12)
            return json.dumps(DRAFT), USAGE
        stages = []
        with patch.object(gate, "_raw_call", side_effect=slow) as call, \
             patch.object(pipeline, "has_budget", return_value=True), \
             patch.object(pipeline, "deduct_tokens") as deduct:
            task = asyncio.create_task(pipeline.run_ai_pipeline(
                "There is a fire in Block B. Email test@example.com.", user_id=1, on_progress=stages.append))
            ticks = 0
            while not task.done():
                await asyncio.sleep(0.01)
                ticks += 1
            result = await task
        self.assertGreaterEqual(ticks, 5)
        self.assertEqual(call.call_count, 1)
        self.assertNotIn("test@example.com", call.call_args.args[1])
        self.assertEqual(result["severity"], "High")
        self.assertEqual(stages, ["preparing", "generating"])
        deduct.assert_called_once_with(1, 300)

    async def test_budget_rejected_before_provider(self):
        with patch.object(pipeline, "has_budget", return_value=False), patch.object(gate, "_raw_call") as call:
            with self.assertRaises(HTTPException) as raised:
                await pipeline.run_ai_pipeline("Please repair the corridor lights", user_id=1)
            self.assertEqual(raised.exception.status_code, 429)
            call.assert_not_called()

    async def test_invalid_provider_result_is_not_a_fake_success(self):
        with patch.object(gate, "_raw_call", return_value=("not json", USAGE)):
            with self.assertRaises(HTTPException) as raised:
                await pipeline.run_ai_pipeline("Please repair the corridor lights")
            self.assertEqual(raised.exception.status_code, 503)

    async def test_cancel_prevents_later_provider_attempts(self):
        started = Event()
        def slow(*args, **kwargs):
            started.set()
            time.sleep(0.1)
            return "invalid", USAGE
        with patch.object(gate, "_raw_call", side_effect=slow) as call:
            task = asyncio.create_task(pipeline.run_ai_pipeline("Corridor lights broken"))
            await asyncio.to_thread(started.wait, 1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            await asyncio.sleep(0.15)
            self.assertEqual(call.call_count, 1)


class StreamTests(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI()
        self.app.include_router(problems.router)
        self.app.dependency_overrides[get_current_user] = lambda: Mock(id=1)
        self.client = TestClient(self.app)

    def test_actual_stage_events_and_complete_draft(self):
        async def run(text, user_id, on_progress):
            on_progress("preparing")
            on_progress("generating")
            return {**DRAFT, "raw_input": text}
        with patch.object(problems, "run_ai_pipeline", side_effect=run), \
             patch.object(problems, "_finish_report", return_value=schemas.AIProblemDraft(**DRAFT, formatted_description=DRAFT["description_en"])):
            response = self.client.post("/api/problems/process/stream", data={"raw_text": "Lights broken"})
        events = [json.loads(line) for line in response.text.splitlines()]
        self.assertEqual(response.status_code, 200)
        self.assertEqual([e["stage"] for e in events if e["type"] == "progress"],
                         ["received", "preparing", "generating", "checking"])
        self.assertEqual(events[-1]["draft"]["title"], DRAFT["title"])

    def test_stream_errors_are_explicit_and_json_endpoint_is_compatible(self):
        with patch.object(problems, "run_ai_pipeline", side_effect=HTTPException(429, "Daily limit reached")):
            stream = self.client.post("/api/problems/process/stream", data={"raw_text": "Lights broken"})
            response = self.client.post("/api/problems/process", data={"raw_text": "Lights broken"})
        self.assertEqual(json.loads(stream.text.splitlines()[-1]),
                         {"type": "error", "status": 429, "detail": "Daily limit reached"})
        self.assertEqual(response.status_code, 429)

    def test_bad_input_fails_before_stream_starts(self):
        for text in ("", "a" * 5001):
            response = self.client.post("/api/problems/process/stream", data={"raw_text": text})
            self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
