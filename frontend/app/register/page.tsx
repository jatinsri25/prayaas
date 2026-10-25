'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { authApi, extractError } from '@/lib/api';
import AuthStory from '@/components/AuthStory';
import styles from '../auth.module.css';

const passwordChecks = [
  { label: 'At least 8 characters', test: (value: string) => value.length >= 8 },
  { label: 'One uppercase letter', test: (value: string) => /[A-Z]/.test(value) },
  { label: 'One lowercase letter', test: (value: string) => /[a-z]/.test(value) },
  { label: 'One number', test: (value: string) => /\d/.test(value) },
];

const isValidPhone = (value: string) => {
  if (!value.trim()) return true;
  const cleaned = value.replace(/[\s\-()]/g, '');
  return /^\+?\d{10,15}$/.test(cleaned);
};

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    name: '',
    email: '',
    flat_number: '',
    phone: '',
    password: '',
    confirm: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const updateField = (field: keyof typeof form, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const validateForm = () => {
    if (form.name.trim().length < 2) return 'Enter your full name.';
    if (!form.email.trim()) return 'Enter your email address.';
    if (!form.flat_number.trim()) return 'Enter your flat number.';
    if (!isValidPhone(form.phone)) return 'Enter a valid phone number, or leave it blank.';
    const failedPasswordCheck = passwordChecks.find((check) => !check.test(form.password));
    if (failedPasswordCheck) return `Password needs ${failedPasswordCheck.label.toLowerCase()}.`;
    if (form.password !== form.confirm) return 'Passwords do not match.';
    return '';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationError = validateForm();
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);
    setError('');
    try {
      await authApi.register({
        name: form.name.trim(),
        email: form.email.trim().toLowerCase(),
        flat_number: form.flat_number.trim(),
        phone: form.phone.trim() || undefined,
        password: form.password,
      });
      router.push('/dashboard');
    } catch (err: unknown) {
      setError(extractError(err, 'Registration failed. Check your connection and try again.'));
    } finally {
      setLoading(false);
    }
  };

  const field = (label: string, id: keyof typeof form, type = 'text', placeholder = '') => (
    <label className={styles.fieldGroup} htmlFor={id}>
      <span className={styles.label}>{label}</span>
      <input
        id={id}
        type={type}
        className={styles.input}
        placeholder={placeholder}
        value={form[id]}
        onChange={(event) => updateField(id, event.target.value)}
        required={id !== 'phone'}
        autoComplete={
          id === 'email'
            ? 'email'
            : id === 'password'
              ? 'new-password'
              : id === 'confirm'
                ? 'new-password'
                : 'on'
        }
      />
    </label>
  );

  return (
    <main className={styles.authPage}>
      <AuthStory register />

      <section className={styles.formPanel}>
        <div className={styles.formCard}>
          <header className={styles.formHeader}>
            <span className={styles.formEyebrow}>THERE IS A PLACE FOR YOU HERE</span>
            <h1>Come on in.</h1>
            <p>A few details, and you are one step closer to your community.</p>
          </header>

          <form className={styles.form} onSubmit={handleSubmit}>
            {field('Full name', 'name', 'text', 'Ravi Kumar')}

            <div className={styles.fieldRow}>
              {field('Email', 'email', 'email', 'you@example.com')}
              {field('Flat number', 'flat_number', 'text', 'B-204')}
            </div>

            {field('Phone optional', 'phone', 'tel', '+91 98765 43210')}

            <div className={styles.fieldRow}>
              {field('Password', 'password', 'password', 'Use a strong password')}
              {field('Confirm password', 'confirm', 'password', 'Repeat password')}
            </div>

            <div className={styles.requirements}>
              <span className={styles.requirementTitle}>Password must include</span>
              <ul>
                {passwordChecks.map((check) => (
                  <li className={check.test(form.password) ? styles.valid : ''} key={check.label}>
                    {check.label}
                  </li>
                ))}
              </ul>
            </div>

            {error ? <div className={styles.errorBox} role="alert">{error}</div> : null}

            <button className={styles.submitButton} disabled={loading} id="register-submit" type="submit">
              {loading ? <span className={styles.spinner} role="status" aria-label="Creating account" /> : 'Create account'}
            </button>
          </form>

          <p className={styles.switchText}>
            Already have an account? <Link href="/login">Sign in</Link>
          </p>
          <Link className={styles.homeLink} href="/">
            Back to home
          </Link>
        </div>
      </section>
    </main>
  );
}
