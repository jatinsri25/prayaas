'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { authApi } from '@/lib/api';
import { loadUserFromStorage, type AuthUser } from '@/lib/auth';
import BrandMark from './BrandMark';
import s from './shared.module.css';

interface SharedNavProps {
  active: 'dashboard' | 'groups' | 'report' | 'admin' | 'knowledge' | 'search' | 'committee';
}

export default function SharedNav({ active }: SharedNavProps) {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  useEffect(() => { setUser(loadUserFromStorage()); }, []);

  const logout = async () => {
    await authApi.logout();
    router.push('/');
  };

  return (
    <nav className={s.navbar}>
      <div className={s.navInner}>
        <Link className={s.brand} href="/dashboard">
          <BrandMark />
          <span>
            <strong>Prayaas</strong>
            <small>Society workspace</small>
          </span>
        </Link>

        <div className={s.navLinks} aria-label="Navigation">
          <Link href="/search" className={active === 'search' ? s.navLinkActive : ''}>Search</Link>
          {['society_admin', 'superadmin'].includes(user?.role || '') && <Link href="/committee" className={active === 'committee' ? s.navLinkActive : ''}>Digest</Link>}
          {active === 'dashboard' ? (
            <span className={s.navLinkActive}>Dashboard</span>
          ) : (
            <Link href="/dashboard">Dashboard</Link>
          )}
          {active === 'groups' ? (
            <span className={s.navLinkActive}>Groups</span>
          ) : (
            <Link href="/groups">Groups</Link>
          )}
          {active === 'report' ? (
            <span className={s.navLinkActive}>Report Issue</span>
          ) : (
            <Link href="/problems/new">Report Issue</Link>
          )}
          {active === 'knowledge' ? (
            <span className={s.navLinkActive}>Ask LMC</span>
          ) : (
            <Link href="/knowledge">Ask LMC</Link>
          )}
          {active === 'admin' ? (
            <span className={s.navLinkActive}>AI Ops</span>
          ) : (
            <Link href="/admin">AI Ops</Link>
          )}
        </div>

        <div className={s.profileCluster}>
          {user && (
            <span className={s.avatar} style={{ background: user.avatar_color }}>
              {user.name?.[0]?.toUpperCase()}
            </span>
          )}
          <button className={s.ghostBtn} id="logout-btn" onClick={logout} type="button">
            Sign out
          </button>
        </div>
      </div>
      <div className={s.mobileLinks} aria-label="Mobile workspace navigation"><Link href="/dashboard">Dashboard</Link><Link href="/search">Search</Link><Link href="/problems/new">Report</Link><Link href="/groups">Groups</Link>{['society_admin', 'superadmin'].includes(user?.role || '') && <Link href="/committee">Digest</Link>}</div>
    </nav>
  );
}
