import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card,
  Metric,
  Badge,
  BadgeDelta,
  Select,
  SelectItem,
  SparkAreaChart,
  Text,
  Title,
  Subtitle,
} from '@tremor/react';
import { api, type AnalyticsOverview } from '../api';
import { useWebSocket } from '../hooks/useWebSocket';
import type { Session, SessionStatus } from '@shared/types';

// ── Constants ────────────────────────────────────────────────────────────────

type CostRange = 'today' | 'week' | 'month';

const COST_RANGE_LABELS: Record<CostRange, string> = {
  today: 'Today',
  week: 'This Week',
  month: 'This Month',
};

const COST_RANGE_API: Record<CostRange, string> = {
  today: 'today',
  week: 'this week',
  month: 'this month',
};

const STATUS_COLORS: Record<SessionStatus, string> = {
  running: 'green',
  completed: 'blue',
  errored: 'red',
  stale: 'yellow',
};

const STATUS_BG: Record<SessionStatus, string> = {
  running: 'bg-green-500/10 text-green-400 ring-green-500/30',
  completed: 'bg-blue-500/10 text-blue-400 ring-blue-500/30',
  errored: 'bg-red-500/10 text-red-400 ring-red-500/30',
  stale: 'bg-yellow-500/10 text-yellow-400 ring-yellow-500/30',
};

const KANBAN_COLUMNS: { key: SessionStatus; label: string; headerColor: string }[] = [
  { key: 'running', label: 'Running', headerColor: 'border-green-500' },
  { key: 'completed', label: 'Completed', headerColor: 'border-blue-500' },
  { key: 'errored', label: 'Errored', headerColor: 'border-red-500' },
];

const POLL_INTERVAL_MS = 15_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatCost(cost: number): string {
  if (cost < 0.01 && cost > 0) return '<$0.01';
  return `$${cost.toFixed(2)}`;
}

function formatDuration(startTime: string, endTime: string | null): string {
  const start = new Date(startTime).getTime();
  const end = endTime ? new Date(endTime).getTime() : Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));

  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function truncateId(id: string, len = 12): string {
  if (id.length <= len) return id;
  return id.slice(0, len) + '...';
}

// ── Connection Status Indicator ──────────────────────────────────────────────

function ConnectionIndicator({ status }: { status: string }) {
  const color =
    status === 'connected'
      ? 'bg-green-500'
      : status === 'connecting'
        ? 'bg-yellow-500 animate-pulse'
        : 'bg-red-500';
  const label =
    status === 'connected'
      ? 'Live'
      : status === 'connecting'
        ? 'Connecting...'
        : 'Disconnected';

  return (
    <div className="flex items-center gap-2">
      <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} />
      <span className="text-xs text-gray-400">{label}</span>
    </div>
  );
}

// ── Live Duration Component ──────────────────────────────────────────────────

function LiveDuration({ startTime }: { startTime: string }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  return <span>{formatDuration(startTime, null)}</span>;
}

// ── Session Card ─────────────────────────────────────────────────────────────

