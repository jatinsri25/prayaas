'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { problemsApi } from '@/lib/api';
import { loadUserFromStorage } from '@/lib/auth';
import SharedNav from '@/components/SharedNav';
import s from '@/components/shared.module.css';
import r from '@/app/problems/new/report.module.css';

interface Solution { action: string; responsible_party: string; timeline: string; priority: number; }
interface Problem {
  id: number; title: string; formatted_description: string; category: string; severity: string;
  location: string; affected_residents: string; ai_solutions: string | null;
  upvotes: number; status: string; created_at: string;
  author: { id: number; name: string; flat_number: string; avatar_color: string };
  group_id: number | null;
  confidence_score?: number | null;
  was_escalated?: boolean | null;
  last_model_used?: string | null;
}

const EDITABLE_AI_FIELDS = ['title', 'category', 'severity', 'location', 'formatted_description', 'affected_residents'] as const;
type AIField = (typeof EDITABLE_AI_FIELDS)[number];

const PRIORITY_COLORS = ['#fb7185', '#fbbf24', '#5eead4'];
const SOL_CLASS = [r.solP1, r.solP2, r.solP3];
const STATUS_OPTIONS = ['Open', 'In Progress', 'Resolved'];

const sevBadge: Record<string, string> = { Low: 'sevLow', Medium: 'sevMedium', High: 'sevHigh', Critical: 'sevCritical' };
const statusBadge: Record<string, string> = { Open: 'statusOpen', 'In Progress': 'statusProgress', Resolved: 'statusResolved' };

