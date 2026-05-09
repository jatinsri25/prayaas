'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import SharedNav from '@/components/SharedNav';
import { adminApi, extractError } from '@/lib/api';
import { initAuth, loadUserFromStorage } from '@/lib/auth';
import s from '@/components/shared.module.css';
import a from './admin.module.css';

interface FeedbackMetrics {
  auto_resolution_rate: number;
  total_events: number;
  total_corrections: number;
  escalation_rate: number;
  avg_confidence: number;
  avg_latency_ms: number;
  by_task: Record<string, { count: number; auto_resolved: number; avg_confidence: number; auto_rate?: number }>;
  by_model: Record<string, { count: number; auto_resolved: number; avg_confidence: number; auto_rate?: number }>;
  correction_trends_7d: Array<{ date: string; count: number }>;
}

interface Correction {
  id: number;
  problem_id: number;
  field_name: string;
  original_value: string | null;
  corrected_value: string | null;
  model_used: string | null;
  original_confidence: number | null;
  ts: string;
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const fmtTs = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

function ratingClass(rate: number) {
  if (rate >= 0.85) return a.good;
  if (rate >= 0.65) return a.warn;
  return a.bad;
}

export default function AdminFeedbackPage() {
  const router = useRouter();
  const [authReady, setAuthReady] = useState(false);
  const [metrics, setMetrics] = useState<FeedbackMetrics | null>(null);
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [recomputing, setRecomputing] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [m, c] = await Promise.all([
        adminApi.getFeedbackMetrics(30),
        adminApi.listRecentCorrections(20),
      ]);
      setMetrics(m.data);
      setCorrections(c.data);
    } catch (err) {
      setError(extractError(err, 'Failed to load admin metrics. You may need group_admin role or higher.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const boot = async () => {
      const stored = loadUserFromStorage();
      if (!stored) {
        router.push('/login');
        return;
      }
      await initAuth();
      setAuthReady(true);
    };
    boot();
  }, [router]);

  useEffect(() => {
    if (authReady) void loadAll();
  }, [authReady, loadAll]);

  const handleRecompute = async () => {
    setRecomputing(true);
    try {
      await adminApi.recomputeTrustScores();
      await loadAll();
    } catch (err) {
      setError(extractError(err, 'Failed to recompute trust scores.'));
    } finally {
      setRecomputing(false);
    }
  };

  const trendMax = metrics
    ? Math.max(1, ...metrics.correction_trends_7d.map((d) => d.count))
    : 1;

