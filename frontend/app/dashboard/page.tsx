'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { authApi, groupsApi, problemsApi } from '@/lib/api';
import { initAuth, loadUserFromStorage } from '@/lib/auth';
import styles from './dashboard.module.css';

interface Problem {
  id: number;
  title: string;
  formatted_description: string;
  category: string;
  severity: string;
  location: string | null;
  affected_residents: string | null;
  upvotes: number;
  status: string;
  created_at: string;
  author: { id: number; name: string; flat_number: string; avatar_color: string };
  group_id: number | null;
}

interface Group {
  id: number;
  name: string;
  member_count: number;
  description: string | null;
}

interface User {
  id: number;
  name: string;
  email: string;
  flat_number: string;
  avatar_color: string;
}

const statusClass: Record<string, string> = {
  Open: styles.statusOpen,
  'In Progress': styles.statusProgress,
  Resolved: styles.statusResolved,
};

const severityClass: Record<string, string> = {
  Low: styles.severityLow,
  Medium: styles.severityMedium,
  High: styles.severityHigh,
  Critical: styles.severityCritical,
};

const timeAgo = (date: string) => {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};

function BrandMark() {
  return (
    <span className={styles.brandMark} aria-hidden="true">
      <span />
    </span>
  );
}

function SocietyAnimation({ open, progress, resolved }: { open: number; progress: number; resolved: number }) {
  return (
    <div className={styles.societyScene} aria-label="Animated society operations status">
      <div className={styles.sceneTop}>
        <span>Society signal</span>
        <strong>{resolved >= open ? 'Improving' : 'Needs action'}</strong>
      </div>

      <div className={styles.sceneBuildings} aria-hidden="true">
        <span className={styles.towerOne} />
        <span className={styles.towerTwo} />
        <span className={styles.towerThree} />
        <span className={styles.towerFour} />
        <span className={styles.towerFive} />
      </div>

      <div className={styles.signalPath} aria-hidden="true">
        <span />
        <span />
        <span />
      </div>

      <div className={styles.sceneStats}>
        <div>
          <span>Open</span>
          <strong>{open}</strong>
        </div>
        <div>
          <span>In progress</span>
          <strong>{progress}</strong>
        </div>
        <div>
          <span>Resolved</span>
          <strong>{resolved}</strong>
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [myGroups, setMyGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedGroup, setSelectedGroup] = useState<number | null>(null);
  const [upvoted, setUpvoted] = useState<Set<number>>(new Set());

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [problemsRes, groupsRes] = await Promise.all([
        problemsApi.list(selectedGroup || undefined),
        groupsApi.myGroups(),
      ]);
      setProblems(problemsRes.data);
      setMyGroups(groupsRes.data);
    } finally {
      setLoading(false);
    }
  }, [selectedGroup]);

  useEffect(() => {
    const boot = async () => {
      const stored = loadUserFromStorage();
      if (!stored) {
        router.push('/login');
        return;
      }

      setUser(stored);
      await initAuth();
      setAuthReady(true);
    };

    boot();
  }, [router]);

  useEffect(() => {
    if (authReady) {
      const frame = window.requestAnimationFrame(() => {
        void loadData();
      });

      return () => window.cancelAnimationFrame(frame);
    }
  }, [authReady, loadData]);

  const stats = useMemo(() => {
    const total = problems.length;
    const open = problems.filter((problem) => problem.status === 'Open').length;
    const progress = problems.filter((problem) => problem.status === 'In Progress').length;
    const resolved = problems.filter((problem) => problem.status === 'Resolved').length;
    const completion = total ? Math.round((resolved / total) * 100) : 0;

    return { total, open, progress, resolved, completion };
  }, [problems]);

  const activeGroupName = selectedGroup
    ? myGroups.find((group) => group.id === selectedGroup)?.name || 'Selected group'
    : 'All society issues';

  const handleUpvote = async (id: number) => {
    if (upvoted.has(id)) return;
    try {
      const res = await problemsApi.upvote(id);
      setProblems((current) =>
        current.map((problem) => (problem.id === id ? { ...problem, upvotes: res.data.upvotes } : problem)),
      );
      setUpvoted((current) => new Set([...current, id]));
    } catch {
      // Keep the feed usable even if a duplicate vote is rejected server-side.
    }
  };

  const logout = async () => {
    await authApi.logout();
    router.push('/');
  };

  if (!user) {
    return (
      <main className={styles.page}>
        <div className={styles.loadingShell}>
          <span className={styles.spinner} />
        </div>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <nav className={styles.navbar}>
        <div className={styles.navInner}>
          <Link className={styles.brand} href="/dashboard">
            <BrandMark />
            <span>
              <strong>Prayaas</strong>
              <small>Society workspace</small>
            </span>
          </Link>

          <div className={styles.navLinks} aria-label="Dashboard navigation">
            <span className={styles.activeNav}>Dashboard</span>
            <Link href="/groups">Groups</Link>
            <Link href="/problems/new">Report Issue</Link>
          </div>

          <div className={styles.profileCluster}>
            <span className={styles.avatar} style={{ background: user.avatar_color }}>
              {user.name[0]?.toUpperCase()}
            </span>
            <button className={styles.ghostButton} id="logout-btn" onClick={logout} type="button">
              Sign out
            </button>
          </div>
        </div>
      </nav>

      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}>Flat {user.flat_number}</span>
          <h1>{user.name.split(' ')[0]}&apos;s society command center.</h1>
          <p>
            Track resident concerns, prioritize what needs committee attention, and watch society progress move from
            open complaints to resolved outcomes.
          </p>
          <div className={styles.heroActions}>
            <button className={styles.primaryButton} id="new-problem-btn" onClick={() => router.push('/problems/new')} type="button">
              Report an issue
            </button>
            <button className={styles.secondaryButton} onClick={() => router.push('/groups')} type="button">
              Manage groups
            </button>
          </div>
        </div>

        <SocietyAnimation open={stats.open} progress={stats.progress} resolved={stats.resolved} />
      </section>

      <section className={styles.statsGrid} aria-label="Society issue metrics">
        <article className={styles.statCard}>
          <span>Total issues</span>
          <strong>{stats.total}</strong>
          <small>{activeGroupName}</small>
        </article>
        <article className={styles.statCard}>
          <span>Open</span>
          <strong>{stats.open}</strong>
          <small>Needs first response</small>
        </article>
        <article className={styles.statCard}>
          <span>In progress</span>
          <strong>{stats.progress}</strong>
          <small>Owners are moving</small>
        </article>
        <article className={styles.statCard}>
          <span>Resolved</span>
          <strong>{stats.completion}%</strong>
          <small>{stats.resolved} closed issues</small>
        </article>
      </section>

      <section className={styles.contentGrid}>
        <div className={styles.feedColumn}>
          <div className={styles.sectionHeader}>
            <div>
              <span className={styles.eyebrow}>Community feed</span>
              <h2>{activeGroupName}</h2>
            </div>
            <button className={styles.primaryButtonSmall} onClick={() => router.push('/problems/new')} type="button">
              New report
            </button>
          </div>

          <div className={styles.filterBar} aria-label="Group filters">
            <button
              className={selectedGroup === null ? styles.selectedFilter : ''}
              onClick={() => setSelectedGroup(null)}
              type="button"
            >
              All
            </button>
            {myGroups.map((group) => (
              <button
                className={selectedGroup === group.id ? styles.selectedFilter : ''}
                key={group.id}
                onClick={() => setSelectedGroup(group.id)}
                type="button"
              >
                {group.name}
              </button>
            ))}
          </div>

          {loading ? (
            <div className={styles.feedLoading}>
              <span className={styles.spinner} />
            </div>
          ) : problems.length === 0 ? (
            <div className={styles.emptyState}>
              <span>No active reports</span>
              <h3>Start the first visible issue thread.</h3>
              <p>Voice or text reports become structured AI drafts for the committee.</p>
              <button className={styles.primaryButtonSmall} onClick={() => router.push('/problems/new')} type="button">
                Report first issue
              </button>
            </div>
          ) : (
            <div className={styles.issueList}>
              {problems.map((problem) => (
                <article
                  className={styles.issueCard}
                  key={problem.id}
                  onClick={() => router.push(`/problems/${problem.id}`)}
                >
                  <div className={styles.issueMeta}>
                    <div className={styles.badgeRow}>
                      <span className={`${styles.badge} ${severityClass[problem.severity] || styles.severityMedium}`}>
                        {problem.severity}
                      </span>
                      <span className={styles.badge}>{problem.category}</span>
                      <span className={`${styles.badge} ${statusClass[problem.status] || styles.statusOpen}`}>
                        {problem.status}
                      </span>
                    </div>
                    <time>{timeAgo(problem.created_at)}</time>
                  </div>

                  <h3>{problem.title}</h3>
                  <p>
                    {problem.formatted_description.slice(0, 210)}
                    {problem.formatted_description.length > 210 ? '...' : ''}
                  </p>

                  <div className={styles.issueFooter}>
                    <div className={styles.author}>
                      <span style={{ background: problem.author.avatar_color }}>{problem.author.name[0]}</span>
                      <small>
                        {problem.author.name} · Flat {problem.author.flat_number}
                      </small>
                    </div>
                    <button
                      className={upvoted.has(problem.id) ? styles.upvotedButton : styles.voteButton}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleUpvote(problem.id);
                      }}
                      type="button"
                    >
                      Upvote {problem.upvotes}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>

        <aside className={styles.sideColumn}>
          <button className={styles.voiceCard} onClick={() => router.push('/problems/new')} type="button">
            <span className={styles.voicePulse} />
            <strong>Report with voice</strong>
            <small>Speak the issue. Prayaas structures the report and next actions.</small>
          </button>

          <div className={styles.panelCard}>
            <div className={styles.panelHeader}>
              <span className={styles.eyebrow}>My groups</span>
              <Link href="/groups">View all</Link>
            </div>

            {myGroups.length === 0 ? (
              <div className={styles.groupEmpty}>
                <p>You have not joined any groups yet.</p>
                <button className={styles.secondaryButtonSmall} onClick={() => router.push('/groups')} type="button">
                  Browse groups
                </button>
              </div>
            ) : (
              <div className={styles.groupList}>
                {myGroups.slice(0, 5).map((group) => (
                  <button
                    className={selectedGroup === group.id ? styles.activeGroup : ''}
                    key={group.id}
                    onClick={() => setSelectedGroup(group.id)}
                    type="button"
                  >
                    <span>{group.name}</span>
                    <small>{group.member_count} members</small>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className={styles.panelCard}>
            <div className={styles.panelHeader}>
              <span className={styles.eyebrow}>Resolution rhythm</span>
            </div>
            <div className={styles.rhythm}>
              <span style={{ '--fill': `${Math.max(stats.completion, 8)}%` } as React.CSSProperties} />
            </div>
            <p className={styles.rhythmCopy}>
              {stats.completion}% of visible issues are resolved in the current view.
            </p>
          </div>
        </aside>
      </section>
    </main>
  );
}
