'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { authApi, extractError } from '@/lib/api';
import styles from '../auth.module.css';

export default function LoginPage() {
  const router = useRouter();
  const [form, setForm] = useState({ email: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.email.trim() || !form.password) {
      setError('Enter your email and password.');
      return;
    }

    setLoading(true);
    setError('');
    try {
      await authApi.login({
        email: form.email.trim().toLowerCase(),
        password: form.password,
      });
      router.push('/dashboard');
    } catch (err: unknown) {
      setError(extractError(err, 'Login failed. Check your email, password, and connection.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className={styles.authPage}>
      <section className={styles.visualPanel} aria-label="Prayaas login overview">
        <Link className={styles.brand} href="/">
          <span className={styles.brandMark} aria-hidden="true" />
          <span className={styles.brandText}>
            <strong>Prayaas</strong>
            <span>Powered by intelligence</span>
          </span>
        </Link>

        <div>
          <div className={styles.heroCopy}>
            <span>Resident portal</span>
            <h1>Welcome back to your society workspace.</h1>
            <p>
              Continue tracking resident issues, AI generated solutions, voting momentum and committee progress from
              one focused dashboard.
            </p>
          </div>

          <div className={styles.societyCard}>
            <div className={styles.metricGrid}>
              <div className={styles.metric}>
                <span className={styles.metricLabel}>Open</span>
                <strong>18</strong>
                <span>Issues awaiting action</span>
              </div>
              <div className={styles.metric}>
                <span className={styles.metricLabel}>Resolved</span>
                <strong>148</strong>
                <span>This month</span>
              </div>
              <div className={styles.metric}>
                <span className={styles.metricLabel}>Votes</span>
                <strong>2.4k</strong>
                <span>Resident signals</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.formPanel}>
        <div className={styles.formCard}>
          <header className={styles.formHeader}>
            <span className={styles.formEyebrow}>Sign in</span>
            <h1>Open dashboard</h1>
            <p>Use your registered resident email and password to continue.</p>
          </header>

          <form className={styles.form} onSubmit={handleSubmit}>
            <label className={styles.fieldGroup} htmlFor="email">
              <span className={styles.label}>Email</span>
              <input
                autoComplete="email"
                className={styles.input}
                id="email"
                onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                placeholder="you@example.com"
                required
                type="email"
                value={form.email}
              />
            </label>

            <label className={styles.fieldGroup} htmlFor="password">
              <span className={styles.label}>Password</span>
              <input
                autoComplete="current-password"
                className={styles.input}
                id="password"
                onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
                placeholder="Enter your password"
                required
                type="password"
                value={form.password}
              />
            </label>

            {error ? <div className={styles.errorBox}>{error}</div> : null}

            <button className={styles.submitButton} disabled={loading} id="login-submit" type="submit">
              {loading ? <span className={styles.spinner} /> : 'Sign in'}
            </button>
          </form>

          <p className={styles.switchText}>
            Do not have an account? <Link href="/register">Register now</Link>
          </p>
          <Link className={styles.homeLink} href="/">
            Back to home
          </Link>
        </div>
      </section>
    </main>
  );
}