const timeAgo = (date: string) => {
  const sec = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)} minutes ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} hours ago`;
  return `${Math.floor(sec / 86400)} days ago`;
};

export default function ProblemDetailPage() {
  const params = useParams();
  const router = useRouter();
  const [problem, setProblem] = useState<Problem | null>(null);
  const [solutions, setSolutions] = useState<Solution[]>([]);
  const [loading, setLoading] = useState(true);
  const [upvoted, setUpvoted] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<number | null>(null);
  const [editingField, setEditingField] = useState<AIField | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [correctionToast, setCorrectionToast] = useState('');

  useEffect(() => {
    const stored = loadUserFromStorage();
    if (stored) setCurrentUserId(stored.id);
    if (params.id) {
      problemsApi.get(Number(params.id))
        .then(res => {
          setProblem(res.data);
          if (res.data.ai_solutions) { try { setSolutions(JSON.parse(res.data.ai_solutions)); } catch {} }
        })
        .catch(() => router.push('/dashboard'))
        .finally(() => setLoading(false));
    }
  }, [params.id, router]);

  const handleUpvote = async () => {
    if (upvoted || !problem) return;
    try {
      const res = await problemsApi.upvote(problem.id);
      setProblem({ ...problem, upvotes: res.data.upvotes });
      setUpvoted(true);
    } catch {}
  };

  const handleStatusChange = async (status: string) => {
    if (!problem) return;
    try { const res = await problemsApi.updateStatus(problem.id, status); setProblem(res.data); } catch {}
  };

  const startEdit = (field: AIField) => {
    if (!problem) return;
    setEditingField(field);
    setEditingValue(String(problem[field] ?? ''));
  };

  const cancelEdit = () => {
    setEditingField(null);
    setEditingValue('');
  };

  // Saving an inline edit POSTs to /ai-fields which logs an AICorrection
  // row — this is the ML feedback loop training signal.
  const saveEdit = async () => {
    if (!problem || !editingField) return;
    if (String(problem[editingField] ?? '') === editingValue) {
      cancelEdit();
      return;
    }
    setSavingEdit(true);
    try {
      const res = await problemsApi.correctAiFields(problem.id, { [editingField]: editingValue });
      setProblem(res.data);
      setCorrectionToast(`Logged correction to ${editingField} — feeding next AI generation`);
      setTimeout(() => setCorrectionToast(''), 3500);
      cancelEdit();
    } catch {
      // best-effort; UI stays in edit mode
    } finally {
      setSavingEdit(false);
    }
  };

  if (loading) return (
    <main className={s.page}>
      <div className={s.loadingCenter} style={{ minHeight: '100vh' }}><span className={s.spinner} /></div>
    </main>
  );

  if (!problem) return null;

  const isAuthor = currentUserId === problem.author.id;
  const canEdit = isAuthor;
  const confPct = problem.confidence_score != null ? Math.round(problem.confidence_score * 100) : null;
  const confColor = !confPct ? 'rgba(232,234,240,0.5)'
    : confPct >= 78 ? '#5eead4'
    : confPct >= 60 ? '#fbbf24'
    : '#fb7185';

  return (
    <main className={s.page}>
      <SharedNav active="dashboard" />

      <div className={s.container} style={{ maxWidth: 760, paddingTop: 36, paddingBottom: 72 }}>
        <div className={s.fadeIn}>
          {/* Back link */}
          <button className={s.ghostBtn} onClick={() => router.push('/dashboard')} style={{ marginBottom: 24, fontSize: 13 }}>
            ← Back to Feed
          </button>

          {/* Badges */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20, alignItems: 'center' }}>
            <span className={`${s.badge} ${s[sevBadge[problem.severity] || 'sevMedium']}`}>{problem.severity}</span>
            <span className={`${s.badge} ${s.badgeAccent}`}>{problem.category}</span>
            <span className={`${s.badge} ${s[statusBadge[problem.status] || 'statusOpen']}`}>{problem.status}</span>
            {confPct !== null && (
              <span
                title={problem.last_model_used || ''}
                style={{
                  marginLeft: 'auto',
                  fontSize: 10,
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                  padding: '4px 10px',
                  borderRadius: 999,
                  border: `0.5px solid ${confColor}55`,
                  background: `${confColor}1a`,
                  color: confColor,
                  fontWeight: 700,
                }}
              >
                AI conf {confPct}/100{problem.was_escalated ? ' · escalated' : ''}
              </span>
            )}
          </div>

          {/* Title (inline-editable) */}
          {editingField === 'title' ? (
            <div style={{ marginBottom: 16 }}>
              <input
                className={s.formInput}
                value={editingValue}
                onChange={(e) => setEditingValue(e.target.value)}
                style={{ fontSize: 28, fontWeight: 500 }}
                autoFocus
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className={s.primaryBtnSm} onClick={saveEdit} disabled={savingEdit} type="button">
                  {savingEdit ? 'Saving…' : 'Save correction'}
                </button>
                <button className={s.secondaryBtnSm} onClick={cancelEdit} type="button">Cancel</button>
              </div>
            </div>
          ) : (
            <h1
              style={{ fontSize: 34, fontWeight: 500, marginBottom: 16, lineHeight: 1.15, cursor: canEdit ? 'pointer' : 'default' }}
              onClick={canEdit ? () => startEdit('title') : undefined}
              title={canEdit ? 'Click to correct (logged as ML feedback)' : ''}
            >
              {problem.title}
              {canEdit && <span style={{ marginLeft: 8, fontSize: 12, color: 'rgba(232,234,240,0.3)' }}>✎</span>}
            </h1>
          )}

          {/* Meta */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 28, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className={s.avatar} style={{ background: problem.author.avatar_color, width: 30, height: 30, fontSize: 11 }}>
                {problem.author.name[0]}
              </span>
              <span style={{ fontSize: 14, color: 'rgba(232,234,240,0.68)' }}>
                {problem.author.name} · Flat {problem.author.flat_number}
              </span>
            </div>
            <span style={{ color: 'rgba(232,234,240,0.44)', fontSize: 13 }}>📍 {problem.location || 'Society premises'}</span>
            <span style={{ color: 'rgba(232,234,240,0.44)', fontSize: 13 }}>🕐 {timeAgo(problem.created_at)}</span>
          </div>

          {/* Description (inline-editable for ML feedback loop) */}
          <div className={s.card} style={{ padding: 24, marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <span className={s.eyebrow}>Problem Description</span>
              {canEdit && editingField !== 'formatted_description' && (
                <button
                  type="button"
                  className={s.ghostBtn}
                  style={{ fontSize: 11, padding: '4px 10px' }}
                  onClick={() => startEdit('formatted_description')}
                  title="Edits are logged as ML feedback signal"
                >
                  ✎ Correct
                </button>
              )}
            </div>
            {editingField === 'formatted_description' ? (
              <>
                <textarea
                  className={s.formTextarea}
                  value={editingValue}
                  onChange={(e) => setEditingValue(e.target.value)}
                  style={{ minHeight: 140 }}
                  autoFocus
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button className={s.primaryBtnSm} onClick={saveEdit} disabled={savingEdit} type="button">
                    {savingEdit ? 'Saving…' : 'Save correction'}
                  </button>
                  <button className={s.secondaryBtnSm} onClick={cancelEdit} type="button">Cancel</button>
                </div>
              </>
            ) : (
              <p style={{ lineHeight: 1.75, color: 'rgba(232,234,240,0.68)', fontSize: 15, margin: 0 }}>
                {problem.formatted_description}
              </p>
            )}
          </div>

          {/* RAG cross-link — let the user ask the LMC rulebook for a citation */}
          <div
            className={s.card}
            onClick={() => router.push(`/knowledge?q=${encodeURIComponent('Who is responsible for ' + problem.category.toLowerCase() + ' issues?')}`)}
            style={{
              padding: 18,
              marginBottom: 16,
              cursor: 'pointer',
              background: 'linear-gradient(135deg, rgba(94,234,212,0.06), rgba(124,92,247,0.04))',
              border: '0.5px solid rgba(94,234,212,0.2)',
              display: 'flex',
              alignItems: 'center',
              gap: 14,
            }}
          >
            <span style={{ fontSize: 20 }}>📖</span>
            <div style={{ flex: 1 }}>
              <strong style={{ display: 'block', fontSize: 14, color: '#5eead4' }}>Ask the rulebook</strong>
              <small style={{ color: 'rgba(232,234,240,0.6)', fontSize: 12 }}>
                Find out who is officially responsible for {problem.category.toLowerCase()} issues using cited LMC bylaws.
              </small>
            </div>
            <span style={{ color: '#5eead4', fontSize: 13 }}>→</span>
          </div>

          {/* Affected */}
          {problem.affected_residents && (
            <div className={s.card} style={{ padding: 20, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 14 }}>
              <span style={{ fontSize: 24 }}>👥</span>
              <div>
                <span className={s.eyebrow} style={{ display: 'block', marginBottom: 4 }}>Affected Residents</span>
                <span style={{ color: 'rgba(232,234,240,0.68)', fontSize: 14 }}>{problem.affected_residents}</span>
              </div>
            </div>
          )}

          {/* Solutions */}
          {solutions.length > 0 && (
            <div className={s.card} style={{ padding: 24, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
                <h3 style={{ fontSize: 17, fontWeight: 500 }}>💡 AI-Suggested Solutions</h3>
                <span className={`${s.badge} ${s.badgeAccent}`}>Gemini AI</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {solutions.map((sol, i) => (
                  <div key={i} className={`${r.solutionCard} ${SOL_CLASS[i] || ''}`} style={{ display: 'flex', gap: 14 }}>
                    <div style={{ width: 28, height: 28, borderRadius: '50%', background: PRIORITY_COLORS[i], display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, color: '#061023', flexShrink: 0 }}>
                      {sol.priority}
                    </div>
                    <div style={{ flex: 1 }}>
                      <p style={{ fontWeight: 600, marginBottom: 8, lineHeight: 1.4, fontSize: 15 }}>{sol.action}</p>
                      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13, color: 'rgba(232,234,240,0.44)' }}>
                        <span>👤 {sol.responsible_party}</span>
                        <span>⏱️ {sol.timeline}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className={s.card} style={{ padding: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <button
              id="upvote-btn"
              className={upvoted ? s.secondaryBtnSm : s.secondaryBtnSm}
              onClick={handleUpvote}
              style={upvoted ? { borderColor: 'rgba(94,234,212,0.35)', color: '#5eead4', background: 'rgba(94,234,212,0.1)' } : {}}
            >
              ▲ {upvoted ? 'Upvoted' : 'Upvote'} ({problem.upvotes})
            </button>

            {isAuthor && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 13, color: 'rgba(232,234,240,0.44)' }}>Status:</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  {STATUS_OPTIONS.map(st => (
                    <button
                      key={st}
                      className={problem.status === st ? s.primaryBtnSm : s.secondaryBtnSm}
                      onClick={() => handleStatusChange(st)}
                      id={`status-${st.toLowerCase().replace(' ', '-')}`}
                    >
                      {st}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      {correctionToast && <div className={s.toastSuccess}>{correctionToast}</div>}
    </main>
  );
}
