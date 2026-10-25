import api from "./api";

export interface SearchFilters {
  status: string | null;
  category: string | null;
  location: string | null;
  keywords: string[];
  created_after: string | null;
  created_before: string | null;
  sort: "newest" | "most_votes";
}

export interface SearchResult {
  id: number;
  title: string;
  formatted_description: string;
  description_en: string | null;
  description_hi: string | null;
  status: string;
  category: string;
  location: string | null;
  upvotes: number;
}

export interface SearchResponse {
  filters: SearchFilters;
  cache_hit: boolean;
  mode: "ai" | "filters";
  results: SearchResult[];
  has_more: boolean;
}

export interface WeeklyDigest {
  week_start: string;
  snapshot: {
    week_start: string;
    week_end: string;
    timezone: string;
    total: number;
    statuses: Record<string, number>;
    categories: Record<string, number>;
    issues: {
      id: number;
      title: string;
      status: string;
      severity: string;
      upvotes: number;
    }[];
  };
  summary_en: string;
  summary_hi: string;
  source_ids: number[];
  generation_mode: "ai_draft" | "counts_only" | "preparing";
  model_used: string | null;
  revision: number;
  edited: boolean;
  created_at: string;
}

export type DigestResponse =
  | WeeklyDigest
  | { week_start: string; week_end: string; generation_mode: "not_generated" };

export const insightsApi = {
  search: (
    payload: {
      query?: string;
      mode: "ai" | "filters";
      filters?: SearchFilters;
      group_id?: number;
    },
    signal: AbortSignal,
  ) =>
    api.post<SearchResponse>("/api/insights/search", payload, {
      signal,
      timeout: 55000,
    }),
  digest: () => api.get<DigestResponse>("/api/insights/digest"),
  generateDigest: () =>
    api.post<WeeklyDigest>("/api/insights/digest", {}, { timeout: 55000 }),
  saveDigest: (
    week: string,
    summary_en: string,
    summary_hi: string,
    revision: number,
  ) =>
    api.patch<WeeklyDigest>(`/api/insights/digest/${week}`, {
      summary_en,
      summary_hi,
      revision,
    }),
};
