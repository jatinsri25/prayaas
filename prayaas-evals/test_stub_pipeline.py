"""Offline integration tests against archived baseline code and the working tree."""
import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

import benchmark

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
BASELINE = "732c500cc8bd0ab3b2eeca935e46a68521852fae"


class StubPipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="prayaas-stub-test-")
        cls.addClassCleanup(cls.temp.cleanup)
        cls.directory = Path(cls.temp.name).resolve()
        # Export immutable tracked source, never edit a resident's checkout.
        archive = subprocess.run(["git", "-C", str(ROOT), "archive", BASELINE, "backend"], capture_output=True, check=True)
        with tarfile.open(fileobj=io.BytesIO(archive.stdout)) as tar:
            for entry in tar.getmembers():
                target = (cls.directory / entry.name).resolve()
                if cls.directory not in target.parents or not (entry.isdir() or entry.isfile()):
                    raise ValueError("Unsafe baseline archive member")
            tar.extractall(cls.directory)
        cls.old = cls.bench("old", cls.directory / "backend")
        cls.new = cls.bench("new", ROOT / "backend")

    @classmethod
    def bench(cls, label, backend, *, cache="cold", warmup=0):
        destination = cls.directory / f"{label}.json"
        command = [sys.executable, "benchmark.py", "run", "--mode", "stub", "--label", label,
                   "--runs", "8", "--concurrency", "4", "--warmup", str(warmup),
                   "--stub-latency-ms", "80", "--response-cache", cache,
                   "--price-in", "1", "--price-out", "1", "--out", str(destination)]
        result = subprocess.run(command, cwd=HERE, env={**os.environ, "PRAYAAS_BACKEND": str(backend), "GOOGLE_API_KEY": "must-not-be-used"},
                                capture_output=True, text=True, timeout=45)
        if result.returncode:
            raise AssertionError(result.stdout + result.stderr)
        return json.loads(destination.read_text())

    def test_successful_uncached_generation_calls_are_two_then_one(self):
        self.assertEqual(self.old["ok"], 8)
        self.assertEqual(self.new["ok"], 8)
        self.assertEqual(self.old["per_report_generation_calls"], [2] * 8)
        self.assertEqual(self.new["per_report_generation_calls"], [1] * 8)
        self.assertEqual(self.new["response_cache_hits"], 0)
        self.assertNotEqual(self.old["source_sha256"], self.new["source_sha256"])
        self.assertEqual(self.old["pinned_model"], self.new["pinned_model"])
        self.assertEqual(self.old["stub_latency_ms"], self.new["stub_latency_ms"])

    def test_concurrent_stub_work_keeps_new_loop_responsive(self):
        # A loose relative regression bound, not a production latency target.
        self.assertGreater(self.old["loop_stall_max_ms"], 8 * 2 * 80 * .8)
        self.assertLess(self.new["loop_stall_max_ms"], self.old["loop_stall_max_ms"] / 2)
        self.assertGreater(self.new["loop_stall_samples"], 1)

    def test_stub_cannot_claim_tokens_cost_or_network_usage(self):
        for result in (self.old, self.new):
            self.assertTrue(result["simulated"])
            self.assertEqual(result["stub_network_attempts"], 0)
            self.assertIsNone(result["tokens_per_report"])
            self.assertIsNone(result["cost_per_report_usd"])
            self.assertEqual(result["usage_coverage"], 0)
        self.assertGreater(self.old["embedding_calls"], 0)
        self.assertEqual(self.new["embedding_calls"], 0)

    def test_warmup_and_cache_hits_are_counted_separately(self):
        cold = self.bench("cold-warmup", ROOT / "backend", warmup=2)
        self.assertEqual(cold["warmup_generation_calls"], 2)
        self.assertEqual(cold["generation_calls"], 8)
        self.assertEqual(cold["generation_calls_including_warmup"], 10)
        natural = self.bench("natural-cache", ROOT / "backend", cache="natural", warmup=2)
        self.assertEqual(natural["generation_calls_including_warmup"], 5)
        self.assertEqual(natural["response_cache_hits"], 5)

    def test_successful_simulated_comparison_is_labelled(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            benchmark.compare(argparse.Namespace(before=str(self.directory / "old.json"), after=str(self.directory / "new.json")))
        self.assertIn("SIMULATED PROVIDER COMPARISON", output.getvalue())
        self.assertIn("generation calls / successful report | 2.0 | 1.0", output.getvalue())

    def test_network_guard_blocks_even_an_accidental_socket(self):
        result = subprocess.run([sys.executable, "-c", "import socket; from provider_stub import disable_network; disable_network(); socket.socket().connect(('127.0.0.1', 9))"],
                                cwd=HERE, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Networking is disabled", result.stderr)


if __name__ == "__main__":
    unittest.main()
