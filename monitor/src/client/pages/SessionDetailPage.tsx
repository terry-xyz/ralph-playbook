import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Card,
  Metric,
  Text,
  Badge,
  Table,
  TableHead,
  TableHeaderCell,
  TableBody,
  TableRow,
  TableCell,
  DonutChart,
  BarList,
  Button,
} from '@tremor/react';
import { api } from '@client/api';
import type { Session, EventRecord, HookEventType, SessionStatus } from '@shared/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 0) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function computeDurationSeconds(startTime: string, endTime: string | null): number {
  if (!endTime) return (Date.now() - new Date(startTime).getTime()) / 1000;
  return (new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000;
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const STATUS_COLORS: Record<SessionStatus, string> = {
  running: 'green',
  completed: 'blue',
  errored: 'red',
  stale: 'yellow',
};

const EVENT_TYPE_COLORS: Record<string, string> = {
  PreToolUse: 'blue',
  PostToolUse: 'green',
  PostToolUseFailure: 'red',
  UserPromptSubmit: 'purple',
  Stop: 'gray',
  SubagentStart: 'cyan',
  SubagentStop: 'cyan',
  PreCompact: 'orange',
  Notification: 'yellow',
  PermissionRequest: 'amber',
  SessionStart: 'emerald',
  SessionEnd: 'slate',
};

// ── Tool Stats Computation ───────────────────────────────────────────────────

interface ToolStats {
  tool: string;
  calls: number;
  successes: number;
  failures: number;
  avgDuration: number;
}

function computeToolStats(events: EventRecord[]): ToolStats[] {
  const statsMap = new Map<
    string,
    { calls: number; successes: number; failures: number; totalDuration: number; durCount: number }
  >();

  for (const event of events) {
    if (!event.tool) continue;
    const toolName = event.tool;

    if (!statsMap.has(toolName)) {
      statsMap.set(toolName, { calls: 0, successes: 0, failures: 0, totalDuration: 0, durCount: 0 });
    }

    const stat = statsMap.get(toolName)!;

    if (event.type === 'PostToolUse') {
      stat.calls++;
      stat.successes++;
      if (event.duration !== undefined && event.duration > 0) {
        stat.totalDuration += event.duration;
        stat.durCount++;
      }
    } else if (event.type === 'PostToolUseFailure') {
      stat.calls++;
      stat.failures++;
      if (event.duration !== undefined && event.duration > 0) {
        stat.totalDuration += event.duration;
        stat.durCount++;
      }
    } else if (event.type === 'PreToolUse') {
      // Count PreToolUse only if we haven't already counted via Post events
      if (!statsMap.has(toolName) || (stat.successes === 0 && stat.failures === 0)) {
        // Will be counted in Post events; only add to calls if no Post event exists
      }
    }
  }

  // For tools that only have PreToolUse events (no corresponding Post), count those
  for (const event of events) {
    if (event.type === 'PreToolUse' && event.tool) {
      const stat = statsMap.get(event.tool);
      if (stat && stat.calls === 0) {
        stat.calls = 1;
      }
    }
  }

  return Array.from(statsMap.entries())
    .map(([tool, stat]) => ({
      tool,
      calls: stat.calls,
      successes: stat.successes,
      failures: stat.failures,
      avgDuration: stat.durCount > 0 ? stat.totalDuration / stat.durCount : 0,
    }))
    .sort((a, b) => b.calls - a.calls);
}

// ── Metric Card Component ────────────────────────────────────────────────────

function MetricCard({
  title,
  value,
  subtitle,
}: {
  title: string;
  value: string;
  subtitle?: string;
}) {
  return (
    <Card className="bg-gray-800 ring-gray-700">
      <Text className="text-gray-400">{title}</Text>
      <Metric className="text-gray-100 mt-1">{value}</Metric>
      {subtitle && <Text className="text-gray-500 text-xs mt-1">{subtitle}</Text>}
    </Card>
  );
}

// ── Event Timeline Item ──────────────────────────────────────────────────────

function EventTimelineItem({ event }: { event: EventRecord }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-l-2 border-gray-700 pl-4 pb-4 relative">
      {/* Timeline dot */}
      <div className="absolute left-[-5px] top-1.5 w-2 h-2 rounded-full bg-gray-500" />

      <div
        className="cursor-pointer hover:bg-gray-700/20 rounded px-2 py-1.5 -ml-2 transition-colors"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <div className="flex items-center flex-wrap gap-2">
          <Badge color={(EVENT_TYPE_COLORS[event.type] ?? 'gray') as any} size="xs">
            {event.type}
          </Badge>
          {event.tool && (
            <span className="text-blue-400 text-xs font-mono bg-blue-900/30 px-1.5 py-0.5 rounded">
              {event.tool}
            </span>
          )}
          <span className="text-gray-500 text-xs">{formatTimestamp(event.timestamp)}</span>
          {event.duration !== undefined && event.duration > 0 && (
            <span className="text-gray-500 text-xs">({event.duration.toFixed(0)}ms)</span>
          )}
          <span className="text-gray-600 text-xs ml-auto">
            {expanded ? '\u25B2' : '\u25BC'}
          </span>
        </div>
      </div>

      {/* Expanded payload */}
      {expanded && (
        <div className="mt-2 ml-2">
          <pre className="bg-gray-900 border border-gray-700 rounded p-3 text-xs text-gray-300 overflow-x-auto max-h-64 overflow-y-auto">
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Main Page Component ──────────────────────────────────────────────────────

export default function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // Data state
  const [session, setSession] = useState<Session | null>(null);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);

  // Events pagination
  const [eventsPage, setEventsPage] = useState(1);
  const [eventsTotal, setEventsTotal] = useState(0);
  const eventsLimit = 100;

  // Fetch session data
  const fetchSession = useCallback(async () => {
    if (!id) return;
    setSessionLoading(true);
    setSessionError(null);
    try {
      const data = await api.getSession(id);
      setSession(data);
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : 'Failed to load session');
    } finally {
      setSessionLoading(false);
    }
  }, [id]);

  // Fetch events
  const fetchEvents = useCallback(async () => {
    if (!id) return;
    setEventsLoading(true);
    setEventsError(null);
    try {
      const result = await api.getSessionEvents(id, { page: eventsPage, limit: eventsLimit });
      setEvents(result.data);
      setEventsTotal(result.total);
    } catch (err) {
      setEventsError(err instanceof Error ? err.message : 'Failed to load events');
    } finally {
      setEventsLoading(false);
    }
  }, [id, eventsPage]);

  useEffect(() => {
    fetchSession();
    fetchEvents();
  }, [fetchSession, fetchEvents]);

  // Computed tool stats
  const toolStats = useMemo(() => computeToolStats(events), [events]);

  // Computed cost breakdown for donut chart
  const costBreakdownData = useMemo(() => {
    if (!session) return [];

    const { tokenCounts } = session;
    // Approximate cost breakdown based on token ratios
    // Use rough multipliers if exact cost breakdown is not available
    const totalTokens =
      tokenCounts.input + tokenCounts.output + tokenCounts.cacheCreation + tokenCounts.cacheRead;

    if (totalTokens === 0) return [];

    const inputRatio = tokenCounts.input / totalTokens;
    const outputRatio = tokenCounts.output / totalTokens;
    const cacheCreationRatio = tokenCounts.cacheCreation / totalTokens;
    const cacheReadRatio = tokenCounts.cacheRead / totalTokens;

    const items = [];
    if (inputRatio > 0) {
      items.push({
        name: 'Input',
        value: Number((session.totalCost * inputRatio).toFixed(4)),
      });
    }
    if (outputRatio > 0) {
      items.push({
        name: 'Output',
        value: Number((session.totalCost * outputRatio).toFixed(4)),
      });
    }
    if (cacheCreationRatio > 0) {
      items.push({
        name: 'Cache Creation',
        value: Number((session.totalCost * cacheCreationRatio).toFixed(4)),
      });
    }
    if (cacheReadRatio > 0) {
      items.push({
        name: 'Cache Read',
        value: Number((session.totalCost * cacheReadRatio).toFixed(4)),
      });
    }

    return items;
  }, [session]);

  // Bar list data for tool call breakdown
  const toolBarListData = useMemo(() => {
    return toolStats.map((ts) => ({
      name: ts.tool,
      value: ts.calls,
    }));
  }, [toolStats]);

  // Loading state
  if (sessionLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="flex items-center gap-3 text-gray-400">
          <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
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
          Loading session...
        </div>
      </div>
    );
  }

  // Error state
  if (sessionError || !session) {
    return (
      <div className="space-y-4">
        <Button variant="light" onClick={() => navigate('/sessions')} className="text-gray-400">
          &larr; Back to Sessions
        </Button>
        <Card className="bg-red-900/30 ring-red-700">
          <p className="text-red-300">
            {sessionError || 'Session not found.'}
          </p>
        </Card>
      </div>
    );
  }

  const durationSeconds = computeDurationSeconds(session.startTime, session.endTime);
  const eventsTotalPages = Math.max(1, Math.ceil(eventsTotal / eventsLimit));

  return (
    <div className="space-y-6">
      {/* Navigation + Title */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="light" onClick={() => navigate('/sessions')} className="text-gray-400">
            &larr; Back
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-gray-100 flex items-center gap-3">
              Session
              <code className="text-blue-400 text-lg font-mono">{session.sessionId}</code>
              <Badge color={STATUS_COLORS[session.status] as any} size="sm">
                {session.status}
              </Badge>
            </h1>
            <p className="text-sm text-gray-500 mt-0.5">
              {session.project} &middot; Started {formatTimestamp(session.startTime)}
              {session.inferredPhase && (
                <span> &middot; Phase: <span className="text-gray-300">{session.inferredPhase}</span></span>
              )}
            </p>
          </div>
        </div>
        <Button size="xs" variant="secondary" onClick={() => { fetchSession(); fetchEvents(); }} className="text-gray-300">
          Refresh
        </Button>
      </div>

      {/* ── Summary Metric Cards ────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <MetricCard
          title="Total Cost"
          value={formatCost(session.totalCost)}
        />
        <MetricCard
          title="Duration"
          value={formatDuration(durationSeconds)}
          subtitle={session.status === 'running' ? 'Still running' : undefined}
        />
        <MetricCard
          title="Turn Count"
          value={String(session.turnCount)}
        />
        <MetricCard
          title="Model"
          value={session.model || 'Unknown'}
        />
        <MetricCard
          title="Error Count"
          value={String(session.errorCount)}
        />
        <MetricCard
          title="Tokens"
          value={formatTokens(
            session.tokenCounts.input +
              session.tokenCounts.output +
              session.tokenCounts.cacheCreation +
              session.tokenCounts.cacheRead,
          )}
          subtitle={`In: ${formatTokens(session.tokenCounts.input)} / Out: ${formatTokens(session.tokenCounts.output)}`}
        />
      </div>

      {/* ── Main Content: Timeline + Side Panel ─────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Event Timeline (2/3 width) */}
        <div className="xl:col-span-2 space-y-4">
          <Card className="bg-gray-800 ring-gray-700">
            <div className="flex items-center justify-between mb-4">
              <Text className="text-gray-200 font-semibold text-base">
                Event Timeline
              </Text>
              <Text className="text-gray-500 text-xs">
                {eventsTotal} total event{eventsTotal !== 1 ? 's' : ''}
              </Text>
            </div>

            {eventsLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="flex items-center gap-3 text-gray-400">
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
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
                  Loading events...
                </div>
              </div>
            ) : eventsError ? (
              <div className="text-red-400 text-sm py-4">{eventsError}</div>
            ) : events.length === 0 ? (
              <div className="text-gray-500 text-sm py-8 text-center">
                No events recorded for this session.
              </div>
            ) : (
              <>
                <div className="space-y-0 max-h-[600px] overflow-y-auto pr-2">
                  {events.map((event) => (
                    <EventTimelineItem key={event.id} event={event} />
                  ))}
                </div>

                {/* Events Pagination */}
                {eventsTotal > eventsLimit && (
                  <div className="flex items-center justify-between mt-4 pt-3 border-t border-gray-700">
                    <Text className="text-gray-500 text-xs">
                      Page {eventsPage} of {eventsTotalPages}
                    </Text>
                    <div className="flex items-center gap-1">
                      <button
                        disabled={eventsPage <= 1}
                        onClick={() => setEventsPage((p) => p - 1)}
                        className="px-2 py-1 text-xs rounded border border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        Prev
                      </button>
                      <button
                        disabled={eventsPage >= eventsTotalPages}
                        onClick={() => setEventsPage((p) => p + 1)}
                        className="px-2 py-1 text-xs rounded border border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </Card>
        </div>

        {/* Side Panel: Tool Breakdown + Cost Breakdown (1/3 width) */}
        <div className="space-y-4">
          {/* Tool Call Breakdown */}
          <Card className="bg-gray-800 ring-gray-700">
            <Text className="text-gray-200 font-semibold text-base mb-4">
              Tool Call Breakdown
            </Text>

            {toolStats.length === 0 ? (
              <Text className="text-gray-500 text-sm">No tool calls recorded.</Text>
            ) : (
              <>
                {/* Bar visualization */}
                <BarList
                  data={toolBarListData}
                  className="mt-2"
                  color="blue"
                />

                {/* Detailed table */}
                <div className="mt-4 overflow-x-auto">
                  <Table>
                    <TableHead>
                      <TableRow className="border-b border-gray-700">
                        <TableHeaderCell className="text-gray-400 text-xs">Tool</TableHeaderCell>
                        <TableHeaderCell className="text-gray-400 text-xs text-center">Calls</TableHeaderCell>
                        <TableHeaderCell className="text-gray-400 text-xs text-center">OK</TableHeaderCell>
                        <TableHeaderCell className="text-gray-400 text-xs text-center">Fail</TableHeaderCell>
                        <TableHeaderCell className="text-gray-400 text-xs text-right">Avg ms</TableHeaderCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {toolStats.map((ts) => (
                        <TableRow key={ts.tool} className="border-b border-gray-700/50">
                          <TableCell className="text-blue-400 text-xs font-mono">{ts.tool}</TableCell>
                          <TableCell className="text-gray-300 text-xs text-center">{ts.calls}</TableCell>
                          <TableCell className="text-green-400 text-xs text-center">{ts.successes}</TableCell>
                          <TableCell className={`text-xs text-center ${ts.failures > 0 ? 'text-red-400' : 'text-gray-500'}`}>
                            {ts.failures}
                          </TableCell>
                          <TableCell className="text-gray-400 text-xs text-right font-mono">
                            {ts.avgDuration > 0 ? ts.avgDuration.toFixed(0) : '--'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </Card>

          {/* Cost Breakdown */}
          <Card className="bg-gray-800 ring-gray-700">
            <Text className="text-gray-200 font-semibold text-base mb-4">
              Cost Breakdown
            </Text>

            {costBreakdownData.length === 0 ? (
              <Text className="text-gray-500 text-sm">No cost data available.</Text>
            ) : (
              <>
                <DonutChart
                  data={costBreakdownData}
                  category="value"
                  index="name"
                  colors={['blue', 'cyan', 'violet', 'slate']}
                  className="h-40"
                  valueFormatter={(v) => `$${v.toFixed(4)}`}
                  showAnimation
                />

                {/* Cost breakdown list */}
                <div className="mt-4 space-y-2">
                  {costBreakdownData.map((item) => (
                    <div key={item.name} className="flex items-center justify-between text-sm">
                      <span className="text-gray-400">{item.name}</span>
                      <span className="text-gray-200 font-mono">${item.value.toFixed(4)}</span>
                    </div>
                  ))}
                  <div className="flex items-center justify-between text-sm pt-2 border-t border-gray-700">
                    <span className="text-gray-300 font-medium">Total</span>
                    <span className="text-gray-100 font-mono font-medium">
                      {formatCost(session.totalCost)}
                    </span>
                  </div>
                </div>
              </>
            )}
          </Card>

          {/* Token Breakdown */}
          <Card className="bg-gray-800 ring-gray-700">
            <Text className="text-gray-200 font-semibold text-base mb-4">
              Token Breakdown
            </Text>
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-400">Input</span>
                <span className="text-gray-200 font-mono">{formatTokens(session.tokenCounts.input)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-400">Output</span>
                <span className="text-gray-200 font-mono">{formatTokens(session.tokenCounts.output)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-400">Cache Creation</span>
                <span className="text-gray-200 font-mono">{formatTokens(session.tokenCounts.cacheCreation)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-400">Cache Read</span>
                <span className="text-gray-200 font-mono">{formatTokens(session.tokenCounts.cacheRead)}</span>
              </div>
              <div className="flex items-center justify-between text-sm pt-2 border-t border-gray-700">
                <span className="text-gray-300 font-medium">Total</span>
                <span className="text-gray-100 font-mono font-medium">
                  {formatTokens(
                    session.tokenCounts.input +
                      session.tokenCounts.output +
                      session.tokenCounts.cacheCreation +
                      session.tokenCounts.cacheRead,
                  )}
                </span>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
