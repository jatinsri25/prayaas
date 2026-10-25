'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { authApi, extractError, groupsApi, problemsApi } from '@/lib/api';
import { getUser, initAuth } from '@/lib/auth';
import BrandMark from '@/components/BrandMark';
import Neighbourhood from '@/components/Neighbourhood';
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
  role?: string;
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

function SocietyAnimation({ open, progress, resolved, pending }: { open: number; progress: number; resolved: number; pending: boolean }) {
  return (
    <div className={styles.societyScene} aria-label="Animated society operations status">
      <div className={styles.sceneTop}>
        <span>Society signal</span>
        <strong>{pending ? 'Awaiting data' : open + progress + resolved === 0 ? 'No reports yet' : open > 0 ? 'Needs attention' : progress > 0 ? 'Work underway' : 'All resolved'}</strong>
      </div>

      <div className={styles.sceneBuildings} aria-hidden="true">
        <span><Neighbourhood /></span>
      </div>

      <div className={styles.signalPath} aria-hidden="true">
        <span />
        <span />
        <span />
      </div>

      <div className={styles.sceneStats}>
        <div>
          <span>Open</span>
          <strong>{pending ? '--' : open}</strong>
        </div>
        <div>
          <span>In progress</span>
          <strong>{pending ? '--' : progress}</strong>
        </div>
        <div>
          <span>Resolved</span>
          <strong>{pending ? '--' : resolved}</strong>
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [myGroups, setMyGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedGroup, setSelectedGroup] = useState<number | null>(null);
  const [upvoted, setUpvoted] = useState<Set<number>>(new Set());
  const [error, setError] = useState('');
  const [voteError, setVoteError] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const [voting, setVoting] = useState<Set<number>>(new Set());
  const voteRequests = useRef(new Set<number>());

  useEffect(() => {
    const controller = new AbortController();
    const boot = async () => {
      try {
        const authenticated = await initAuth();
        if (controller.signal.aborted) return;
        if (!authenticated) {
          if (!getUser()) {
            router.replace('/login');
            return;
          }
          throw new Error('Could not reconnect your session. Please try again.');
        }
        setUser(getUser());
        const [problemsRes, groupsRes] = await Promise.all([
          problemsApi.list(selectedGroup ?? undefined, controller.signal),
          groupsApi.myGroups(controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setProblems(problemsRes.data);
        setMyGroups(groupsRes.data);
      } catch (error) {
        if (!controller.signal.aborted) {
          setError(extractError(error, 'Your society updates could not be loaded. Please try again.'));
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    void boot();
    return () => controller.abort();
  }, [router, selectedGroup, retryCount]);

  const retry = () => {
    setError('');
    setLoading(true);
    setRetryCount((count) => count + 1);
  };

  const selectGroup = (id: number | null) => {
    if (id === selectedGroup) return;
    setError('');
    setLoading(true);
    setSelectedGroup(id);
  };

  const total = problems.length;
  const open = problems.filter((problem) => problem.status === 'Open').length;
  const progress = problems.filter((problem) => problem.status === 'In Progress').length;
  const resolved = problems.filter((problem) => problem.status === 'Resolved').length;
  const stats = { total, open, progress, resolved, completion: total ? Math.round((resolved / total) * 100) : 0 };
  const pending = loading || Boolean(error);

  const activeGroupName = selectedGroup
    ? myGroups.find((group) => group.id === selectedGroup)?.name || 'Selected group'
    : 'All society issues';

  const handleUpvote = async (id: number) => {
    if (upvoted.has(id) || voteRequests.current.has(id)) return;
    voteRequests.current.add(id);
    setVoting(new Set(voteRequests.current));
    setVoteError('');
    try {
      const res = await problemsApi.upvote(id);
      setProblems((current) =>
        current.map((problem) => (problem.id === id ? { ...problem, upvotes: res.data.upvotes } : problem)),
      );
      setUpvoted((current) => new Set([...current, id]));
    } catch (error) {
      setVoteError(extractError(error, 'Your vote could not be saved. Please try again.'));
    } finally {
      voteRequests.current.delete(id);
      setVoting(new Set(voteRequests.current));
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
          {error ? (
            <div className={styles.errorState} role="alert">
              <h1>Unable to load your workspace</h1>
              <p>{error}</p>
              <button className={styles.primaryButtonSmall} onClick={retry} type="button">Try again</button>
              <Link href="/login">Back to sign in</Link>
            </div>
          ) : <span className={styles.spinner} role="status" aria-label="Loading your workspace" />}
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
            <Link href="/search">Search</Link>
            {['society_admin', 'superadmin'].includes(user.role || '') && <Link href="/committee">Digest</Link>}
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
          <h1>Welcome back, {user.name.split(' ')[0]}.</h1>
          <p>
            A shared view of what needs attention, what is moving forward, and the small things your community
            has made better.
          </p>
          <div className={styles.heroActions}>
            <button className={styles.primaryButton} id="new-problem-btn" onClick={() => router.push('/problems/new')} type="button">
              Report an issue
            </button>
            <button className={styles.secondaryButton} onClick={() => router.push('/groups')} type="button">
              Manage groups
            </button>
            <Link className={styles.secondaryButton} href="/search">Find reports</Link>
            {['society_admin', 'superadmin'].includes(user.role || '') && <Link className={styles.secondaryButton} href="/committee">Weekly digest</Link>}
          </div>
        </div>

        <SocietyAnimation open={stats.open} progress={stats.progress} resolved={stats.resolved} pending={pending} />
      </section>

      <section className={styles.statsGrid} aria-label="Society issue metrics">
        <article className={styles.statCard}>
          <span>Total issues</span>
          <strong>{pending ? '--' : stats.total}</strong>
          <small>{activeGroupName}</small>
        </article>
        <article className={styles.statCard}>
          <span>Open</span>
          <strong>{pending ? '--' : stats.open}</strong>
          <small>Needs first response</small>
        </article>
        <article className={styles.statCard}>
          <span>In progress</span>
          <strong>{pending ? '--' : stats.progress}</strong>
          <small>Owners are moving</small>
        </article>
        <article className={styles.statCard}>
          <span>Resolved</span>
          <strong>{pending ? '--' : `${stats.completion}%`}</strong>
          <small>{pending ? 'Awaiting updates' : `${stats.resolved} closed issues`}</small>
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
              onClick={() => selectGroup(null)}
              aria-pressed={selectedGroup === null}
              type="button"
            >
              All
            </button>
            {myGroups.map((group) => (
              <button
                className={selectedGroup === group.id ? styles.selectedFilter : ''}
                key={group.id}
                onClick={() => selectGroup(group.id)}
                aria-pressed={selectedGroup === group.id}
                type="button"
              >
                {group.name}
              </button>
            ))}
          </div>

          {voteError && <p className={styles.errorMessage} role="alert">{voteError}</p>}
          {error ? (
            <div className={styles.errorState} role="alert">
              <h3>Updates are unavailable</h3>
              <p>{error}</p>
              <button className={styles.primaryButtonSmall} onClick={retry} type="button">Try again</button>
            </div>
          ) : loading ? (
            <div className={styles.feedLoading}>
              <span className={styles.spinner} role="status" aria-label="Loading society updates" />
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

                  <h3><Link href={`/problems/${problem.id}`}>{problem.title}</Link></h3>
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
                      disabled={voting.has(problem.id) || upvoted.has(problem.id)}
                      aria-label={`Upvote ${problem.title}`}
                      aria-pressed={upvoted.has(problem.id)}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleUpvote(problem.id);
                      }}
                      type="button"
                    >
                      {voting.has(problem.id) ? 'Saving...' : upvoted.has(problem.id) ? 'Upvoted' : 'Upvote'} {problem.upvotes}
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

            {pending ? <p className={styles.rhythmCopy}>{loading ? 'Loading groups...' : 'Groups unavailable until updates reconnect.'}</p> : myGroups.length === 0 ? (
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
                    onClick={() => selectGroup(group.id)}
                    aria-pressed={selectedGroup === group.id}
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
            <div className={styles.rhythm} role="progressbar" aria-label="Resolved issues" aria-valuenow={pending ? undefined : stats.completion} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ '--fill': `${pending ? 0 : stats.completion}%` } as React.CSSProperties} />
            </div>
            <p className={styles.rhythmCopy}>
              {pending ? 'Waiting for society updates.' : `${stats.completion}% of visible issues are resolved in the current view.`}
            </p>
          </div>
        </aside>
      </section>
    </main>
  );
}
