'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { authApi, extractError } from '@/lib/api';
import AuthStory from '@/components/AuthStory';
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
      <AuthStory />

      <section className={styles.formPanel}>
        <div className={styles.formCard}>
          <header className={styles.formHeader}>
            <span className={styles.formEyebrow}>YOUR NEIGHBOURHOOD AWAITS</span>
            <h1>Welcome back.</h1>
            <p>Sign in to see what is happening in your society.</p>
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

            {error ? <div className={styles.errorBox} role="alert">{error}</div> : null}

            <button className={styles.submitButton} disabled={loading} id="login-submit" type="submit">
              {loading ? <span className={styles.spinner} role="status" aria-label="Signing in" /> : 'Sign in'}
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