  return (
    <main className={s.page}>
      <SharedNav active="admin" />

      <section className={a.heroBand}>
        <div className={a.heroBandInner}>
          <span className={a.heroEyebrow}>Confidence-gated AI · ML Feedback Loop</span>
          <h1 className={a.heroTitle}>AI Operations</h1>
          <p className={a.heroSub}>
            Live telemetry from the confidence-gated pipeline. Every Gemini call is scored
            for output confidence and escalated through a fallback chain when the score
            falls below the auto-resolve threshold. Admin corrections become the next
            generation&apos;s few-shot training signal.
          </p>
        </div>
      </section>

      {error && (
        <div className={s.container} style={{ maxWidth: 1180, marginTop: 12 }}>
          <div className={s.errorBlock}>{error}</div>
        </div>
      )}

      {loading && !metrics ? (
        <div style={{ minHeight: 240, display: 'grid', placeItems: 'center' }}>
          <span className={s.spinner} />
        </div>
      ) : metrics ? (
        <>
          {/* Headline KPI row */}
          <section className={a.headlineRow}>
            <article className={`${a.kpiCard} ${a.headline}`}>
              <span className={a.kpiLabel}>Auto-resolution rate</span>
              <span className={`${a.kpiValue} ${a.success}`}>{pct(metrics.auto_resolution_rate)}</span>
              <small className={a.kpiSub}>
                {metrics.total_events} pipeline calls in the last 30 days
              </small>
            </article>

            <article className={a.kpiCard}>
              <span className={a.kpiLabel}>Avg confidence</span>
              <span className={a.kpiValue}>{(metrics.avg_confidence * 100).toFixed(0)}<small style={{ fontSize: 16, opacity: 0.6 }}>/100</small></span>
              <small className={a.kpiSub}>
                Threshold for auto-resolve: 78
              </small>
            </article>

            <article className={a.kpiCard}>
              <span className={a.kpiLabel}>Escalations</span>
              <span className={a.kpiValue}>{pct(metrics.escalation_rate)}</span>
              <small className={a.kpiSub}>
                Calls that climbed the model fallback chain
              </small>
            </article>

            <article className={a.kpiCard}>
              <span className={a.kpiLabel}>Admin corrections (30d)</span>
              <span className={a.kpiValue}>{metrics.total_corrections}</span>
              <small className={a.kpiSub}>
                Each one becomes few-shot context next time
              </small>
            </article>

            <article className={a.kpiCard}>
              <span className={a.kpiLabel}>P50 latency</span>
              <span className={a.kpiValue}>{metrics.avg_latency_ms}<small style={{ fontSize: 16, opacity: 0.6 }}>ms</small></span>
              <small className={a.kpiSub}>End-to-end gated_call duration</small>
            </article>
          </section>

          {/* Tools */}
          <section className={a.actionsRow}>
            <button
              className={a.toolBtn}
              onClick={handleRecompute}
              disabled={recomputing}
              type="button"
            >
              {recomputing ? 'Recomputing…' : 'Recompute weekly trust scores'}
            </button>
            <button className={a.toolBtn} onClick={() => loadAll()} type="button">
              Refresh
            </button>
          </section>

          {/* Two column layout */}
          <section className={a.gridTwoCol}>
            {/* Per-model performance */}
            <article className={a.panelCard}>
              <h3 className={a.panelTitle}>
                Per-model performance
                <small>30-day window</small>
              </h3>
              <div className={`${a.modelRow} ${a.modelHead}`}>
                <span>Model</span>
                <span style={{ textAlign: 'right' }}>Calls</span>
                <span style={{ textAlign: 'right' }}>Auto-rate</span>
                <span style={{ textAlign: 'right' }}>Avg conf.</span>
              </div>
              {Object.entries(metrics.by_model).length === 0 ? (
                <div className={a.emptyState}>No pipeline calls logged yet. Submit a problem to bootstrap.</div>
              ) : (
                Object.entries(metrics.by_model).map(([model, data]) => (
                  <div key={model} className={a.modelRow}>
                    <span className={a.modelName}>{model}</span>
                    <span className={a.modelMetric}>{data.count}</span>
                    <span className={`${a.modelMetric} ${ratingClass(data.auto_rate ?? 0)}`}>
                      {pct(data.auto_rate ?? 0)}
                    </span>
                    <span className={a.modelMetric}>{(data.avg_confidence * 100).toFixed(0)}</span>
                  </div>
                ))
              )}
            </article>

            {/* Per-task performance */}
            <article className={a.panelCard}>
              <h3 className={a.panelTitle}>
                Per-task performance
                <small>format / solutions / RAG</small>
              </h3>
              <div className={`${a.modelRow} ${a.modelHead}`}>
                <span>Task</span>
                <span style={{ textAlign: 'right' }}>Calls</span>
                <span style={{ textAlign: 'right' }}>Auto-rate</span>
                <span style={{ textAlign: 'right' }}>Avg conf.</span>
              </div>
              {Object.entries(metrics.by_task).length === 0 ? (
                <div className={a.emptyState}>Waiting for first AI calls…</div>
              ) : (
                Object.entries(metrics.by_task).map(([task, data]) => (
                  <div key={task} className={a.modelRow}>
                    <span className={a.modelName}>{task}</span>
                    <span className={a.modelMetric}>{data.count}</span>
                    <span className={`${a.modelMetric} ${ratingClass(data.auto_rate ?? 0)}`}>
                      {pct(data.auto_rate ?? 0)}
                    </span>
                    <span className={a.modelMetric}>{(data.avg_confidence * 100).toFixed(0)}</span>
                  </div>
                ))
              )}
            </article>
          </section>

          {/* Correction trend + recent corrections */}
          <section className={a.gridTwoCol}>
            <article className={a.panelCard}>
              <h3 className={a.panelTitle}>
                Correction trend
                <small>last 7 days</small>
              </h3>
              <div className={a.trendBars}>
                {metrics.correction_trends_7d.map((day) => (
                  <div
                    key={day.date}
                    className={a.trendBar}
                    data-count={day.count}
                    style={{ height: `${(day.count / trendMax) * 90 + 6}px` }}
                  />
                ))}
              </div>
              <div className={a.trendDates}>
                {metrics.correction_trends_7d.map((day) => (
                  <span key={day.date}>{day.date.slice(5)}</span>
                ))}
              </div>
            </article>

            <article className={a.panelCard}>
              <h3 className={a.panelTitle}>
                Recent admin corrections
                <small>each row is training signal</small>
              </h3>
              {corrections.length === 0 ? (
                <div className={a.emptyState}>
                  No corrections yet. As admins edit AI-drafted titles, severity, etc.
                  they show up here and feed the next AI generation.
                </div>
              ) : (
                corrections.map((c) => (
                  <div key={c.id} className={a.correctionRow}>
                    <div className={a.correctionMeta}>
                      <span>#{c.problem_id}</span>
                      <strong>{c.field_name}</strong>
                      <span>{c.model_used || 'unknown'}</span>
                      <span style={{ marginLeft: 'auto' }}>{fmtTs(c.ts)}</span>
                    </div>
                    <div className={a.correctionDiff}>
                      <span className={a.was}>{(c.original_value || '∅').slice(0, 80)}</span>
                      <span className={a.now}>→ {(c.corrected_value || '∅').slice(0, 80)}</span>
                    </div>
                  </div>
                ))
              )}
            </article>
          </section>
        </>
      ) : null}
    </main>
  );
}
