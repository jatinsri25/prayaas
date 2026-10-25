/**
 * Prayaas API Client — Production Hardened
 *
 * Security:
 *  - Access token from in-memory store (not localStorage)
 *  - Refresh token via HttpOnly cookie (automatic)
 *  - CSRF token sent as X-CSRF-Token header
 *  - Auto-refresh on 401 before redirecting to login
 *  - withCredentials for cookie-based auth
 */

import axios, { type InternalAxiosRequestConfig } from 'axios';
import { ReportStreamReader, type ReportStage } from './report-stream';
import {
  getAccessToken,
  setAccessToken,
  setUser,
  clearAuth,
  refreshAccessToken,
  getCsrfToken,
  getUser,
} from './auth';

type ApiValidationDetail = {
  msg?: unknown;
  loc?: unknown;
};

type ApiErrorShape = {
  response?: {
    status?: number;
    data?: {
      detail?: unknown;
      message?: unknown;
    };
  };
  message?: unknown;
  code?: unknown;
};

const toApiError = (err: unknown): ApiErrorShape => {
  if (err && typeof err === 'object') return err as ApiErrorShape;
  return {};
};

const cleanValidationMessage = (message: string) =>
  message.replace(/^Value error,\s*/i, '').replace(/^Input should be\s*/i, 'Must be ');

export function extractError(err: unknown, fallback: string): string {
  const apiError = toApiError(err);
  const detail = apiError.response?.data?.detail;
  const message = apiError.response?.data?.message;

  if (typeof detail === 'string') return cleanValidationMessage(detail);
  if (Array.isArray(detail)) {
    const messages = detail
      .map((entry: ApiValidationDetail) => (typeof entry?.msg === 'string' ? cleanValidationMessage(entry.msg) : ''))
      .filter(Boolean);
    if (messages.length) return messages.join(', ');
  }
  if (typeof message === 'string') return cleanValidationMessage(message);
  if (apiError.code === 'ECONNABORTED' || apiError.code === 'ETIMEDOUT') {
    return 'The request took too long. Please try again.';
  }
  if (apiError.code === 'ERR_NETWORK' || (apiError.response?.status ?? 0) >= 500) {
    return 'Prayaas is temporarily unavailable. Please try again in a moment.';
  }
  if (typeof apiError.message === 'string' && apiError.message !== 'Network Error') return apiError.message;
  return fallback;
}

// Use relative path so Next.js handles the rewrite mapping to backend without CORS
const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

const api = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,  // send cookies (refresh token, CSRF)
  timeout: 15000,
});

// ── Request Interceptor ──────────────────────────────────────────────────────

api.interceptors.request.use((config) => {
  // Attach access token from memory
  const token = getAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  // Attach CSRF token for state-changing requests
  const method = (config.method || '').toUpperCase();
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const csrf = getCsrfToken();
    if (csrf) {
      config.headers['X-CSRF-Token'] = csrf;
    }
  }

  return config;
});

// ── Response Interceptor (auto-refresh on 401) ──────────────────────────────

type RetryableRequest = InternalAxiosRequestConfig & { _retry?: boolean };

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const originalRequest: RetryableRequest | undefined = err.config;

    // Don't retry refresh endpoint itself or already-retried requests
    if (
      err.response?.status === 401 &&
      originalRequest &&
      !originalRequest._retry &&
      !/\/api\/auth\/(refresh|login|register|logout)(?:\?|$)/.test(originalRequest.url || '')
    ) {
      originalRequest._retry = true;
      // All concurrent 401s await the same refresh promise, including failures.
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        originalRequest.headers.Authorization = `Bearer ${getAccessToken()}`;
        return api(originalRequest);
      }

      if (getUser()) {
        return Promise.reject(new Error('Could not reconnect your session. Please try again.'));
      }
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        window.location.replace('/login');
      }
    }

    return Promise.reject(err);
  }
);

export default api;

// ── Auth API ─────────────────────────────────────────────────────────────────

