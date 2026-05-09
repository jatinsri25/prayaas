/**
 * Prayaas Auth — Secure In-Memory Token Management
 *
 * Access token is stored in JavaScript memory ONLY (not localStorage).
 * Refresh token is handled via HttpOnly cookie (browser manages automatically).
 *
 * This prevents XSS attacks from stealing tokens.
 */

import api from './api';

// ── In-Memory Token Store ─────────────────────────────────────────────────────
// Access token lives only in JS memory — cleared on page refresh.
// On refresh, the app calls /api/auth/refresh with the HttpOnly cookie.

let _accessToken: string | null = null;
let _user: any = null;
let _refreshPromise: Promise<boolean> | null = null;

export function getAccessToken(): string | null {
  return _accessToken;
}

export function setAccessToken(token: string | null): void {
  _accessToken = token;
}

export function getUser(): any {
  return _user;
}

export function setUser(user: any): void {
  _user = user;
  // Also store user info (not token) in localStorage for display purposes
  if (typeof window !== 'undefined') {
    if (user) {
      localStorage.setItem('prayaas_user', JSON.stringify(user));
    } else {
      localStorage.removeItem('prayaas_user');
    }
  }
}

export function loadUserFromStorage(): any {
  if (typeof window === 'undefined') return null;
  try {
    const stored = localStorage.getItem('prayaas_user');
    if (stored) {
      _user = JSON.parse(stored);
      return _user;
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

export function clearAuth(): void {
  _accessToken = null;
  _user = null;
  if (typeof window !== 'undefined') {
    localStorage.removeItem('prayaas_user');
    // Legacy cleanup
    localStorage.removeItem('prayaas_token');
  }
}

/**
 * Attempt to refresh the access token using the HttpOnly refresh cookie.
 * Returns true on success, false on failure.
 * Deduplicates concurrent refresh calls.
 */
export async function refreshAccessToken(): Promise<boolean> {
  // Deduplicate concurrent refresh attempts
  if (_refreshPromise) {
    return _refreshPromise;
  }

  _refreshPromise = (async () => {
    try {
      const response = await api.post('/api/auth/refresh', {}, {
        withCredentials: true,  // send the HttpOnly cookie
      });

      if (response.data?.access_token) {
        setAccessToken(response.data.access_token);
        if (response.data.user) {
          setUser(response.data.user);
        }
        return true;
      }
      return false;
    } catch {
      clearAuth();
      return false;
    } finally {
      _refreshPromise = null;
    }
  })();

  return _refreshPromise;
}

/**
 * Initialize auth state on app load.
 * Tries to refresh the access token if the user was previously logged in.
 */
export async function initAuth(): Promise<boolean> {
  const storedUser = loadUserFromStorage();
  if (!storedUser) {
    return false;
  }

  // Try to get a new access token via refresh cookie
  return refreshAccessToken();
}

/**
 * Get CSRF token from cookie (set by backend on login).
 */
export function getCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(/csrf_token=([^;]+)/);
  return match ? match[1] : null;
}

export function isAuthenticated(): boolean {
  return _accessToken !== null;
}
