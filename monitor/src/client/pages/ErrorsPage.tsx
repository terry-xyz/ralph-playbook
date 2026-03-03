import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card,
  Metric,
  Text,
  Title,
  Subtitle,
  Badge,
  Button,
  Flex,
  Grid,
  Table,
  TableHead,
  TableHeaderCell,
  TableBody,
  TableRow,
  TableCell,
  TextInput,
  MultiSelect,
  MultiSelectItem,
  AreaChart,
  BarChart,
} from '@tremor/react';
import {
  api,
  type PaginatedResponse,
  type ErrorTrendResponse,
  type RateLimitResponse,
} from '../api';
import { useWebSocket } from '../hooks/useWebSocket';
import type { ErrorRecord, ErrorCategory } from '@shared/types';

// ── Constants ───────────────────────────────────────────────────────────────

const ERROR_CATEGORIES: ErrorCategory[] = [
  'tool_failure',
  'rate_limit',
  'auth_error',
  'billing_error',
  'server_error',
];

const CATEGORY_COLORS: Record<ErrorCategory, string> = {
  tool_failure: 'red',
  rate_limit: 'amber',
  auth_error: 'violet',
  billing_error: 'fuchsia',
  server_error: 'rose',
};

const CATEGORY_LABELS: Record<ErrorCategory, string> = {
  tool_failure: 'Tool Failure',
  rate_limit: 'Rate Limit',
  auth_error: 'Auth Error',
  billing_error: 'Billing Error',
  server_error: 'Server Error',
};

const PAGE_SIZE = 20;

type SortField = 'timestamp' | 'category' | 'project';
type SortOrder = 'asc' | 'desc';
type ViewMode = 'errors' | 'rate-limits';

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + '...';
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

// ── Component ───────────────────────────────────────────────────────────────