export const authApi = {
  register: async (data: {
    name: string;
    email: string;
    flat_number: string;
    phone?: string;
    password: string;
  }) => {
    const res = await api.post('/api/auth/register', data);
    if (res.data?.access_token) {
      setAccessToken(res.data.access_token);
      setUser(res.data.user);
    }
    return res;
  },

  login: async (data: { email: string; password: string }) => {
    const res = await api.post('/api/auth/login', data);
    if (res.data?.access_token) {
      setAccessToken(res.data.access_token);
      setUser(res.data.user);
    }
    return res;
  },

  logout: async () => {
    try {
      await api.post('/api/auth/logout');
    } catch {
      // ignore logout errors
    }
    clearAuth();
  },

  me: () => api.get('/api/auth/me'),
};

// ── Groups API ────────────────────────────────────────────────────────────────

export const groupsApi = {
  list: () => api.get('/api/groups'),
  myGroups: (signal?: AbortSignal) => api.get('/api/groups/my', { signal }),
  create: (data: { name: string; description?: string; is_public?: boolean }) =>
    api.post('/api/groups', data),
  get: (id: number) => api.get(`/api/groups/${id}`),
  join: (id: number) => api.post(`/api/groups/${id}/join`),
  leave: (id: number) => api.delete(`/api/groups/${id}/leave`),
  delete: (id: number) => api.delete(`/api/groups/${id}`),
};

// ── Problems API ──────────────────────────────────────────────────────────────

export const problemsApi = {
  aiStatus: () => api.get('/api/problems/ai-status'),
  list: (groupId?: number, signal?: AbortSignal) =>
    api.get('/api/problems', { params: groupId ? { group_id: groupId } : {}, signal }),
  get: (id: number) => api.get(`/api/problems/${id}`),
  process: (formData: FormData) =>
    api.post('/api/problems/process', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 120000, // 120 seconds — AI processing can take a while
    }),
  processStream: async <T>(formData: FormData, onProgress: (stage: ReportStage) => void, signal: AbortSignal): Promise<T> => {
    const reader = new ReportStreamReader<T>(onProgress);
    const response = await api.post<string>('/api/problems/process/stream', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      responseType: 'text',
      timeout: 95000,
      signal,
      onDownloadProgress: (progress) => {
        const xhr = progress.event?.target as XMLHttpRequest | undefined;
        if (xhr?.status === 200 && xhr.getResponseHeader('content-type')?.includes('application/x-ndjson')) {
          reader.read(xhr.responseText);
        }
      },
    });
    reader.read(response.data);
    return reader.finish();
  },
  post: (formData: FormData) =>
    api.post('/api/problems', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  upvote: (id: number) => api.post(`/api/problems/${id}/upvote`),
  updateStatus: (id: number, status: string) =>
    api.patch(`/api/problems/${id}/status`, null, { params: { status } }),
  delete: (id: number) => api.delete(`/api/problems/${id}`),

  // Semantic dedup with geofencing (Tab 2)
  checkDuplicate: (data: {
    raw_text: string;
    latitude?: number | null;
    longitude?: number | null;
    radius_meters?: number;
    similarity_threshold?: number;
  }) => api.post('/api/problems/check-duplicate', data),

  // ML Feedback Loop (Tab 4) — log admin corrections to AI fields
  correctAiFields: (id: number, fields: Record<string, string>) =>
    api.patch(`/api/problems/${id}/ai-fields`, fields),
};

// ── Admin / ML Feedback Loop ──────────────────────────────────────────────────

export const adminApi = {
  getFeedbackMetrics: (days: number = 30) =>
    api.get('/api/admin/feedback', { params: { days } }),
  listRecentCorrections: (limit: number = 25) =>
    api.get('/api/admin/feedback/corrections', { params: { limit } }),
  recomputeTrustScores: () => api.post('/api/admin/feedback/recompute'),
  listTrustScores: (weeks: number = 8) =>
    api.get('/api/admin/feedback/trust-scores', { params: { weeks } }),
};

// ── RAG Knowledge Base (Tab 1) ────────────────────────────────────────────────

export const knowledgeApi = {
  ask: (question: string, top_k: number = 4) =>
    api.post('/api/knowledge/ask', { question, top_k }, { timeout: 60000 }),
  listDocuments: () => api.get('/api/knowledge/documents'),
};
