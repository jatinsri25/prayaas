'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { problemsApi, groupsApi, extractError } from '@/lib/api';
import { loadUserFromStorage, initAuth } from '@/lib/auth';
import SharedNav from '@/components/SharedNav';
import s from '@/components/shared.module.css';
import r from './report.module.css';

interface Solution { action: string; responsible_party: string; timeline: string; priority: number; }
interface DuplicateMatch {
  problem_id: number;
  title: string;
  similarity: number;
  distance_meters: number | null;
  status: string;
  created_at: string;
}
interface DuplicateWarning {
  is_likely_duplicate: boolean;
  matches: DuplicateMatch[];
}
interface Draft {
  title: string;
  category: string;
  location: string;
  severity: string;
  formatted_description: string;
  affected_residents: string;
  solutions: Solution[];
  confidence_score?: number | null;
  was_escalated?: boolean | null;
  last_model_used?: string | null;
  auto_resolved?: boolean | null;
  duplicate_warning?: DuplicateWarning | null;
}
interface Group { id: number; name: string; }

const CATEGORIES = ['Infrastructure', 'Safety', 'Sanitation', 'Noise', 'Maintenance', 'Security', 'Utilities', 'Other'];
const SEVERITIES = ['Low', 'Medium', 'High', 'Critical'];
const PRIORITY_COLORS = ['#fb7185', '#fbbf24', '#5eead4'];
const SOL_CLASS = [r.solP1, r.solP2, r.solP3];