function SessionCard({ session, onClick }: { session: Session; onClick?: () => void }) {
  const isRunning = session.status === 'running';

  return (
    <Card
      className="bg-gray-800/60 ring-gray-700/50 p-3 hover:ring-gray-600 transition-all cursor-pointer hover:bg-gray-800/80"
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <Text className="text-gray-200 font-mono text-xs">
          {truncateId(session.sessionId)}
        </Text>
        <span
          className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_BG[session.status]}`}
        >
          {session.status}
        </span>
      </div>

      <div className="space-y-1.5">
        {/* Model */}
        {session.model && (
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">Model</span>
            <span className="text-gray-300 truncate ml-2 max-w-[140px]">
              {session.model}
            </span>
          </div>
        )}

        {/* Cost */}
        <div className="flex justify-between text-xs">
          <span className="text-gray-500">Cost</span>
          <span className="text-gray-300">{formatCost(session.totalCost)}</span>
        </div>

        {/* Duration */}
        <div className="flex justify-between text-xs">
          <span className="text-gray-500">Duration</span>
          <span className="text-gray-300">
            {isRunning ? (
              <LiveDuration startTime={session.startTime} />
            ) : (
              formatDuration(session.startTime, session.endTime)
            )}
          </span>
        </div>

        {/* Turn count */}
        <div className="flex justify-between text-xs">
          <span className="text-gray-500">Turns</span>
          <span className="text-gray-300">{session.turnCount}</span>
        </div>

        {/* Phase (running only) */}
        {isRunning && session.inferredPhase && (
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">Phase</span>
            <span className="text-emerald-400 truncate ml-2 max-w-[140px]">
              {session.inferredPhase}
            </span>
          </div>
        )}

        {/* Error count */}
        {session.errorCount > 0 && (
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">Errors</span>
            <span className="text-red-400 font-medium">{session.errorCount}</span>
          </div>
        )}
      </div>
    </Card>
  );
}

// ── KPI Card Component ───────────────────────────────────────────────────────

function KpiCard({
  title,
  value,
  children,
}: {
  title: string;
  value: string | number;
  children?: React.ReactNode;
}) {
  return (
    <Card className="bg-gray-800 ring-gray-700 p-4">
      <Text className="text-gray-400 text-sm">{title}</Text>
      <Metric className="text-gray-100 mt-1">{value}</Metric>
      {children && <div className="mt-2">{children}</div>}
    </Card>
  );
}

// ── Main Dashboard Page ──────────────────────────────────────────────────────

export default function DashboardPage() {
  const navigate = useNavigate();

  // ── State ────────────────────────────────────────────────────────────────
  const [sessions, setSessions] = useState<Session[]>([]);
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [costRange, setCostRange] = useState<CostRange>('today');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toolCallTimestamps, setToolCallTimestamps] = useState<number[]>([]);
  const [rateLimitCount, setRateLimitCount] = useState(0);

  const { status: wsStatus, lastEvent } = useWebSocket();
  const lastEventProcessed = useRef<unknown>(null);

  // ── Data fetching ────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    try {
      const [sessionsRes, overviewRes] = await Promise.all([
        api.getSessions({ limit: 200, sortBy: 'lastSeen', order: 'desc' }),
        api.getAnalyticsOverview({ range: COST_RANGE_API[costRange] }),
      ]);
      setSessions(sessionsRes.data);
      setOverview(overviewRes);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  }, [costRange]);

  // Initial fetch and polling
  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Refresh on WebSocket events
  useEffect(() => {
    if (lastEvent && lastEvent !== lastEventProcessed.current) {
      lastEventProcessed.current = lastEvent;

      // Track tool call timestamps for tool calls per minute sparkline
      const evt = lastEvent as Record<string, unknown>;
      if (evt.type === 'PostToolUse' || evt.type === 'PreToolUse') {
        setToolCallTimestamps((prev) => {
          const now = Date.now();
          const oneMinuteAgo = now - 60_000;
          return [...prev.filter((t) => t > oneMinuteAgo), now];
        });
      }

      // Track rate limit events
      if (evt.type === 'error') {
        const payload = evt.payload as Record<string, unknown> | undefined;
        if (payload?.category === 'rate_limit') {
          setRateLimitCount((prev) => prev + 1);
        }
      }

      // Refresh sessions on meaningful events
      if (
        evt.type === 'SessionStart' ||
        evt.type === 'SessionEnd' ||
        evt.type === 'Stop' ||
        evt.type === 'PostToolUse' ||
        evt.type === 'PostToolUseFailure'
      ) {
        fetchData();
      }
    }
  }, [lastEvent, fetchData]);

  // Reset rate limit count every hour
  useEffect(() => {
    const interval = setInterval(() => setRateLimitCount(0), 3600_000);
    return () => clearInterval(interval);
  }, []);

  // ── Derived data ─────────────────────────────────────────────────────────

  const projects = useMemo(() => {
    const set = new Set(sessions.map((s) => s.project));
    return Array.from(set).sort();
  }, [sessions]);

  const filteredSessions = useMemo(() => {
    if (projectFilter === 'all') return sessions;
    return sessions.filter((s) => s.project === projectFilter);
  }, [sessions, projectFilter]);

  // Group sessions by status and then by project
  const kanbanData = useMemo(() => {
    const groups: Record<SessionStatus, Map<string, Session[]>> = {
      running: new Map(),
      completed: new Map(),
      errored: new Map(),
      stale: new Map(),
    };

    for (const session of filteredSessions) {
      const statusGroup = groups[session.status];
      if (!statusGroup) continue;
      const existing = statusGroup.get(session.project) || [];
      existing.push(session);
      statusGroup.set(session.project, existing);
    }

    // Merge stale into running column
    for (const [project, staleSessions] of groups.stale) {
      const existing = groups.running.get(project) || [];
      groups.running.set(project, [...existing, ...staleSessions]);
    }

    return groups;
  }, [filteredSessions]);

  // Tool calls per minute sparkline data (last 10 minutes, one data point per minute)
  const toolCallSparkline = useMemo(() => {
    const now = Date.now();
    const data: { minute: string; calls: number }[] = [];
    for (let i = 9; i >= 0; i--) {
      const minuteStart = now - (i + 1) * 60_000;
      const minuteEnd = now - i * 60_000;
      const count = toolCallTimestamps.filter(
        (t) => t >= minuteStart && t < minuteEnd,
      ).length;
      data.push({ minute: `${10 - i}`, calls: count });
    }
    return data;
  }, [toolCallTimestamps]);

  const currentToolCallsPerMin = useMemo(() => {
    const oneMinuteAgo = Date.now() - 60_000;
    return toolCallTimestamps.filter((t) => t > oneMinuteAgo).length;
  }, [toolCallTimestamps]);

  const totalErrors = overview?.totalErrors ?? 0;
  const totalSessions = overview?.totalSessions ?? 0;

  // ── Render ───────────────────────────────────────────────────────────────

  if (loading && !overview) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading dashboard...</div>
      </div>
    );
  }

  if (error && !overview) {
    return (
      <div className="flex items-center justify-center h-64">
        <Card className="bg-red-900/30 ring-red-700 max-w-md">
          <Title className="text-red-400">Error loading dashboard</Title>
          <Text className="text-red-300 mt-2">{error}</Text>
          <button
            onClick={fetchData}
            className="mt-4 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-md text-sm transition-colors"
          >
            Retry
          </button>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Header Row ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-100">Dashboard</h1>
        <ConnectionIndicator status={wsStatus} />
      </div>

      {/* ── Top Stats Bar (5 KPI cards) ────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {/* 1. Active Sessions */}
        <KpiCard title="Active Sessions" value={overview?.activeSessions ?? 0}>
          <Text className="text-xs text-gray-500">
            {totalSessions} total
          </Text>
        </KpiCard>

        {/* 2. Total Cost with range selector */}
        <Card className="bg-gray-800 ring-gray-700 p-4">
          <div className="flex items-center justify-between mb-1">
            <Text className="text-gray-400 text-sm">Total Cost</Text>
            <select
              value={costRange}
              onChange={(e) => setCostRange(e.target.value as CostRange)}
              className="bg-gray-700 text-gray-300 text-xs rounded px-1.5 py-0.5 border-none outline-none cursor-pointer"
            >
              {Object.entries(COST_RANGE_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <Metric className="text-gray-100 mt-1">
            {formatCost(overview?.totalCost ?? 0)}
          </Metric>
          <Text className="text-xs text-gray-500 mt-2">
            {((overview?.totalTokens ?? 0) / 1000).toFixed(1)}k tokens
          </Text>
        </Card>

        {/* 3. Error Count / Rate */}
        <KpiCard title="Errors" value={totalErrors}>
          <BadgeDelta
            deltaType={totalErrors === 0 ? 'unchanged' : 'moderateDecrease'}
            size="xs"
          >
            {((overview?.errorRate ?? 0) * 100).toFixed(1)}% error rate
          </BadgeDelta>
        </KpiCard>

        {/* 4. Tool Calls / min with sparkline */}
        <Card className="bg-gray-800 ring-gray-700 p-4">
          <Text className="text-gray-400 text-sm">Tool Calls / min</Text>
          <Metric className="text-gray-100 mt-1">{currentToolCallsPerMin}</Metric>
          <div className="mt-2">
            <SparkAreaChart
              data={toolCallSparkline}
              categories={['calls']}
              index="minute"
              colors={['cyan']}
              className="h-8 w-full"
            />
          </div>
        </Card>

        {/* 5. Rate Limit Incidents */}
        <KpiCard title="Rate Limits (1h)" value={rateLimitCount}>
          <Badge
            color={rateLimitCount > 0 ? 'red' : 'green'}
            size="xs"
          >
            {rateLimitCount === 0 ? 'Clear' : `${rateLimitCount} incident${rateLimitCount !== 1 ? 's' : ''}`}
          </Badge>
        </KpiCard>
      </div>

      {/* ── Project Filter ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <Text className="text-gray-400 text-sm font-medium">Project:</Text>
        <Select
          value={projectFilter}
          onValueChange={setProjectFilter}
          className="max-w-xs"
        >
          <SelectItem value="all">All Projects</SelectItem>
          {projects.map((project) => (
            <SelectItem key={project} value={project}>
              {project}
            </SelectItem>
          ))}
        </Select>
        {error && (
          <Text className="text-yellow-400 text-xs ml-auto">
            Some data may be stale -- {error}
          </Text>
        )}
      </div>

      {/* ── Three-Column Kanban Board ──────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {KANBAN_COLUMNS.map((col) => {
          const projectGroups = kanbanData[col.key];
          const sessionCount = Array.from(projectGroups.values()).reduce(
            (sum, arr) => sum + arr.length,
            0,
          );

          return (
            <div
              key={col.key}
              className={`rounded-lg border-t-2 ${col.headerColor} bg-gray-900/50 border border-gray-800`}
            >
              {/* Column header */}
              <div className="flex items-center justify-between p-3 border-b border-gray-800">
                <div className="flex items-center gap-2">
                  <Title className="text-gray-200 text-sm">{col.label}</Title>
                  <Badge
                    color={STATUS_COLORS[col.key] as 'green' | 'blue' | 'red'}
                    size="xs"
                  >
                    {sessionCount}
                  </Badge>
                </div>
              </div>

              {/* Column body */}
              <div className="p-3 space-y-4 max-h-[600px] overflow-y-auto">
                {projectGroups.size === 0 ? (
                  <Text className="text-gray-500 text-center text-sm py-6">
                    No {col.label.toLowerCase()} sessions
                  </Text>
                ) : (
                  Array.from(projectGroups.entries())
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([project, projectSessions]) => (
                      <div key={project}>
                        {/* Project group header */}
                        <Subtitle className="text-gray-400 text-xs uppercase tracking-wider mb-2 px-1">
                          {project}
                        </Subtitle>
                        <div className="space-y-2">
                          {projectSessions
                            .sort(
                              (a, b) =>
                                new Date(b.lastSeen).getTime() -
                                new Date(a.lastSeen).getTime(),
                            )
                            .map((session) => (
                              <SessionCard
                                key={session.sessionId}
                                session={session}
                                onClick={() => navigate(`/sessions/${session.sessionId}`)}
                              />
                            ))}
                        </div>
                      </div>
                    ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
