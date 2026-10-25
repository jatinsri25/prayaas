import argparse
import asyncio
import contextlib
import io
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import adapter
import benchmark
from common import LoopLagMonitor
import run_eval


class HarnessTests(unittest.IsolatedAsyncioTestCase):
    async def test_stall_monitor_observes_blocking_work(self):
        async with LoopLagMonitor() as monitor:
            time.sleep(0.06)
            await asyncio.sleep(0.02)
        self.assertGreater(monitor.max_ms, 40)

    async def test_missing_usage_and_prices_are_not_zero_cost(self):
        async def predict(text):
            return {"category": "Utilities", "severity": "High"}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result.json"
            args = argparse.Namespace(runs=2, concurrency=1, warmup=0, dataset=None,
                                      price_in=None, price_out=None, label="test", out=str(path))
            with patch.object(adapter, "run_pipeline", side_effect=predict), contextlib.redirect_stdout(io.StringIO()):
                await benchmark.run(args)
            result = json.loads(path.read_text())
        self.assertIsNone(result["tokens_per_report"])
        self.assertIsNone(result["cost_per_report_usd"])

    async def test_all_failures_still_write_results(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result.json"
            args = argparse.Namespace(runs=2, concurrency=1, warmup=0, dataset=None,
                                      price_in=None, price_out=None, label="failed", out=str(path))
            with patch.object(adapter, "run_pipeline", side_effect=ValueError("Failed draft")), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit):
                    await benchmark.run(args)
            result = json.loads(path.read_text())
        self.assertEqual(result["error_rate"], 1)
        self.assertIsNone(result["p50_s"])
        self.assertEqual(result["ok"], 0)

    async def test_taxonomy_checked_before_spending_provider_tokens(self):
        args = argparse.Namespace(dataset="data/sample_labelled.jsonl", concurrency=4)
        with patch.object(adapter, "MODE", "real"), patch.object(adapter, "prepare") as prepare:
            with self.assertRaisesRegex(ValueError, "taxonomy"):
                await run_eval.main_async(args)
            prepare.assert_not_called()

    async def test_stub_quality_evaluation_is_forbidden(self):
        with patch.object(adapter, "MODE", "stub"), patch.object(adapter, "prepare") as prepare:
            with self.assertRaisesRegex(ValueError, "cannot evaluate quality"):
                await run_eval.main_async(argparse.Namespace(dataset="data/sample_labelled.jsonl", concurrency=1))
            prepare.assert_not_called()

    def test_failed_runs_and_mismatched_settings_are_not_comparable(self):
        base = {"adapter_mode": "stub", "concurrency": 4, "runs": 8, "warmup": 0,
                "dataset_sha256": "same", "python": "same", "models": ["same-model"],
                "response_cache_policy": "cold", "stub_latency_ms": 80, "ok": 8, "error_rate": 0}
        with tempfile.TemporaryDirectory() as directory:
            a, b = Path(directory) / "a.json", Path(directory) / "b.json"
            a.write_text(json.dumps(base))
            for different in ({"ok": 0, "error_rate": 1}, {"warmup_errors": 1}, {"models": ["different-model"]},
                              {"stub_latency_ms": 20}, {"adapter_mode": "real"}, {"response_cache_policy": "natural"}):
                b.write_text(json.dumps({**base, **different}))
                with self.assertRaises(ValueError):
                    benchmark.compare(argparse.Namespace(before=str(a), after=str(b)))

    def test_nonfinite_stub_latency_is_rejected(self):
        from provider_stub import make_client
        for latency in (-1, float('nan'), float('inf'), 10001):
            with self.assertRaises(ValueError):
                make_client(latency, 4)

    def test_confidence_normalization(self):
        self.assertEqual(adapter._normalize({"category": "Utilities", "severity": "High", "confidence_score": 0.9})["confidence"], 0.9)

    def test_duplicate_cluster_scoring(self):
        rows = [{"id": "a", "duplicate_of": None}, {"id": "b", "duplicate_of": "a"},
                {"id": "c", "duplicate_of": "b"}]
        result = run_eval.eval_dedup(rows, [None, "a", "a"])
        self.assertEqual(result["tp"], 2)
        self.assertEqual(result["f1"], 1)


if __name__ == "__main__":
    unittest.main()
