import type {
  Session,
  EventRecord,
  ErrorRecord,
  Config,
  GuardrailLogEntry,
} from '@shared/types';

// ── Error class ──────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function qs(params: Record<string, unknown> | undefined): string {
  if (!params) return '';
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null,
  );
  if (entries.length === 0) return '';
  const search = new URLSearchParams();
  for (const [k, v] of entries) {
    search.set(k, String(v));
  }
  return `?${search.toString()}`;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
  } catch (err) {
    throw new ApiError(
      `Network error: ${err instanceof Error ? err.message : 'unknown'}`,
      0,
    );
  }

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text().catch(() => null);
    }
    throw new ApiError(
      `HTTP ${response.status}: ${response.statusText}`,
      response.status,
      body,
    );
  }

  return response.json() as Promise<T>;
}

// ── Response types ───────────────────────────────────────────────────────────

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface AnalyticsOverview {
  activeSessions: number;
  totalSessions: number;
  totalCost: number;
  totalTokens: number;
  totalErrors: number;
  errorRate: number;
  rateLimitIncidents: number;
  toolCallsPerMin: number[];
}

export interface CostDimension {
  name: string;
  cost: number;
}

export interface CostAnalyticsResponse {
  breakdown: CostDimension[];
  totalCost: number;
  cacheHitRate: number;
  tokensSaved: number;
}

export interface CostTrendPoint {
  date: string;
  cost: number;
}

export interface CostTrendResponse {
  current: CostTrendPoint[];
  previous: CostTrendPoint[];
  granularity: string;
}

export interface BudgetAlert {
  type: 'daily' | 'session';
  limit: number;
  actual: number;
  sessionId?: string;
}

export interface BudgetAlertsResponse {
  alerts: BudgetAlert[];
}

export interface ErrorTrendBucket {
  date: string;
  count: number;
  categories: Record<string, number>;
}

export interface ErrorTrendResponse {
  buckets: ErrorTrendBucket[];
  overlays: Array<{ date: string; type: string; label: string }>;
  bucketMs: number;
}

export interface RateLimitFrequency {
  date: string;
  count: number;
}

export interface RateLimitByModel {
  model: string;
  count: number;
}

export interface RateLimitCooldown {
  start: string;
  end: string;
  durationMs: number;
  model: string;
}

export interface RateLimitResponse {
  frequency: RateLimitFrequency[];
  byModel: RateLimitByModel[];
  cooldowns: RateLimitCooldown[];
}

export interface SearchResult {
  type: 'session' | 'event' | 'error';
  id: string;
  sessionId: string;
  summary: string;
  timestamp: string;
}

// ── API client ───────────────────────────────────────────────────────────────

export const api = {
  getSessions(params?: {
    page?: number;
    limit?: number;
    status?: string;
    project?: string;
    model?: string;
    search?: string;
    sortBy?: string;
    order?: 'asc' | 'desc';
    from?: string;
    to?: string;
    minCost?: number;
    maxCost?: number;
  }): Promise<PaginatedResponse<Session>> {
    return request(`/api/sessions${qs(params)}`);
  },

  getSessionFilters(): Promise<{ projects: string[]; models: string[] }> {
    return request('/api/sessions/filters');
  },

  getSession(id: string): Promise<Session> {
    return request(`/api/sessions/${encodeURIComponent(id)}`);
  },

  getSessionEvents(
    id: string,
    params?: { page?: number; limit?: number },
  ): Promise<PaginatedResponse<EventRecord>> {
    return request(`/api/sessions/${encodeURIComponent(id)}/events${qs(params)}`);
  },

  getAnalyticsOverview(params?: {
    range?: string;
  }): Promise<AnalyticsOverview> {
    return request(`/api/analytics/overview${qs(params)}`);
  },

  getAnalyticsCosts(params?: {
    dimension?: string;
    from?: string;
    to?: string;
  }): Promise<CostAnalyticsResponse> {
    return request(`/api/analytics/costs${qs(params)}`);
  },

  getAnalyticsCostTrend(params?: {
    granularity?: string;
    from?: string;
    to?: string;
  }): Promise<CostTrendResponse> {
    return request(`/api/analytics/costs/trend${qs(params)}`);
  },

  getBudgetAlerts(): Promise<BudgetAlertsResponse> {
    return request('/api/analytics/budget-alerts');
  },

  getAnalyticsErrors(params?: {
    page?: number;
    limit?: number;
    session?: string;
    project?: string;
  }): Promise<PaginatedResponse<ErrorRecord>> {
    return request(`/api/analytics/errors${qs(params)}`);
  },

  getAnalyticsErrorsTrend(params?: {
    from?: string;
    to?: string;
    session?: string;
    category?: string;
  }): Promise<ErrorTrendResponse> {
    return request(`/api/analytics/errors/trend${qs(params)}`);
  },

  getAnalyticsRateLimits(params?: {
    from?: string;
    to?: string;
  }): Promise<RateLimitResponse> {
    return request(`/api/analytics/errors/rate-limits${qs(params)}`);
  },

  getConfig(): Promise<Config> {
    return request('/api/config');
  },

  updateConfig(body: Record<string, unknown>): Promise<Config> {
    return request('/api/config', {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  },

  search(
    q: string,
    params?: { limit?: number },
  ): Promise<SearchResult[]> {
    return request(`/api/search${qs({ q, ...params })}`);
  },

  getGuardrailsLog(params?: {
    page?: number;
    limit?: number;
    rule_name?: string;
    action?: string;
  }): Promise<PaginatedResponse<GuardrailLogEntry>> {
    return request(`/api/guardrails/log${qs(params)}`);
  },

  purgeData(): Promise<{ success: boolean; retentionDays: number; cutoffDate: string }> {
    return request('/api/data/purge', { method: 'POST' });
  },
};
