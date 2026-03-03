import { useState, useEffect, useMemo, useCallback } from 'react';
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
} from '@tremor/react';
import { api, type PaginatedResponse } from '../api';
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

// ── Component ───────────────────────────────────────────────────────────────

export default function ErrorsPage() {
  const navigate = useNavigate();

  // Filter state
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  const [sessionFilter, setSessionFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Table state
  const [page, setPage] = useState(1);
  const [sortField, setSortField] = useState<SortField>('timestamp');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

  // Data state
  const [response, setResponse] = useState<PaginatedResponse<ErrorRecord> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch errors
  const fetchErrors = useCallback(() => {
    setLoading(true);
    setError(null);

    const params: Record<string, unknown> = {
      page,
      limit: PAGE_SIZE,
    };

    if (sessionFilter.trim()) params.session = sessionFilter.trim();
    if (projectFilter.trim()) params.project = projectFilter.trim();

    api
      .getAnalyticsErrors(params as Parameters<typeof api.getAnalyticsErrors>[0])
      .then((data) => {
        setResponse(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load errors');
        setLoading(false);
      });
  }, [page, sessionFilter, projectFilter]);

  useEffect(() => {
    fetchErrors();
  }, [fetchErrors]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setPage(1);
  }, [categoryFilter, sessionFilter, projectFilter, dateFrom, dateTo]);

  // Client-side filtering + sorting for category, date range (server may not support all filters)
  const filteredErrors = useMemo(() => {
    if (!response) return [];
    let errors = [...response.data];

    // Category filter
    if (categoryFilter.length > 0) {
      errors = errors.filter((e) => categoryFilter.includes(e.category));
    }

    // Date range filter
    if (dateFrom) {
      const fromDate = new Date(dateFrom);
      errors = errors.filter((e) => new Date(e.timestamp) >= fromDate);
    }
    if (dateTo) {
      const toDate = new Date(dateTo);
      toDate.setHours(23, 59, 59, 999);
      errors = errors.filter((e) => new Date(e.timestamp) <= toDate);
    }

    // Sorting
    errors.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'timestamp':
          cmp = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
          break;
        case 'category':
          cmp = a.category.localeCompare(b.category);
          break;
        case 'project':
          cmp = a.project.localeCompare(b.project);
          break;
      }
      return sortOrder === 'asc' ? cmp : -cmp;
    });

    return errors;
  }, [response, categoryFilter, dateFrom, dateTo, sortField, sortOrder]);

  // Summary statistics
  const totalErrors = response?.total ?? 0;
  const errorRate = useMemo(() => {
    if (!response || response.data.length === 0) return 0;
    // Errors per hour based on time span of results
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

  // Pagination
  const totalPages = response ? Math.ceil(response.total / PAGE_SIZE) : 0;

  // Sort handler
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
      {/* Header */}
      <div>
        <Title className="text-2xl font-bold text-gray-100">Error Monitoring</Title>
        <Subtitle className="text-gray-400">
          Track and analyze errors across all sessions
        </Subtitle>
      </div>

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

      {/* Filters */}
      <Card className="bg-gray-800 ring-gray-700">
        <Title className="text-gray-100 mb-4">Filters</Title>
        <Grid numItemsMd={2} numItemsLg={4} className="gap-4">
          {/* Category multi-select */}
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

          {/* Session filter */}
          <div>
            <Text className="text-gray-400 text-sm mb-1">Session ID</Text>
            <TextInput
              placeholder="Filter by session..."
              value={sessionFilter}
              onChange={(e) => setSessionFilter(e.target.value)}
            />
          </div>

          {/* Project filter */}
          <div>
            <Text className="text-gray-400 text-sm mb-1">Project</Text>
            <TextInput
              placeholder="Filter by project..."
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
            />
          </div>

          {/* Date range */}
          <div>
            <Text className="text-gray-400 text-sm mb-1">Date Range</Text>
            <Flex className="gap-2">
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="flex-1 rounded-md border border-gray-600 bg-gray-700 px-2 py-1.5 text-sm text-gray-200 focus:border-blue-500 focus:outline-none"
                placeholder="From"
              />
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="flex-1 rounded-md border border-gray-600 bg-gray-700 px-2 py-1.5 text-sm text-gray-200 focus:border-blue-500 focus:outline-none"
                placeholder="To"
              />
            </Flex>
          </div>
        </Grid>

        {/* Clear filters */}
        {(categoryFilter.length > 0 || sessionFilter || projectFilter || dateFrom || dateTo) && (
          <Flex justifyContent="end" className="mt-3">
            <Button
              size="xs"
              variant="secondary"
              className="bg-gray-700 text-gray-300 border-gray-600"
              onClick={() => {
                setCategoryFilter([]);
                setSessionFilter('');
                setProjectFilter('');
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
            {filteredErrors.length} of {totalErrors} errors
          </Text>
        </Flex>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Text className="text-gray-400">Loading errors...</Text>
          </div>
        ) : filteredErrors.length === 0 ? (
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
                {filteredErrors.map((err) => (
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

            {/* Pagination */}
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
    </div>
  );
}
