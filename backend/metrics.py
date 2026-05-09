"""
Prayaas Prometheus Metrics

Exposes application-level metrics for Grafana dashboards.
"""

try:
    from prometheus_client import Counter, Histogram, Gauge, generate_latest, CONTENT_TYPE_LATEST
    _HAS_PROMETHEUS = True
except ImportError:
    _HAS_PROMETHEUS = False


if _HAS_PROMETHEUS:
    # ── Auth Metrics ─────────────────────────────────────────────────────────
    auth_attempts_total = Counter(
        "prayaas_auth_attempts_total",
        "Total authentication attempts",
        ["method", "status"],  # method=login|register, status=success|failure
    )

    # ── AI Pipeline Metrics ──────────────────────────────────────────────────
    ai_calls_total = Counter(
        "prayaas_ai_calls_total",
        "Total AI pipeline calls",
        ["status"],  # status=success|failure|blocked
    )

    ai_latency = Histogram(
        "prayaas_ai_latency_seconds",
        "AI pipeline latency in seconds",
        buckets=[0.5, 1, 2, 5, 10, 30, 60, 120],
    )

    # ── Security Metrics ─────────────────────────────────────────────────────
    injection_attempts = Counter(
        "prayaas_injection_attempts_total",
        "Prompt injection attempts detected",
    )

    token_budget_hits = Counter(
        "prayaas_token_budget_exhaustions_total",
        "Users hitting their daily AI token budget",
    )

    pii_redactions = Counter(
        "prayaas_pii_redactions_total",
        "PII entities redacted from AI inputs",
        ["entity_type"],
    )

    # ── Application Metrics ──────────────────────────────────────────────────
    active_users = Gauge(
        "prayaas_active_users",
        "Currently active users (approximate)",
    )

    http_requests_total = Counter(
        "prayaas_http_requests_total",
        "Total HTTP requests",
        ["method", "path", "status"],
    )

else:
    # Stub metrics for when prometheus_client is not installed
    class _NoopMetric:
        def inc(self, *a, **kw): pass
        def dec(self, *a, **kw): pass
        def observe(self, *a, **kw): pass
        def set(self, *a, **kw): pass
        def labels(self, *a, **kw): return self

    auth_attempts_total = _NoopMetric()
    ai_calls_total = _NoopMetric()
    ai_latency = _NoopMetric()
    injection_attempts = _NoopMetric()
    token_budget_hits = _NoopMetric()
    pii_redactions = _NoopMetric()
    active_users = _NoopMetric()
    http_requests_total = _NoopMetric()


def get_metrics_response():
    """Generate Prometheus metrics response for scraping endpoint."""
    if _HAS_PROMETHEUS:
        from starlette.responses import Response
        return Response(
            content=generate_latest(),
            media_type=CONTENT_TYPE_LATEST,
        )
    return {"detail": "Prometheus not available"}
