import { useState, useEffect, useCallback } from 'react';
import {
  Card,
  Table,
  TableHead,
  TableHeaderCell,
  TableBody,
  TableRow,
  TableCell,
  Badge,
  Select,
  SelectItem,
  TextInput,
  NumberInput,
  Button,
} from '@tremor/react';
import { api, type PaginatedResponse } from '@client/api';
import SessionDetailPanel from '../components/SessionDetailPanel';
import type { Session, SessionStatus } from '@shared/types';

// ── Constants ────────────────────────────────────────────────────────────────

type SortField =
  | 'sessionId'
  | 'project'
  | 'model'
  | 'status'
  | 'totalCost'
  | 'duration'
  | 'turnCount'
  | 'errorCount'
  | 'startTime'
  | 'endTime'
  | 'inferredPhase';

type SortOrder = 'asc' | 'desc';

const PAGE_SIZES = [10, 25, 50, 100] as const;

const STATUS_OPTIONS: SessionStatus[] = ['running', 'completed', 'errored', 'stale'];

const STATUS_COLORS: Record<SessionStatus, string> = {
  running: 'green',
  completed: 'blue',
  errored: 'red',
  stale: 'yellow',
};

interface ColumnDef {
  key: SortField;
  label: string;
  sortKey: string; // API sort key
}

