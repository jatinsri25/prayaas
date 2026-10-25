"""Shared helpers: stats, dataset loading, bounded concurrency, event-loop lag monitor."""
import asyncio
import json
import math
import time

SEVERITY_ORDER = {"low": 0, "medium": 1, "high": 2, "critical": 3}
SEVERITY_ALIASES = {"moderate": "medium", "urgent": "critical", "severe": "critical", "minor": "low"}


def percentile(values, p):
    if not values:
        return float("nan")
    s = sorted(values)
    k = (len(s) - 1) * p / 100
    lo, hi = math.floor(k), math.ceil(k)
    if lo == hi:
        return s[int(k)]
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def load_jsonl(path):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith("#"):
                rows.append(json.loads(line))
    return rows


def norm_label(value):
    return str(value or "").strip().lower()


def norm_severity(value):
    """Return an int 0..3, or None if the value is missing or unrecognised."""
    v = norm_label(value)
    v = SEVERITY_ALIASES.get(v, v)
    return SEVERITY_ORDER.get(v)


async def bounded_map(fn, items, concurrency):
    """Run fn over items with a concurrency cap. Exceptions become {'_error': repr}."""
    if concurrency < 1:
        raise ValueError("Concurrency must be positive")
    sem = asyncio.Semaphore(concurrency)

    async def one(x):
        async with sem:
            try:
                return await fn(x)
            except Exception as exc:  # noqa: BLE001
                return {"_error": repr(exc)}

    return await asyncio.gather(*(one(x) for x in items))


class LoopLagMonitor:
    """Samples event-loop scheduling delay. A blocked loop shows up as large lag.

    This is the number that proves "I moved blocking I/O off the event loop".
    """

    def __init__(self, interval=0.01):
        self.interval = interval
        self.lags = []
        self._task = None

    async def _run(self):
        while True:
            t0 = time.perf_counter()
            await asyncio.sleep(self.interval)
            self.lags.append(max(0.0, time.perf_counter() - t0 - self.interval))

    async def __aenter__(self):
        self._task = asyncio.create_task(self._run())
        await asyncio.sleep(0)  # Arm the timer before a blocking pipeline can run.
        return self

    async def __aexit__(self, *exc):
        await asyncio.sleep(0)  # Record a timer that became overdue during the final call.
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass

    @property
    def max_ms(self):
        return max(self.lags, default=0.0) * 1000

    @property
    def p99_ms(self):
        return percentile(self.lags, 99) * 1000 if self.lags else 0.0