export default function NewProblemPage() {
  const router = useRouter();
  const [step, setStep] = useState<'input' | 'processing' | 'draft' | 'posting'>('input');
  const [rawText, setRawText] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [myGroups, setMyGroups] = useState<Group[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [posting, setPosting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 3000); };

  useEffect(() => {
    const init = async () => {
      const stored = loadUserFromStorage();
      if (!stored) { router.push('/login'); return; }
      await initAuth();
      groupsApi.myGroups().then(res => setMyGroups(res.data)).catch(() => {});
    };
    init();
  }, [router]);

  const startRecording = async () => {
    try {
      setError('');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach(t => t.stop());
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setRecording(true);
      setRecordingTime(0);
      timerRef.current = setInterval(() => setRecordingTime(t => t + 1), 1000);
    } catch {
      setError('Microphone access denied. Please allow microphone permission.');
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setRecording(false);
    if (timerRef.current) clearInterval(timerRef.current);
  };

  const fmt = (sec: number) => `${Math.floor(sec / 60).toString().padStart(2, '0')}:${(sec % 60).toString().padStart(2, '0')}`;

  const handleProcess = async () => {
    if (!rawText.trim() && !audioBlob) { setError('Please describe your problem'); return; }
    setError(''); setStep('processing');
    try {
      const fd = new FormData();
      if (rawText.trim()) fd.append('raw_text', rawText);
      if (audioBlob) fd.append('audio', audioBlob, 'recording.webm');
      const res = await problemsApi.process(fd);
      setDraft(res.data); setStep('draft');
    } catch (err: any) {
      setError(extractError(err, 'AI processing failed. Please try again.')); setStep('input');
    }
  };

  const handlePost = async () => {
    if (!draft) return;
    setPosting(true); setStep('posting');
    try {
      const fd = new FormData();
      fd.append('title', draft.title);
      fd.append('formatted_description', draft.formatted_description);
      fd.append('category', draft.category);
      fd.append('severity', draft.severity);
      fd.append('location', draft.location);
      fd.append('affected_residents', draft.affected_residents);
      fd.append('ai_solutions', JSON.stringify(draft.solutions));
      if (rawText) fd.append('raw_input', rawText);
      if (selectedGroup) fd.append('group_id', String(selectedGroup));
      if (audioBlob) fd.append('audio', audioBlob, 'recording.webm');
      // Confidence-gated pipeline telemetry — persisted for the admin dashboard
      if (draft.confidence_score != null) fd.append('confidence_score', String(draft.confidence_score));
      if (draft.was_escalated != null) fd.append('was_escalated', String(draft.was_escalated));
      if (draft.last_model_used) fd.append('last_model_used', draft.last_model_used);
      await problemsApi.post(fd);
      showToast('Problem posted successfully! 🎉');
      setTimeout(() => router.push('/dashboard'), 1500);
    } catch (err: any) {
      setError(extractError(err, 'Failed to post.')); setStep('draft'); setPosting(false);
    }
  };

  const updateDraft = (key: keyof Draft, value: string) => { if (draft) setDraft({ ...draft, [key]: value }); };

  // ── Processing ────────────────────────────────────────
  if (step === 'processing') {
    return (
      <main className={s.page}>
        <div className={r.processingWrap}>
          <div className={r.processingInner}>
            <div className={r.aiOrb}>🤖</div>
            <h2 style={{ fontSize: 28, fontWeight: 500 }}>AI is processing your report…</h2>
            <p style={{ color: 'rgba(232,234,240,0.44)', maxWidth: 300, fontSize: 14, lineHeight: 1.65 }}>
              Transcribing, formatting, and generating solutions for your problem.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 340 }}>
              {['🎙️ Transcribing audio...', '📋 Formatting report...', '💡 Generating solutions...'].map((txt, i) => (
                <div key={i} className={r.stepRow} style={{ animationDelay: `${i * 0.6}s` }}>
                  {txt}
                  <span className={s.spinnerSm} style={{ marginLeft: 'auto' }} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>
    );
  }

  // ── Draft Review ──────────────────────────────────────
  if (step === 'draft' && draft) {
    const sevColor: Record<string, string> = { Low: '#4ade80', Medium: '#fbbf24', High: '#fb7185', Critical: '#fecaca' };
    const confPct = draft.confidence_score != null ? Math.round(draft.confidence_score * 100) : null;
    const dup = draft.duplicate_warning;

    const confColor = !confPct ? 'rgba(232,234,240,0.5)'
      : confPct >= 78 ? '#5eead4'
      : confPct >= 60 ? '#fbbf24'
      : '#fb7185';

    return (
      <main className={s.page}>
        <SharedNav active="report" />
        <div className={s.container} style={{ maxWidth: 760, paddingTop: 36, paddingBottom: 72 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <span className={`${s.badge} ${s.badgeAccent}`}>🤖 AI Formatted Draft</span>
            <span style={{ fontSize: 13, color: 'rgba(232,234,240,0.44)' }}>Review and edit before posting</span>
            {confPct !== null && (
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                  padding: '5px 11px',
                  borderRadius: 999,
                  border: `0.5px solid ${confColor}55`,
                  background: `${confColor}1a`,
                  color: confColor,
                  fontWeight: 700,
                }}
                title={draft.last_model_used || ''}
              >
                {draft.auto_resolved ? 'Auto-resolved' : 'Needs review'} · {confPct}/100
                {draft.was_escalated ? ' · escalated' : ''}
              </span>
            )}
          </div>

          {dup?.is_likely_duplicate && dup.matches.length > 0 && (
            <div
              style={{
                marginBottom: 18,
                padding: '16px 18px',
                borderRadius: 14,
                background: 'rgba(251, 191, 36, 0.08)',
                border: '0.5px solid rgba(251, 191, 36, 0.35)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 18 }}>⚠️</span>
                <strong style={{ color: '#fbbf24', fontSize: 14, fontWeight: 700 }}>
                  Possible duplicate ({dup.matches.length} similar open issue{dup.matches.length > 1 ? 's' : ''} found)
                </strong>
              </div>
              <p style={{ fontSize: 13, color: 'rgba(232,234,240,0.66)', margin: '0 0 10px', lineHeight: 1.55 }}>
                Semantic dedup matched your report against active issues using vector embeddings + geofencing.
                Consider upvoting the existing thread instead of creating a new one.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {dup.matches.slice(0, 3).map((m) => (
                  <button
                    key={m.problem_id}
                    type="button"
                    onClick={() => router.push(`/problems/${m.problem_id}`)}
                    style={{
                      textAlign: 'left',
                      padding: '8px 12px',
                      borderRadius: 10,
                      border: '0.5px solid rgba(255,255,255,0.06)',
                      background: 'rgba(0,0,0,0.18)',
                      color: '#e8eaf0',
                      fontSize: 13,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: 2 }}>#{m.problem_id} · {m.title}</div>
                    <div style={{ fontSize: 11, color: 'rgba(232,234,240,0.5)' }}>
                      similarity {(m.similarity * 100).toFixed(1)}%
                      {m.distance_meters != null && ` · ${m.distance_meters.toFixed(0)}m away`}
                      {' · '}
                      {m.status}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Title */}
            <div className={s.card} style={{ padding: 24 }}>
              <div className={s.formGroup}>
                <label className={s.formLabel}>Title</label>
                <input className={s.formInput} value={draft.title} onChange={e => updateDraft('title', e.target.value)} style={{ fontSize: 17, fontWeight: 600 }} />
              </div>
            </div>

            {/* Meta */}
            <div className={s.grid2}>
              <div className={s.card} style={{ padding: 20 }}>
                <div className={s.formGroup}>
                  <label className={s.formLabel}>Category</label>
                  <select className={s.formSelect} value={draft.category} onChange={e => updateDraft('category', e.target.value)}>
                    {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </div>
              <div className={s.card} style={{ padding: 20 }}>
                <div className={s.formGroup}>
                  <label className={s.formLabel}>Severity — <span style={{ color: sevColor[draft.severity] }}>{draft.severity}</span></label>
                  <select className={s.formSelect} value={draft.severity} onChange={e => updateDraft('severity', e.target.value)}>
                    {SEVERITIES.map(sv => <option key={sv} value={sv}>{sv}</option>)}
                  </select>
                </div>
              </div>
            </div>

            {/* Location + Affected */}
            <div className={s.grid2}>
              <div className={s.card} style={{ padding: 20 }}>
                <div className={s.formGroup}>
                  <label className={s.formLabel}>Location</label>
                  <input className={s.formInput} value={draft.location} onChange={e => updateDraft('location', e.target.value)} />
                </div>
              </div>
              <div className={s.card} style={{ padding: 20 }}>
                <div className={s.formGroup}>
                  <label className={s.formLabel}>Affected Residents</label>
                  <input className={s.formInput} value={draft.affected_residents} onChange={e => updateDraft('affected_residents', e.target.value)} />
                </div>
              </div>
            </div>

            {/* Description */}
            <div className={s.card} style={{ padding: 24 }}>
              <div className={s.formGroup}>
                <label className={s.formLabel}>Formatted Description</label>
                <textarea className={s.formTextarea} value={draft.formatted_description} onChange={e => updateDraft('formatted_description', e.target.value)} style={{ minHeight: 140 }} />
              </div>
            </div>

            {/* Solutions */}
            <div className={s.card} style={{ padding: 24 }}>
              <h3 style={{ fontSize: 17, fontWeight: 500, marginBottom: 16 }}>💡 AI-Generated Solutions</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {draft.solutions.map((sol, i) => (
                  <div key={i} className={`${r.solutionCard} ${SOL_CLASS[i] || ''}`}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <span style={{ width: 22, height: 22, borderRadius: '50%', background: PRIORITY_COLORS[i], display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, color: '#061023', flexShrink: 0 }}>{sol.priority}</span>
                      <span style={{ fontWeight: 600, fontSize: 15 }}>{sol.action}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 16, marginLeft: 30, fontSize: 13, color: 'rgba(232,234,240,0.44)' }}>
                      <span>👤 {sol.responsible_party}</span>
                      <span>⏱️ {sol.timeline}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Post */}
            <div className={s.card} style={{ padding: 24 }}>
              {myGroups.length > 0 && (
                <div className={s.formGroup} style={{ marginBottom: 20 }}>
                  <label className={s.formLabel}>Post to Group (optional)</label>
                  <select className={s.formSelect} value={selectedGroup ?? ''} onChange={e => setSelectedGroup(e.target.value ? Number(e.target.value) : null)}>
                    <option value="">Community Feed (All)</option>
                    {myGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                </div>
              )}
              {error && <div className={s.errorBlock} style={{ marginBottom: 16 }}>{error}</div>}
              <div style={{ display: 'flex', gap: 10 }}>
                <button id="post-problem-btn" className={`${s.primaryBtn} ${s.btnFull}`} onClick={handlePost} disabled={posting}>
                  {posting ? <span className={s.spinnerSm} /> : '🚀 Post to Community'}
                </button>
                <button className={s.secondaryBtn} onClick={() => setStep('input')}>Edit</button>
              </div>
            </div>
          </div>
        </div>
        {toast && <div className={s.toastSuccess}>{toast}</div>}
      </main>
    );
  }

  // ── Input ─────────────────────────────────────────────
  return (
    <main className={s.page}>
      <SharedNav active="report" />
      <div className={s.container} style={{ maxWidth: 680, paddingTop: 42, paddingBottom: 72 }}>
        <div style={{ marginBottom: 32 }}>
          <span className={s.eyebrow}>Step 1 of 2</span>
          <h1 style={{ margin: '12px 0 0', fontSize: 42, fontWeight: 500, lineHeight: 1.05 }}>Report a Problem</h1>
          <p style={{ color: 'rgba(232,234,240,0.68)', fontSize: 15, lineHeight: 1.7, marginTop: 10, maxWidth: 540 }}>
            Speak or type your issue. Our AI will format it into a proper report and suggest solutions.
          </p>
        </div>

        {/* Voice Recorder */}
        <div className={s.card} style={{ padding: 24, marginBottom: 16 }}>
          <h3 style={{ fontSize: 17, fontWeight: 500, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
            🎙️ Voice Recording
            <span style={{ fontSize: 13, color: 'rgba(232,234,240,0.44)', fontWeight: 400 }}>— Speak in any language</span>
          </h3>
          <div className={recording ? r.voiceBoxRecording : r.voiceBox}>
            {recording && (
              <div className={r.waveform}>
                {Array.from({ length: 9 }).map((_, i) => (
                  <div key={i} className={r.waveBar} style={{ animationDelay: `${i * 0.1}s`, height: `${8 + Math.random() * 28}px` }} />
                ))}
              </div>
            )}
            <button className={recording ? r.recordBtnRecording : r.recordBtnIdle} onClick={recording ? stopRecording : startRecording} id="record-btn" type="button">
              {recording ? '⏹' : '🎙️'}
            </button>
            <div style={{ textAlign: 'center' }}>
              {recording ? (
                <div>
                  <div style={{ color: '#fb7185', fontWeight: 700, fontSize: 17, fontFamily: 'monospace' }}>🔴 {fmt(recordingTime)}</div>
                  <div style={{ color: 'rgba(232,234,240,0.44)', fontSize: 13, marginTop: 4 }}>Tap to stop</div>
                </div>
              ) : audioUrl ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                  <div style={{ color: '#5eead4', fontWeight: 600, fontSize: 14 }}>✓ Recording ready ({fmt(recordingTime)})</div>
                  <audio src={audioUrl} controls style={{ borderRadius: 8, maxWidth: '100%' }} />
                  <button className={s.ghostBtn} onClick={() => { setAudioBlob(null); setAudioUrl(null); setRecordingTime(0); }}>🗑️ Discard</button>
                </div>
              ) : (
                <div style={{ color: 'rgba(232,234,240,0.44)', fontSize: 14 }}>Tap the mic to start recording</div>
              )}
            </div>
          </div>
        </div>

        {/* Text input */}
        <div className={s.card} style={{ padding: 24, marginBottom: 16 }}>
          <div className={s.formGroup}>
            <label className={s.formLabel} htmlFor="problem-text">
              Or Type Your Problem
            </label>
            <textarea
              id="problem-text"
              className={s.formTextarea}
              placeholder="Describe the problem in detail. What happened? Where? How long? Who is affected?"
              value={rawText}
              onChange={e => setRawText(e.target.value)}
              style={{ minHeight: 160 }}
            />
          </div>
        </div>

        {error && <div className={s.errorBlock} style={{ marginBottom: 16 }}>{error}</div>}

        <button id="process-ai-btn" className={`${s.primaryBtn} ${s.btnFull}`} onClick={handleProcess} disabled={!rawText.trim() && !audioBlob}>
          🤖 Process with AI →
        </button>

        <p style={{ textAlign: 'center', color: 'rgba(232,234,240,0.44)', fontSize: 13, marginTop: 14 }}>
          AI will format your input into a professional report and suggest solutions
        </p>
      </div>
    </main>
  );
}
