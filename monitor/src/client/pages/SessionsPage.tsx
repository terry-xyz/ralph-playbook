import { useState, useEffect, useCallback, useRef } from 'react';
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
  | 'agentName'
  | 'model'
  | 'status'
  | 'totalCost'
  | 'duration'
  | 'turnCount'
  | 'errorCount'
  | 'startTime'
  | 'endTime';

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
  { key: 'sessionId', label: 'Session ID', sortKey: 'session_id' },
  { key: 'project', label: 'Project', sortKey: 'project' },
  { key: 'agentName', label: 'Agent Name', sortKey: 'agent_name' },
  { key: 'model', label: 'Model', sortKey: 'model' },
  { key: 'status', label: 'Status', sortKey: 'status' },
  { key: 'totalCost', label: 'Total Cost', sortKey: 'total_cost' },
  { key: 'duration', label: 'Duration', sortKey: 'start_time' },
  { key: 'turnCount', label: 'Turn Count', sortKey: 'turn_count' },
  { key: 'errorCount', label: 'Error Count', sortKey: 'error_count' },
  { key: 'startTime', label: 'Start Time', sortKey: 'start_time' },
  { key: 'endTime', label: 'End Time', sortKey: 'end_time' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

function formatElapsed(ms: number): string {
  if (ms < 0) return '--';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatDuration(startTime: string, endTime: string | null): string {
  if (!endTime) return '--';
  const ms = new Date(endTime).getTime() - new Date(startTime).getTime();
  return formatElapsed(ms);
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

// ── Live Duration Cell ──────────────────────────────────────────────────────

function LiveDurationCell({ startTime, status }: { startTime: string; status: string }) {
  const [elapsed, setElapsed] = useState(() =>
    Date.now() - new Date(startTime).getTime()
  );

  useEffect(() => {
    if (status !== 'running') return;
    const interval = setInterval(() => {
      setElapsed(Date.now() - new Date(startTime).getTime());
    }, 1000);
    return () => clearInterval(interval);
  }, [startTime, status]);

  return <>{formatElapsed(elapsed)}</>;
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
  const [modelFilter, setModelFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [costMin, setCostMin] = useState<number | undefined>(undefined);
  const [costMax, setCostMax] = useState<number | undefined>(undefined);

  // Search state (Spec 11 ACs 21-26)
  const [searchQuery, setSearchQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Filter dropdown options (populated from data)
  const [availableProjects, setAvailableProjects] = useState<string[]>([]);
  const [availableModels, setAvailableModels] = useState<string[]>([]);

  // Pagination state
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);

  // Filters panel open/close
  const [filtersOpen, setFiltersOpen] = useState(false);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  // Fetch filter options on mount
  useEffect(() => {
    api.getSessionFilters().then(({ projects, models }) => {
      setAvailableProjects(projects);
      setAvailableModels(models);
    }).catch(() => {
      // Silently ignore — filter dropdowns just won't be populated
    });
  }, []);

  // Debounce search input (Spec 11 AC 24: updates as user types)
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setSearchQuery(searchInput);
    }, 300);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [searchInput]);

  // Fetch sessions from API
  const fetchSessions = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const apiSortBy = COLUMNS.find((c) => c.key === sortBy)?.sortKey ?? 'start_time';

      const params: Record<string, unknown> = {
        page,
        limit,
        sortBy: apiSortBy,
        order: sortOrder,
      };

      // Add status filter (first status for server-side, multi handled client-side)
      if (statusFilter.length === 1) {
        params.status = statusFilter[0];
      }

      // Add project filter
      if (projectFilter.trim()) {
        params.project = projectFilter.trim();
      }

      // Add model filter (Spec 11 AC 14)
      if (modelFilter.trim()) {
        params.model = modelFilter.trim();
      }

      // Add date range filters (server-side)
      if (dateFrom) params.from = dateFrom;
      if (dateTo) params.to = dateTo;

      // Add cost range filters (server-side)
      if (costMin !== undefined && !isNaN(costMin)) params.minCost = costMin;
      if (costMax !== undefined && !isNaN(costMax)) params.maxCost = costMax;

      // Add full-text search (Spec 11 ACs 21-26)
      if (searchQuery.trim()) {
        params.search = searchQuery.trim();
      }

      const result: PaginatedResponse<Session> = await api.getSessions(
        params as Parameters<typeof api.getSessions>[0],
      );

      // Client-side status filter for multi-select (server only handles single status)
      let filtered = result.data;
      if (statusFilter.length > 1) {
        filtered = filtered.filter((s) => statusFilter.includes(s.status));
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
  }, [page, limit, sortBy, sortOrder, statusFilter, projectFilter, modelFilter, dateFrom, dateTo, costMin, costMax, searchQuery]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [statusFilter, projectFilter, modelFilter, dateFrom, dateTo, costMin, costMax, searchQuery, limit]);

  // Handle column header click for sorting
  function handleSort(column: SortField) {
    if (column === 'duration') return; // Duration is derived, not directly sortable
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
    setModelFilter('');
    setDateFrom('');
    setDateTo('');
    setCostMin(undefined);
    setCostMax(undefined);
    setSearchInput('');
    setSearchQuery('');
  }

  const hasActiveFilters =
    statusFilter.length > 0 ||
    projectFilter.trim() !== '' ||
    modelFilter.trim() !== '' ||
    dateFrom !== '' ||
    dateTo !== '' ||
    costMin !== undefined ||
    costMax !== undefined ||
    searchQuery.trim() !== '';

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

      {/* Search Bar (Spec 11 ACs 21-26) */}
      <div className="relative">
        <TextInput
          placeholder="Search sessions by prompt text, tool inputs, responses..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="bg-gray-800"
        />
        {searchInput && (
          <button
            onClick={() => { setSearchInput(''); setSearchQuery(''); }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-200 text-sm"
          >
            Clear
          </button>
        )}
      </div>

      {/* Filters Panel */}
      {filtersOpen && (
        <Card className="bg-gray-800 ring-gray-700">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            {/* Status multi-select */}
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">Status</label>
              <StatusMultiSelect selected={statusFilter} onChange={setStatusFilter} />
            </div>

            {/* Project filter (Spec 11 AC 15: populated from data) */}
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">Project</label>
              <Select
                value={projectFilter}
                onValueChange={setProjectFilter}
                placeholder="All Projects"
                className="bg-gray-900"
              >
                {availableProjects.map((p) => (
                  <SelectItem key={p} value={p}>{p}</SelectItem>
                ))}
              </Select>
            </div>

            {/* Model filter (Spec 11 AC 14: populated from data) */}
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">Model</label>
              <Select
                value={modelFilter}
                onValueChange={setModelFilter}
                placeholder="All Models"
                className="bg-gray-900"
              >
                {availableModels.map((m) => (
                  <SelectItem key={m} value={m}>{m}</SelectItem>
                ))}
              </Select>
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

                    {/* Agent Name (Spec 11 AC 1) */}
                    <TableCell className="text-gray-200 text-sm whitespace-nowrap max-w-[160px] truncate">
                      {session.agentName || '--'}
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

                    {/* Duration (Spec 11 AC 3: live-updating for running sessions) */}
                    <TableCell className="text-gray-300 text-sm whitespace-nowrap">
                      {session.status === 'running' ? (
                        <LiveDurationCell startTime={session.startTime} status={session.status} />
                      ) : (
                        formatDuration(session.startTime, session.endTime)
                      )}
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