const COLUMNS: ColumnDef[] = [
  { key: 'sessionId', label: 'Session ID', sortKey: 'sessionId' },
  { key: 'project', label: 'Project', sortKey: 'project' },
  { key: 'model', label: 'Model', sortKey: 'model' },
  { key: 'status', label: 'Status', sortKey: 'status' },
  { key: 'totalCost', label: 'Total Cost', sortKey: 'totalCost' },
  { key: 'duration', label: 'Duration', sortKey: 'startTime' },
  { key: 'turnCount', label: 'Turn Count', sortKey: 'turnCount' },
  { key: 'errorCount', label: 'Error Count', sortKey: 'errorCount' },
  { key: 'startTime', label: 'Start Time', sortKey: 'startTime' },
  { key: 'endTime', label: 'End Time', sortKey: 'endTime' },
  { key: 'inferredPhase', label: 'Phase', sortKey: 'inferredPhase' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

function formatDuration(startTime: string, endTime: string | null): string {
  if (!endTime) return '--';
  const ms = new Date(endTime).getTime() - new Date(startTime).getTime();
  if (ms < 0) return '--';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatTimestamp(ts: string | null): string {
  if (!ts) return '--';
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function truncateId(id: string, maxLen = 12): string {
  if (id.length <= maxLen) return id;
  return id.slice(0, maxLen) + '...';
}

// ── Sort Indicator ───────────────────────────────────────────────────────────

function SortIndicator({
  column,
  sortBy,
  order,
}: {
  column: SortField;
  sortBy: SortField;
  order: SortOrder;
}) {
  if (column !== sortBy) {
    return <span className="ml-1 text-gray-600 text-xs select-none">&#x25B4;&#x25BE;</span>;
  }
  return (
    <span className="ml-1 text-blue-400 text-xs select-none">
      {order === 'asc' ? '\u25B2' : '\u25BC'}
    </span>
  );
}

// ── Status Multi-Select ──────────────────────────────────────────────────────

function StatusMultiSelect({
  selected,
  onChange,
}: {
  selected: SessionStatus[];
  onChange: (statuses: SessionStatus[]) => void;
}) {
  function toggle(status: SessionStatus) {
    if (selected.includes(status)) {
      onChange(selected.filter((s) => s !== status));
    } else {
      onChange([...selected, status]);
    }
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {STATUS_OPTIONS.map((status) => {
        const isActive = selected.includes(status);
        return (
          <button
            key={status}
            onClick={() => toggle(status)}
            className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors capitalize ${
              isActive
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
            }`}
          >
            {status}
          </button>
        );
      })}
    </div>
  );
}

// ── Pagination Controls ──────────────────────────────────────────────────────

function PaginationControls({
  page,
  totalPages,
  total,
  limit,
  onPageChange,
  onLimitChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  limit: number;
  onPageChange: (p: number) => void;
  onLimitChange: (l: number) => void;
}) {
  // Build page number buttons, showing a window around the current page
  function getPageNumbers(): (number | 'ellipsis')[] {
    const pages: (number | 'ellipsis')[] = [];
    const maxVisible = 7;

    if (totalPages <= maxVisible) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      const start = Math.max(2, page - 1);
      const end = Math.min(totalPages - 1, page + 1);

      if (start > 2) pages.push('ellipsis');
      for (let i = start; i <= end; i++) pages.push(i);
      if (end < totalPages - 1) pages.push('ellipsis');
      pages.push(totalPages);
    }
    return pages;
  }

  const startItem = (page - 1) * limit + 1;
  const endItem = Math.min(page * limit, total);

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-4">
      {/* Page size selector */}
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <span>Show</span>
        <select
          value={limit}
          onChange={(e) => onLimitChange(Number(e.target.value))}
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200 text-sm focus:ring-blue-500 focus:border-blue-500"
        >
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
        <span>per page</span>
        <span className="ml-2 text-gray-500">
          {total > 0 ? `${startItem}-${endItem} of ${total}` : '0 results'}
        </span>
      </div>

      {/* Page navigation */}
      <div className="flex items-center gap-1">
        <button
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="px-2.5 py-1.5 text-sm rounded border border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Prev
        </button>

        {getPageNumbers().map((p, i) =>
          p === 'ellipsis' ? (
            <span key={`ellipsis-${i}`} className="px-1.5 text-gray-500">
              ...
            </span>
          ) : (
            <button
              key={p}
              onClick={() => onPageChange(p)}
              className={`px-2.5 py-1.5 text-sm rounded border transition-colors ${
                p === page
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-700'
              }`}
            >
              {p}
            </button>
          ),
        )}

        <button
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="px-2.5 py-1.5 text-sm rounded border border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Next
        </button>
      </div>
    </div>
  );
}

// ── Main Page Component ──────────────────────────────────────────────────────

export default function SessionsPage() {
  // Data state
  const [sessions, setSessions] = useState<Session[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  // Sort state
  const [sortBy, setSortBy] = useState<SortField>('startTime');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

  // Filter state
  const [statusFilter, setStatusFilter] = useState<SessionStatus[]>([]);
  const [projectFilter, setProjectFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [costMin, setCostMin] = useState<number | undefined>(undefined);
  const [costMax, setCostMax] = useState<number | undefined>(undefined);

  // Pagination state
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);

  // Filters panel open/close
  const [filtersOpen, setFiltersOpen] = useState(false);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  // Fetch sessions from API
  const fetchSessions = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const apiSortBy = COLUMNS.find((c) => c.key === sortBy)?.sortKey ?? 'startTime';

      const params: Record<string, unknown> = {
        page,
        limit,
        sortBy: apiSortBy,
        order: sortOrder,
      };

      // Add status filter (comma-separated for multi-select)
      if (statusFilter.length > 0) {
        params.status = statusFilter.join(',');
      }

      // Add project filter
      if (projectFilter.trim()) {
        params.project = projectFilter.trim();
      }

      const result: PaginatedResponse<Session> = await api.getSessions(
        params as Parameters<typeof api.getSessions>[0],
      );

      // Client-side filtering for date range and cost range
      // (in case the API doesn't support these filters natively)
      let filtered = result.data;

      if (dateFrom) {
        const fromDate = new Date(dateFrom).getTime();
        filtered = filtered.filter((s) => new Date(s.startTime).getTime() >= fromDate);
      }
      if (dateTo) {
        const toDate = new Date(dateTo).getTime() + 86400000; // end of day
        filtered = filtered.filter((s) => new Date(s.startTime).getTime() <= toDate);
      }
      if (costMin !== undefined && !isNaN(costMin)) {
        filtered = filtered.filter((s) => s.totalCost >= costMin);
      }
      if (costMax !== undefined && !isNaN(costMax)) {
        filtered = filtered.filter((s) => s.totalCost <= costMax);
      }

      setSessions(filtered);
      setTotal(result.total);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to fetch sessions';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [page, limit, sortBy, sortOrder, statusFilter, projectFilter, dateFrom, dateTo, costMin, costMax]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [statusFilter, projectFilter, dateFrom, dateTo, costMin, costMax, limit]);

  // Handle column header click for sorting
  function handleSort(column: SortField) {
    if (sortBy === column) {
      setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(column);
      setSortOrder('desc');
    }
  }

  // Handle row click — open side panel
  function handleRowClick(sessionId: string) {
    setSelectedSessionId(sessionId);
  }

  // Clear all filters
  function clearFilters() {
    setStatusFilter([]);
    setProjectFilter('');
    setDateFrom('');
    setDateTo('');
    setCostMin(undefined);
    setCostMax(undefined);
  }

  const hasActiveFilters =
    statusFilter.length > 0 ||
    projectFilter.trim() !== '' ||
    dateFrom !== '' ||
    dateTo !== '' ||
    costMin !== undefined ||
    costMax !== undefined;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-100">Sessions</h1>
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            variant="secondary"
            onClick={() => setFiltersOpen((prev) => !prev)}
            className="text-gray-300"
          >
            {filtersOpen ? 'Hide Filters' : 'Show Filters'}
          </Button>
          {hasActiveFilters && (
            <Button size="xs" variant="light" onClick={clearFilters} className="text-red-400">
              Clear Filters
            </Button>
          )}
          <Button size="xs" variant="secondary" onClick={fetchSessions} className="text-gray-300">
            Refresh
          </Button>
        </div>
      </div>

      {/* Filters Panel */}
      {filtersOpen && (
        <Card className="bg-gray-800 ring-gray-700">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Status multi-select */}
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">Status</label>
              <StatusMultiSelect selected={statusFilter} onChange={setStatusFilter} />
            </div>

            {/* Project filter */}
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">Project</label>
              <TextInput
                placeholder="Filter by project..."
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
                className="bg-gray-900"
              />
            </div>

            {/* Date range */}
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">Date Range</label>
              <div className="flex gap-2">
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="From"
                />
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="To"
                />
              </div>
            </div>

            {/* Cost range */}
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">Cost Range ($)</label>
              <div className="flex gap-2">
                <NumberInput
                  placeholder="Min"
                  value={costMin}
                  onValueChange={setCostMin}
                  min={0}
                  step={0.01}
                  className="bg-gray-900"
                />
                <NumberInput
                  placeholder="Max"
                  value={costMax}
                  onValueChange={setCostMax}
                  min={0}
                  step={0.01}
                  className="bg-gray-900"
                />
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Error display */}
      {error && (
        <Card className="bg-red-900/30 ring-red-700">
          <p className="text-red-300 text-sm">Error loading sessions: {error}</p>
        </Card>
      )}

      {/* Sessions Table */}
      <Card className="bg-gray-800 ring-gray-700 overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHead>
              <TableRow className="border-b border-gray-700">
                {COLUMNS.map((col) => (
                  <TableHeaderCell
                    key={col.key}
                    className="cursor-pointer select-none text-gray-400 hover:text-gray-200 transition-colors whitespace-nowrap"
                    onClick={() => handleSort(col.key)}
                  >
                    <span className="inline-flex items-center">
                      {col.label}
                      <SortIndicator column={col.key} sortBy={sortBy} order={sortOrder} />
                    </span>
                  </TableHeaderCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={COLUMNS.length}>
                    <div className="flex items-center justify-center py-8">
                      <div className="flex items-center gap-3 text-gray-400">
                        <svg
                          className="animate-spin h-5 w-5"
                          viewBox="0 0 24 24"
                          fill="none"
                        >
                          <circle
                            className="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            strokeWidth="4"
                          />
                          <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                          />
                        </svg>
                        Loading sessions...
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
              ) : sessions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={COLUMNS.length}>
                    <div className="text-center py-8 text-gray-500">
                      {hasActiveFilters
                        ? 'No sessions match the current filters.'
                        : 'No sessions found.'}
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                sessions.map((session) => (
                  <TableRow
                    key={session.sessionId}
                    className="cursor-pointer border-b border-gray-700/50 hover:bg-gray-700/30 transition-colors"
                    onClick={() => handleRowClick(session.sessionId)}
                  >
                    {/* Session ID */}
                    <TableCell className="text-blue-400 font-mono text-xs whitespace-nowrap">
                      {truncateId(session.sessionId)}
                    </TableCell>

                    {/* Project */}
                    <TableCell className="text-gray-200 text-sm whitespace-nowrap max-w-[160px] truncate">
                      {session.project || '--'}
                    </TableCell>

                    {/* Model */}
                    <TableCell className="text-gray-300 text-sm whitespace-nowrap">
                      {session.model || '--'}
                    </TableCell>

                    {/* Status */}
                    <TableCell>
                      <Badge color={STATUS_COLORS[session.status] as any} size="xs">
                        {session.status}
                      </Badge>
                    </TableCell>

                    {/* Total Cost */}
                    <TableCell className="text-gray-200 text-sm font-mono whitespace-nowrap">
                      {formatCost(session.totalCost)}
                    </TableCell>

                    {/* Duration */}
                    <TableCell className="text-gray-300 text-sm whitespace-nowrap">
                      {formatDuration(session.startTime, session.endTime)}
                    </TableCell>

                    {/* Turn Count */}
                    <TableCell className="text-gray-300 text-sm text-center">
                      {session.turnCount}
                    </TableCell>

                    {/* Error Count */}
                    <TableCell className="text-sm text-center">
                      <span className={session.errorCount > 0 ? 'text-red-400 font-medium' : 'text-gray-500'}>
                        {session.errorCount}
                      </span>
                    </TableCell>

                    {/* Start Time */}
                    <TableCell className="text-gray-400 text-xs whitespace-nowrap">
                      {formatTimestamp(session.startTime)}
                    </TableCell>

                    {/* End Time */}
                    <TableCell className="text-gray-400 text-xs whitespace-nowrap">
                      {formatTimestamp(session.endTime)}
                    </TableCell>

                    {/* Phase */}
                    <TableCell className="text-gray-300 text-xs whitespace-nowrap">
                      {session.inferredPhase || '--'}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {/* Pagination */}
        {!loading && total > 0 && (
          <PaginationControls
            page={page}
            totalPages={totalPages}
            total={total}
            limit={limit}
            onPageChange={setPage}
            onLimitChange={setLimit}
          />
        )}
      </Card>

      {/* Session Detail Side Panel */}
      {selectedSessionId && (
        <SessionDetailPanel
          sessionId={selectedSessionId}
          onClose={() => setSelectedSessionId(null)}
        />
      )}
    </div>
  );
}
