'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import SharedNav from '@/components/SharedNav';
import { knowledgeApi, extractError } from '@/lib/api';
import { initAuth, loadUserFromStorage } from '@/lib/auth';
import s from '@/components/shared.module.css';
import k from './knowledge.module.css';

interface Citation {
  document_title: string;
  section_title: string | null;
  page_number: number | null;
  source_url: string | null;
  chunk_text: string;
  similarity: number;
}

interface Answer {
  question: string;
  answer: string;
  citations: Citation[];
  confidence: number;
  model_used: string;
  auto_resolved: boolean;
}

const SUGGESTIONS = [
  'Who is responsible for water supply in my building?',
  'What are the rules for solid waste segregation?',
  'How often must lifts be inspected in Lucknow?',
  'Who maintains common areas in an apartment building?',
  'Where do I report a sewer overflow inside the compound?',
];

function KnowledgePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [authReady, setAuthReady] = useState(false);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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

  // Auto-ask if a `?q=...` deep link is present (used by the cross-link
  // from problem detail pages → "Ask the rulebook").
  useEffect(() => {
    if (!authReady) return;
    const qp = searchParams.get('q');
    if (qp && !answer && !loading) {
      setQuestion(qp);
      void ask(qp);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, searchParams]);

  const ask = async (q?: string) => {
    const finalQ = (q ?? question).trim();
    if (!finalQ || loading) return;
    setLoading(true);
    setError('');
    setAnswer(null);
    if (q) setQuestion(q);
    try {
      const res = await knowledgeApi.ask(finalQ, 4);
      setAnswer(res.data);
    } catch (err) {
      setError(extractError(err, 'RAG query failed. The knowledge base may be empty — run scripts/seed_lmc_docs.py.'));
    } finally {
      setLoading(false);
    }
  };

  if (!authReady) {
    return (
      <main className={s.page}>
        <div className={s.loadingCenter} style={{ minHeight: '100vh' }}><span className={s.spinner} /></div>
      </main>
    );
  }

  return (
    <main className={s.page}>
      <SharedNav active="knowledge" />

      <section className={k.heroBand}>
        <span className={k.heroEyebrow}>RAG · cited sources · confidence-gated</span>
        <h1 className={k.heroTitle}>Ask the Lucknow rulebook.</h1>
        <p className={k.heroSub}>
          Get grounded answers about municipal bylaws, the U.P. Apartment Act, water
          supply boundaries, and lift safety rules. Every answer cites the exact
          document, section and page so you can verify the source.
        </p>
      </section>

      <div className={k.askBox}>
        <input
          className={k.askInput}
          placeholder="e.g. Who is responsible for the lift inspection?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') ask();
          }}
          disabled={loading}
        />
        <button className={k.askButton} onClick={() => ask()} disabled={loading || !question.trim()} type="button">
          {loading ? 'Searching…' : 'Ask'}
        </button>
      </div>

      <div className={k.suggestStrip}>
        {SUGGESTIONS.map((q) => (
          <button key={q} className={k.suggestPill} onClick={() => ask(q)} type="button">
            {q}
          </button>
        ))}
      </div>

      {error && (
        <div className={s.container} style={{ maxWidth: 900 }}>
          <div className={s.errorBlock}>{error}</div>
        </div>
      )}

      {loading && (
        <div style={{ padding: 40, display: 'grid', placeItems: 'center' }}>
          <span className={s.spinner} />
        </div>
      )}

      {answer && !loading && (
        <>
          <article className={k.answerCard}>
            <div className={k.answerMetaRow}>
              <span>Answer</span>
              <span className={`${k.confBadge} ${answer.auto_resolved ? '' : k.warn}`}>
                {answer.auto_resolved ? 'Auto-resolved' : 'Needs review'}
                {' · '}
                {Math.round(answer.confidence * 100)}/100
              </span>
              <span className={k.modelBadge}>{answer.model_used}</span>
            </div>
            <p className={k.answerText}>{answer.answer}</p>
          </article>

          <div className={k.citationStack}>
            <span className={k.citationsTitle}>Citations</span>
            {answer.citations.map((c, i) => (
              <article key={i} className={k.citationCard}>
                <div className={k.citationHead}>
                  <div>
                    <div className={k.citationTitle}>
                      [{i + 1}] {c.document_title}
                    </div>
                    <div className={k.citationMeta}>
                      {c.section_title && <>§ {c.section_title}</>}
                      {c.page_number !== null && <> · page {c.page_number}</>}
                    </div>
                  </div>
                  <span className={k.citationSim}>cosine {c.similarity.toFixed(3)}</span>
                </div>
                <p className={k.citationText}>{c.chunk_text}</p>
                {c.source_url && (
                  <a className={k.citationLink} href={c.source_url} target="_blank" rel="noreferrer">
                    Open source ↗
                  </a>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </main>
  );
}

export default function KnowledgePage() {
  return (
    <Suspense fallback={<main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}><span /></main>}>
      <KnowledgePageInner />
    </Suspense>
  );
}
