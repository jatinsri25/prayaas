'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { groupsApi, extractError } from '@/lib/api';
import { loadUserFromStorage, initAuth } from '@/lib/auth';
import SharedNav from '@/components/SharedNav';
import s from '@/components/shared.module.css';

interface Group {
  id: number;
  name: string;
  description: string;
  member_count: number;
  is_public: boolean;
  created_at: string;
  creator: { name: string; flat_number: string; avatar_color: string };
}

export default function GroupsPage() {
  const router = useRouter();
  const [allGroups, setAllGroups] = useState<Group[]>([]);
  const [myGroupIds, setMyGroupIds] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [joiningId, setJoiningId] = useState<number | null>(null);
  const [form, setForm] = useState({ name: '', description: '', is_public: true });
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    const init = async () => {
      const stored = loadUserFromStorage();
      if (!stored) { router.push('/login'); return; }
      await initAuth();
      loadGroups();
    };
    init();
  }, [router]);

  const loadGroups = async () => {
    try {
      const [allRes, myRes] = await Promise.all([groupsApi.list(), groupsApi.myGroups()]);
      setAllGroups(allRes.data);
      setMyGroupIds(new Set(myRes.data.map((g: Group) => g.id)));
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      await groupsApi.create(form);
      setShowForm(false);
      setForm({ name: '', description: '', is_public: true });
      showToast('Group created successfully! 🎉');
      loadGroups();
    } catch (err: any) {
      showToast(extractError(err, 'Failed to create group'), 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleJoin = async (id: number) => {
    setJoiningId(id);
    try {
      await groupsApi.join(id);
      setMyGroupIds(prev => new Set([...prev, id]));
      showToast('Joined group! 🎊');
    } catch (err: any) {
      showToast(extractError(err, 'Failed to join'), 'error');
    } finally {
      setJoiningId(null);
    }
  };

  const handleLeave = async (id: number) => {
    setJoiningId(id);
    try {
      await groupsApi.leave(id);
      setMyGroupIds(prev => { const n = new Set(prev); n.delete(id); return n; });
      showToast('Left group');
    } catch (err: any) {
      showToast(extractError(err, 'Failed to leave'), 'error');
    } finally {
      setJoiningId(null);
    }
  };

  return (
    <main className={s.page}>
      <SharedNav active="groups" />

      <div className={s.container} style={{ paddingTop: 42, paddingBottom: 72 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 28, gap: 16 }}>
          <div>
            <span className={s.eyebrow}>Community</span>
            <h1 style={{ margin: '12px 0 0', fontSize: 42, fontWeight: 500, lineHeight: 1.05 }}>Society Groups</h1>
            <p style={{ color: 'rgba(232,234,240,0.68)', fontSize: 15, lineHeight: 1.7, marginTop: 10, maxWidth: 540 }}>
              Join groups to filter issues relevant to your wing or block. Create new groups to organize your community.
            </p>
          </div>
          <button
            id="create-group-btn"
            className={s.primaryBtnSm}
            onClick={() => setShowForm(!showForm)}
          >
            {showForm ? '✕ Cancel' : '+ Create Group'}
          </button>
        </div>

        {/* Create form */}
        {showForm && (
          <div className={`${s.card} ${s.fadeIn}`} style={{ padding: 28, marginBottom: 22 }}>
            <h3 style={{ fontSize: 20, fontWeight: 500, marginBottom: 20 }}>Create a New Group</h3>
            <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className={s.formGroup}>
                <label className={s.formLabel} htmlFor="group-name">Group Name</label>
                <input
                  id="group-name"
                  className={s.formInput}
                  placeholder="e.g. Block B Residents, Tower 2 Wing C"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                />
              </div>
              <div className={s.formGroup}>
                <label className={s.formLabel} htmlFor="group-desc">Description (optional)</label>
                <textarea
                  id="group-desc"
                  className={s.formTextarea}
                  placeholder="What is this group for?"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  style={{ minHeight: 80 }}
                />
              </div>
              <div className={s.formCheckRow}>
                <input
                  id="group-public"
                  type="checkbox"
                  checked={form.is_public}
                  onChange={(e) => setForm({ ...form, is_public: e.target.checked })}
                />
                <label htmlFor="group-public">Public group (anyone can join)</label>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="submit" className={s.primaryBtnSm} disabled={creating}>
                  {creating ? <span className={s.spinnerSm} /> : '🏘️ Create Group'}
                </button>
                <button type="button" className={s.secondaryBtnSm} onClick={() => setShowForm(false)}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Groups grid */}
        {loading ? (
          <div className={s.loadingCenter}><span className={s.spinner} /></div>
        ) : allGroups.length === 0 ? (
          <div className={s.emptyState}>
            <div className={s.emptyIcon}>👥</div>
            <h3 className={s.emptyTitle}>No groups yet</h3>
            <p className={s.emptyText}>Create the first group for your society</p>
          </div>
        ) : (
          <div className={s.grid3}>
            {allGroups.map(g => {
              const isMember = myGroupIds.has(g.id);
              return (
                <div key={g.id} className={s.card} style={{ padding: 22 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                    <div
                      style={{
                        width: 44, height: 44, borderRadius: '50%',
                        background: 'linear-gradient(135deg, #4f8ef7, #32d6b8)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '1.2rem',
                      }}
                    >
                      👥
                    </div>
                    {isMember && (
                      <span className={`${s.badge} ${s.statusResolved}`}>
                        ✓ Joined
                      </span>
                    )}
                  </div>

                  <h3 style={{ fontSize: 17, fontWeight: 600, marginBottom: 8 }}>{g.name}</h3>
                  {g.description && (
                    <p style={{ fontSize: 14, color: 'rgba(232,234,240,0.68)', marginBottom: 12, lineHeight: 1.6 }}>
                      {g.description}
                    </p>
                  )}

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                    <span className={s.avatar} style={{ background: g.creator.avatar_color, width: 24, height: 24, fontSize: 10 }}>
                      {g.creator.name[0]}
                    </span>
                    <span style={{ fontSize: 13, color: 'rgba(232,234,240,0.44)' }}>
                      by {g.creator.name} · {g.member_count} members
                    </span>
                  </div>

                  {isMember ? (
                    <button
                      className={s.secondaryBtnSm}
                      onClick={() => handleLeave(g.id)}
                      disabled={joiningId === g.id}
                    >
                      {joiningId === g.id ? <span className={s.spinnerSm} /> : 'Leave Group'}
                    </button>
                  ) : (
                    <button
                      className={s.primaryBtnSm}
                      onClick={() => handleJoin(g.id)}
                      disabled={joiningId === g.id}
                    >
                      {joiningId === g.id ? <span className={s.spinnerSm} /> : 'Join Group'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {toast && <div className={toast.type === 'success' ? s.toastSuccess : s.toastError}>{toast.msg}</div>}
    </main>
  );
}