export default function ErrorsPage() {
  const navigate = useNavigate();

  // View toggle: errors log vs rate-limits sub-view (S12 AC 22, 26)
  const [viewMode, setViewMode] = useState<ViewMode>('errors');

  // WebSocket for live updates (S29 AC 29)
  const { lastEvent } = useWebSocket();
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Filter state
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  const [sessionFilter, setSessionFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [toolFilter, setToolFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Table state
  const [page, setPage] = useState(1);
  const [sortField, setSortField] = useState<SortField>('timestamp');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

  // Data state
  const [response, setResponse] = useState<PaginatedResponse<ErrorRecord> | null>(null);
  const [trendData, setTrendData] = useState<ErrorTrendResponse | null>(null);
  const [rateLimitData, setRateLimitData] = useState<RateLimitResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Date range params for API calls
  const dateParams = useMemo(() => {
    const params: Record<string, string> = {};
    if (dateFrom) params.from = new Date(dateFrom).toISOString();
    if (dateTo) params.to = new Date(dateTo + 'T23:59:59').toISOString();
    return params;
  }, [dateFrom, dateTo]);

  // Fetch errors — all filters sent server-side (S22 fix + S29 AC 5)
  const fetchErrors = useCallback(() => {
    setLoading(true);
    setError(null);

    const params: Parameters<typeof api.getAnalyticsErrors>[0] = {
      page,
      limit: PAGE_SIZE,
      sort: sortField,
      order: sortOrder,
      ...dateParams,
    };

    if (sessionFilter.trim()) params.session = sessionFilter.trim();
    if (projectFilter.trim()) params.project = projectFilter.trim();
    if (toolFilter.trim()) params.tool = toolFilter.trim();
    if (categoryFilter.length > 0) params.category = categoryFilter.join(',');

    api
      .getAnalyticsErrors(params)
      .then((data) => {
        setResponse(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load errors');
        setLoading(false);
      });
  }, [page, sessionFilter, projectFilter, toolFilter, categoryFilter, dateParams, sortField, sortOrder]);

  useEffect(() => {
    fetchErrors();
  }, [fetchErrors]);

  // Fetch error trend data (S11)
  useEffect(() => {
    const params: Record<string, string> = { ...dateParams };
    if (sessionFilter.trim()) params.session = sessionFilter.trim();
    if (categoryFilter.length === 1) params.category = categoryFilter[0];

    api
      .getAnalyticsErrorsTrend(params)
      .then(setTrendData)
      .catch(() => { /* trend is non-critical */ });
  }, [dateParams, sessionFilter, categoryFilter]);

  // Fetch rate limit data (S12)
  useEffect(() => {
    if (viewMode !== 'rate-limits') return;
    api
      .getAnalyticsRateLimits(dateParams)
      .then(setRateLimitData)
      .catch(() => { /* non-critical */ });
  }, [viewMode, dateParams]);

  // Reset to page 1 when filters or sort change
  useEffect(() => {
    setPage(1);
  }, [categoryFilter, sessionFilter, projectFilter, toolFilter, dateFrom, dateTo, sortField, sortOrder]);

  // Live updates via WebSocket (S29 AC 29): debounced re-fetch on error events
  useEffect(() => {
    if (!lastEvent || typeof lastEvent !== 'object') return;
    const eventType = (lastEvent as Record<string, unknown>).type as string | undefined;
    if (!eventType) return;

    // Only re-fetch when a relevant error event arrives
    const errorEventTypes = ['PostToolUseFailure', 'ScrapedError', 'Stop'];
    if (!errorEventTypes.includes(eventType)) return;

    // For Stop events, only re-fetch if it looks like an error stop
    if (eventType === 'Stop') {
      const payload = (lastEvent as Record<string, unknown>).payload;
      const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
      if (!payloadStr.includes('error') && !payloadStr.includes('is_error')) return;
    }

    // Debounce re-fetches to batch rapid arrivals
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      fetchErrors();
    }, 2000);

    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [lastEvent, fetchErrors]);

  // Data is now filtered and sorted server-side — use response directly
  const displayErrors = response?.data ?? [];

  // Summary statistics
  const totalErrors = response?.total ?? 0;
  const errorRate = useMemo(() => {
    if (!response || response.data.length === 0) return 0;
    const timestamps = response.data.map((e) => new Date(e.timestamp).getTime());
    const earliest = Math.min(...timestamps);
    const latest = Math.max(...timestamps);
    const hours = Math.max((latest - earliest) / (1000 * 60 * 60), 1);
    return response.total / hours;
  }, [response]);

  const mostCommonCategory = useMemo(() => {
    if (!response || response.data.length === 0) return 'N/A';
    const counts: Record<string, number> = {};
    for (const err of response.data) {
      counts[err.category] = (counts[err.category] || 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return sorted[0] ? CATEGORY_LABELS[sorted[0][0] as ErrorCategory] ?? sorted[0][0] : 'N/A';
  }, [response]);

  const recentSpike = useMemo(() => {
    if (!response || response.data.length < 5) return false;
    const now = Date.now();
    const lastHour = response.data.filter(
      (e) => now - new Date(e.timestamp).getTime() < 60 * 60 * 1000,
    ).length;
    const previousHour = response.data.filter((e) => {
      const age = now - new Date(e.timestamp).getTime();
      return age >= 60 * 60 * 1000 && age < 2 * 60 * 60 * 1000;
    }).length;
    return lastHour > previousHour * 2 && lastHour > 3;
  }, [response]);

  // Error trend chart data (S11)
  const trendChartData = useMemo(() => {
    if (!trendData?.buckets) return [];
    return trendData.buckets.map((b) => ({
      date: formatTimestamp(b.date),
      'Tool Failures': b.categories.tool_failure ?? 0,
      'Rate Limits': b.categories.rate_limit ?? 0,
      'Auth Errors': b.categories.auth_error ?? 0,
      'Billing Errors': b.categories.billing_error ?? 0,
      'Server Errors': b.categories.server_error ?? 0,
    }));
  }, [trendData]);

  // Rate limit chart data (S12)
  const rateLimitChartData = useMemo(() => {
    if (!rateLimitData?.frequency) return [];
    return rateLimitData.frequency.map((f) => ({
      date: formatTimestamp(f.date),
      'Rate Limits': f.count,
    }));
  }, [rateLimitData]);

  const rateLimitModelData = useMemo(() => {
    if (!rateLimitData?.byModel) return [];
    return rateLimitData.byModel.map((m) => ({
      name: m.model,
      'Rate Limits': m.count,
    }));
  }, [rateLimitData]);

  // Pagination
  const totalPages = response ? Math.ceil(response.total / PAGE_SIZE) : 0;

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortOrder('desc');
    }
  }

  function sortIndicator(field: SortField): string {
    if (sortField !== field) return '';
    return sortOrder === 'asc' ? ' \u2191' : ' \u2193';
  }

  return (
    <div className="space-y-6">
      {/* Header with view toggle */}
      <Flex justifyContent="between" alignItems="center">
        <div>
          <Title className="text-2xl font-bold text-gray-100">Error Monitoring</Title>
          <Subtitle className="text-gray-400">
            Track and analyze errors across all sessions
          </Subtitle>
        </div>
        {/* View toggle (S12 AC 22, 26) */}
        <Flex className="gap-2">
          <Button
            size="xs"
            variant={viewMode === 'errors' ? 'primary' : 'secondary'}
            onClick={() => setViewMode('errors')}
            className={viewMode === 'errors' ? 'bg-blue-600 text-white border-blue-600' : 'bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600'}
          >
            Error Log
          </Button>
          <Button
            size="xs"
            variant={viewMode === 'rate-limits' ? 'primary' : 'secondary'}
            onClick={() => setViewMode('rate-limits')}
            className={viewMode === 'rate-limits' ? 'bg-amber-600 text-white border-amber-600' : 'bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600'}
          >
            Rate Limits
          </Button>
        </Flex>
      </Flex>

      {/* Error display */}
      {error && (
        <Card className="bg-red-900/30 ring-red-700">
          <Text className="text-red-300">{error}</Text>
        </Card>
      )}

      {/* Summary Cards */}
      <Grid numItemsMd={2} numItemsLg={4} className="gap-4">
        <Card className="bg-gray-800 ring-gray-700" decoration="top" decorationColor="red">
          <Text className="text-gray-400">Total Errors</Text>
          <Metric className="text-gray-100">{totalErrors.toLocaleString()}</Metric>
        </Card>

        <Card className="bg-gray-800 ring-gray-700" decoration="top" decorationColor="amber">
          <Text className="text-gray-400">Error Rate</Text>
          <Metric className="text-gray-100">{errorRate.toFixed(1)}/hr</Metric>
        </Card>

        <Card className="bg-gray-800 ring-gray-700" decoration="top" decorationColor="violet">
          <Text className="text-gray-400">Most Common</Text>
          <Metric className="text-gray-100 text-lg">{mostCommonCategory}</Metric>
        </Card>

        <Card className="bg-gray-800 ring-gray-700" decoration="top" decorationColor={recentSpike ? 'red' : 'emerald'}>
          <Text className="text-gray-400">Recent Spike</Text>
          <Flex justifyContent="start" alignItems="center" className="gap-2 mt-1">
            <Metric className="text-gray-100">{recentSpike ? 'Yes' : 'No'}</Metric>
            {recentSpike && (
              <Badge color="red" size="sm">
                Active
              </Badge>
            )}
          </Flex>
        </Card>
      </Grid>

      {/* ── Error Log View ─────────────────────────────────────────────── */}
      {viewMode === 'errors' && (
        <>
          {/* Error Rate Over Time Chart (S11) */}
          <Card className="bg-gray-800 ring-gray-700">
            <Title className="text-gray-100 mb-4">Error Rate Over Time</Title>
            {trendChartData.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <Text className="text-gray-400">No error trend data available.</Text>
              </div>
            ) : (
              <AreaChart
                data={trendChartData}
                index="date"
                categories={['Tool Failures', 'Rate Limits', 'Auth Errors', 'Billing Errors', 'Server Errors']}
                colors={['red', 'amber', 'violet', 'fuchsia', 'rose']}
                className="h-64"
                yAxisWidth={40}
                stack
              />
            )}
          </Card>

          {/* Filters */}
          <Card className="bg-gray-800 ring-gray-700">
            <Title className="text-gray-100 mb-4">Filters</Title>
            <Grid numItemsMd={2} numItemsLg={3} className="gap-4">
              <div>
                <Text className="text-gray-400 text-sm mb-1">Category</Text>
                <MultiSelect
                  value={categoryFilter}
                  onValueChange={setCategoryFilter}
                  placeholder="All categories"
                >
                  {ERROR_CATEGORIES.map((cat) => (
                    <MultiSelectItem key={cat} value={cat}>
                      {CATEGORY_LABELS[cat]}
                    </MultiSelectItem>
                  ))}
                </MultiSelect>
              </div>

              <div>
                <Text className="text-gray-400 text-sm mb-1">Session ID</Text>
                <TextInput
                  placeholder="Filter by session..."
                  value={sessionFilter}
                  onChange={(e) => setSessionFilter(e.target.value)}
                />
              </div>

              <div>
                <Text className="text-gray-400 text-sm mb-1">Project</Text>
                <TextInput
                  placeholder="Filter by project..."
                  value={projectFilter}
                  onChange={(e) => setProjectFilter(e.target.value)}
                />
              </div>

              <div>
                <Text className="text-gray-400 text-sm mb-1">Tool</Text>
                <TextInput
                  placeholder="Filter by tool..."
                  value={toolFilter}
                  onChange={(e) => setToolFilter(e.target.value)}
                />
              </div>

              <div className="lg:col-span-2">
                <Text className="text-gray-400 text-sm mb-1">Date Range</Text>
                <Flex className="gap-2">
                  <input
                    type="date"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    className="flex-1 rounded-md border border-gray-600 bg-gray-700 px-2 py-1.5 text-sm text-gray-200 focus:border-blue-500 focus:outline-none"
                  />
                  <input
                    type="date"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    className="flex-1 rounded-md border border-gray-600 bg-gray-700 px-2 py-1.5 text-sm text-gray-200 focus:border-blue-500 focus:outline-none"
                  />
                </Flex>
              </div>
            </Grid>

            {(categoryFilter.length > 0 || sessionFilter || projectFilter || toolFilter || dateFrom || dateTo) && (
              <Flex justifyContent="end" className="mt-3">
                <Button
                  size="xs"
                  variant="secondary"
                  className="bg-gray-700 text-gray-300 border-gray-600"
                  onClick={() => {
                    setCategoryFilter([]);
                    setSessionFilter('');
                    setProjectFilter('');
                    setToolFilter('');
                    setDateFrom('');
                    setDateTo('');
                  }}
                >
                  Clear Filters
                </Button>
              </Flex>
            )}
          </Card>

          {/* Error Log Table */}
          <Card className="bg-gray-800 ring-gray-700">
            <Flex justifyContent="between" alignItems="center" className="mb-4">
              <Title className="text-gray-100">Error Log</Title>
              <Text className="text-gray-400">
                {displayErrors.length} of {totalErrors} errors
              </Text>
            </Flex>

            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Text className="text-gray-400">Loading errors...</Text>
              </div>
            ) : displayErrors.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <Text className="text-gray-400">No errors found matching your filters.</Text>
              </div>
            ) : (
              <>
                <Table>
                  <TableHead>
                    <TableRow className="border-gray-700">
                      <TableHeaderCell
                        className="text-gray-400 cursor-pointer hover:text-gray-200"
                        onClick={() => handleSort('category')}
                      >
                        Category{sortIndicator('category')}
                      </TableHeaderCell>
                      <TableHeaderCell className="text-gray-400">Message</TableHeaderCell>
                      <TableHeaderCell className="text-gray-400">Session ID</TableHeaderCell>
                      <TableHeaderCell className="text-gray-400">Tool</TableHeaderCell>
                      <TableHeaderCell
                        className="text-gray-400 cursor-pointer hover:text-gray-200"
                        onClick={() => handleSort('project')}
                      >
                        Project{sortIndicator('project')}
                      </TableHeaderCell>
                      <TableHeaderCell
                        className="text-gray-400 cursor-pointer hover:text-gray-200"
                        onClick={() => handleSort('timestamp')}
                      >
                        Timestamp{sortIndicator('timestamp')}
                      </TableHeaderCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {displayErrors.map((err) => (
                      <TableRow key={err.id} className="border-gray-700 hover:bg-gray-750">
                        <TableCell>
                          <Badge
                            color={CATEGORY_COLORS[err.category] as never}
                            size="sm"
                          >
                            {CATEGORY_LABELS[err.category] ?? err.category}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Text className="text-gray-300" title={err.message}>
                            {truncate(err.message, 80)}
                          </Text>
                        </TableCell>
                        <TableCell>
                          <button
                            className="text-blue-400 hover:text-blue-300 hover:underline text-sm font-mono"
                            onClick={() => navigate(`/sessions/${err.sessionId}`)}
                            title="View session detail"
                          >
                            {err.sessionId.slice(0, 8)}...
                          </button>
                        </TableCell>
                        <TableCell>
                          <Text className="text-gray-300">{err.tool ?? '-'}</Text>
                        </TableCell>
                        <TableCell>
                          <Text className="text-gray-300">{err.project}</Text>
                        </TableCell>
                        <TableCell>
                          <Text className="text-gray-400 text-sm">
                            {formatTimestamp(err.timestamp)}
                          </Text>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>

                {totalPages > 1 && (
                  <Flex justifyContent="between" alignItems="center" className="mt-4">
                    <Text className="text-gray-400 text-sm">
                      Page {page} of {totalPages}
                    </Text>
                    <Flex className="gap-2">
                      <Button
                        size="xs"
                        variant="secondary"
                        disabled={page <= 1}
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                        className="bg-gray-700 text-gray-300 border-gray-600 disabled:opacity-40"
                      >
                        Previous
                      </Button>
                      <Button
                        size="xs"
                        variant="secondary"
                        disabled={page >= totalPages}
                        onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                        className="bg-gray-700 text-gray-300 border-gray-600 disabled:opacity-40"
                      >
                        Next
                      </Button>
                    </Flex>
                  </Flex>
                )}
              </>
            )}
          </Card>
        </>
      )}

      {/* ── Rate Limit Sub-View (S12) ──────────────────────────────────── */}
      {viewMode === 'rate-limits' && (
        <>
          {/* Rate Limit Frequency Over Time (S12 AC 23) */}
          <Card className="bg-gray-800 ring-gray-700">
            <Title className="text-gray-100 mb-4">Rate Limit Frequency Over Time</Title>
            {rateLimitChartData.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <Text className="text-gray-400">No rate limit events recorded.</Text>
              </div>
            ) : (
              <AreaChart
                data={rateLimitChartData}
                index="date"
                categories={['Rate Limits']}
                colors={['amber']}
                className="h-64"
                yAxisWidth={40}
              />
            )}
          </Card>

          {/* Model Attribution (S12 AC 24) */}
          <Card className="bg-gray-800 ring-gray-700">
            <Title className="text-gray-100 mb-4">Rate Limits by Model</Title>
            {rateLimitModelData.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <Text className="text-gray-400">No rate limit data by model.</Text>
              </div>
            ) : (
              <BarChart
                data={rateLimitModelData}
                index="name"
                categories={['Rate Limits']}
                colors={['amber']}
                className="h-48"
                yAxisWidth={40}
              />
            )}
          </Card>

          {/* Cooldown Patterns (S12 AC 25) */}
          <Card className="bg-gray-800 ring-gray-700">
            <Title className="text-gray-100 mb-4">Cooldown Patterns</Title>
            {!rateLimitData?.cooldowns || rateLimitData.cooldowns.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <Text className="text-gray-400">No cooldown patterns detected.</Text>
              </div>
            ) : (
              <Table>
                <TableHead>
                  <TableRow className="border-gray-700">
                    <TableHeaderCell className="text-gray-400">Start</TableHeaderCell>
                    <TableHeaderCell className="text-gray-400">End</TableHeaderCell>
                    <TableHeaderCell className="text-gray-400">Duration</TableHeaderCell>
                    <TableHeaderCell className="text-gray-400">Model</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rateLimitData.cooldowns.map((cd, i) => (
                    <TableRow key={i} className="border-gray-700">
                      <TableCell>
                        <Text className="text-gray-300 text-sm">{formatTimestamp(cd.start)}</Text>
                      </TableCell>
                      <TableCell>
                        <Text className="text-gray-300 text-sm">{formatTimestamp(cd.end)}</Text>
                      </TableCell>
                      <TableCell>
                        <Badge color="amber" size="sm">{formatDuration(cd.durationMs)}</Badge>
                      </TableCell>
                      <TableCell>
                        <Text className="text-gray-300">{cd.model}</Text>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
