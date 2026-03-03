import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card,
  Badge,
  Table,
  TableHead,
  TableHeaderCell,
  TableBody,
  TableRow,
  TableCell,
  DonutChart,
  BarList,
  Text,
} from '@tremor/react';
import { api } from '@client/api';
import type { Session, EventRecord, SessionStatus } from '@shared/types';

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

// ── Tool Stats ───────────────────────────────────────────────────────────────

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

// ── Event Timeline Item ──────────────────────────────────────────────────────

function EventTimelineItem({ event }: { event: EventRecord }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-l-2 border-gray-700 pl-4 pb-4 relative">
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

// ── Live Duration ────────────────────────────────────────────────────────────

function LiveDuration({ startTime }: { startTime: string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);
  return <span>{formatDuration(computeDurationSeconds(startTime, null))}</span>;
}

// ── Storage key for panel width ──────────────────────────────────────────────

const PANEL_WIDTH_KEY = 'ralph-session-panel-width';
const DEFAULT_PANEL_WIDTH_PERCENT = 50;
const MIN_PANEL_WIDTH_PERCENT = 25;
const MAX_PANEL_WIDTH_PERCENT = 80;

function getStoredWidth(): number {
  try {
    const stored = sessionStorage.getItem(PANEL_WIDTH_KEY);
    if (stored) {
      const val = Number(stored);
      if (val >= MIN_PANEL_WIDTH_PERCENT && val <= MAX_PANEL_WIDTH_PERCENT) return val;
    }
  } catch {
    // sessionStorage may be unavailable
  }
  return DEFAULT_PANEL_WIDTH_PERCENT;
}

function storeWidth(width: number) {
  try {
    sessionStorage.setItem(PANEL_WIDTH_KEY, String(width));
  } catch {
    // ignore
  }
}

// ── SessionDetailPanel ───────────────────────────────────────────────────────

interface SessionDetailPanelProps {
  sessionId: string;
  onClose: () => void;
}

export default function SessionDetailPanel({ sessionId, onClose }: SessionDetailPanelProps) {
  const navigate = useNavigate();

  // Panel width state (percentage of viewport)
  const [widthPercent, setWidthPercent] = useState(getStoredWidth);
  const [isDragging, setIsDragging] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

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
  const eventsLimit = 50;

  // Slide-in animation
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Trigger slide-in animation on next frame
    requestAnimationFrame(() => setVisible(true));
  }, []);

  // ── Data fetching ──────────────────────────────────────────────────────────

  const fetchSession = useCallback(async () => {
    setSessionLoading(true);
    setSessionError(null);
    try {
      const data = await api.getSession(sessionId);
      setSession(data);
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : 'Failed to load session');
    } finally {
      setSessionLoading(false);
    }
  }, [sessionId]);

  const fetchEvents = useCallback(async () => {
    setEventsLoading(true);
    setEventsError(null);
    try {
      const result = await api.getSessionEvents(sessionId, { page: eventsPage, limit: eventsLimit });
      setEvents(result.data);
      setEventsTotal(result.total);
    } catch (err) {
      setEventsError(err instanceof Error ? err.message : 'Failed to load events');
    } finally {
      setEventsLoading(false);
    }
  }, [sessionId, eventsPage]);

  useEffect(() => {
    fetchSession();
    fetchEvents();
  }, [fetchSession, fetchEvents]);

  // Auto-refresh for running sessions
  useEffect(() => {
    if (session?.status !== 'running') return;
    const interval = setInterval(() => {
      fetchSession();
      fetchEvents();
    }, 5000);
    return () => clearInterval(interval);
  }, [session?.status, fetchSession, fetchEvents]);

  // ── Keyboard handler (Escape) ──────────────────────────────────────────────

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // ── Click outside handler ──────────────────────────────────────────────────

  function handleBackdropClick(e: React.MouseEvent) {
    if (e.target === backdropRef.current) {
      onClose();
    }
  }

  // ── Drag resize handler ────────────────────────────────────────────────────

  function handleDragStart(e: React.MouseEvent) {
    e.preventDefault();
    setIsDragging(true);
  }

  useEffect(() => {
    if (!isDragging) return;

    function handleMouseMove(e: MouseEvent) {
      const vw = window.innerWidth;
      const newWidth = ((vw - e.clientX) / vw) * 100;
      const clamped = Math.min(MAX_PANEL_WIDTH_PERCENT, Math.max(MIN_PANEL_WIDTH_PERCENT, newWidth));
      setWidthPercent(clamped);
    }

    function handleMouseUp() {
      setIsDragging(false);
      setWidthPercent((w) => {
        storeWidth(w);
        return w;
      });
    }

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  // ── Computed data ──────────────────────────────────────────────────────────

  const toolStats = useMemo(() => computeToolStats(events), [events]);

  const costBreakdownData = useMemo(() => {
    if (!session) return [];
    const { tokenCounts } = session;
    const totalTokens =
      tokenCounts.input + tokenCounts.output + tokenCounts.cacheCreation + tokenCounts.cacheRead;
    if (totalTokens === 0) return [];

    const items: { name: string; value: number }[] = [];
    const ratios = [
      { name: 'Input', ratio: tokenCounts.input / totalTokens },
      { name: 'Output', ratio: tokenCounts.output / totalTokens },
      { name: 'Cache Creation', ratio: tokenCounts.cacheCreation / totalTokens },
      { name: 'Cache Read', ratio: tokenCounts.cacheRead / totalTokens },
    ];
    for (const { name, ratio } of ratios) {
      if (ratio > 0) items.push({ name, value: Number((session.totalCost * ratio).toFixed(4)) });
    }
    return items;
  }, [session]);

  const toolBarListData = useMemo(
    () => toolStats.map((ts) => ({ name: ts.tool, value: ts.calls })),
    [toolStats],
  );

  const eventsTotalPages = Math.max(1, Math.ceil(eventsTotal / eventsLimit));

  // ── View Full handler ──────────────────────────────────────────────────────

  function handleViewFull() {
    onClose();
    navigate(`/sessions/${encodeURIComponent(sessionId)}`);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      ref={backdropRef}
      className={`fixed inset-0 z-50 transition-colors duration-200 ${visible ? 'bg-black/40' : 'bg-transparent'}`}
      onClick={handleBackdropClick}
      data-testid="session-panel-backdrop"
    >
      {/* Drag cursor overlay when resizing */}
      {isDragging && <div className="fixed inset-0 cursor-col-resize z-[60]" />}

      {/* Panel */}
      <div
        ref={panelRef}
        className={`fixed top-0 right-0 h-full bg-gray-900 border-l border-gray-700 shadow-2xl overflow-hidden flex flex-col transition-transform duration-300 ease-out ${visible ? 'translate-x-0' : 'translate-x-full'}`}
        style={{ width: `${widthPercent}%` }}
        data-testid="session-detail-panel"
      >
        {/* Drag handle (left edge) */}
        <div
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-blue-500/30 active:bg-blue-500/50 transition-colors z-10"
          onMouseDown={handleDragStart}
          data-testid="panel-drag-handle"
        />

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <h2 className="text-lg font-bold text-gray-100 truncate">Session Detail</h2>
            {session && (
              <Badge color={STATUS_COLORS[session.status] as any} size="sm">
                {session.status}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleViewFull}
              className="px-3 py-1.5 text-xs font-medium rounded-md border border-gray-600 text-gray-300 hover:bg-gray-800 hover:text-gray-100 transition-colors"
              data-testid="panel-view-full"
            >
              View Full
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md text-gray-400 hover:bg-gray-800 hover:text-gray-100 transition-colors"
              data-testid="panel-close-button"
              aria-label="Close panel"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {sessionLoading ? (
            <div className="flex items-center justify-center py-16">
              <div className="flex items-center gap-3 text-gray-400">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                Loading session...
              </div>
            </div>
          ) : sessionError || !session ? (
            <Card className="bg-red-900/30 ring-red-700">
              <p className="text-red-300">{sessionError || 'Session not found.'}</p>
            </Card>
          ) : (
            <>
              {/* Session identifier */}
              <div>
                <code className="text-blue-400 text-sm font-mono">{session.sessionId}</code>
                <p className="text-xs text-gray-500 mt-0.5">
                  {session.project} &middot; Started {formatTimestamp(session.startTime)}
                  {session.inferredPhase && (
                    <span> &middot; Phase: <span className="text-gray-300">{session.inferredPhase}</span></span>
                  )}
                </p>
              </div>

              {/* Summary Stats */}
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                <StatCard label="Total Cost" value={formatCost(session.totalCost)} />
                <StatCard
                  label="Duration"
                  value={
                    session.status === 'running' ? (
                      <LiveDuration startTime={session.startTime} />
                    ) : (
                      formatDuration(computeDurationSeconds(session.startTime, session.endTime))
                    )
                  }
                />
                <StatCard label="Turn Count" value={String(session.turnCount)} />
                <StatCard label="Model" value={session.model || 'Unknown'} />
                <StatCard label="Errors" value={String(session.errorCount)} />
                <StatCard
                  label="Tokens"
                  value={formatTokens(
                    session.tokenCounts.input +
                      session.tokenCounts.output +
                      session.tokenCounts.cacheCreation +
                      session.tokenCounts.cacheRead,
                  )}
                  subtitle={`In: ${formatTokens(session.tokenCounts.input)} / Out: ${formatTokens(session.tokenCounts.output)}`}
                />
              </div>

              {/* Event Timeline */}
              <section>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-gray-200">Event Timeline</h3>
                  <span className="text-xs text-gray-500">
                    {eventsTotal} event{eventsTotal !== 1 ? 's' : ''}
                  </span>
                </div>
                {eventsLoading ? (
                  <div className="flex items-center justify-center py-6">
                    <div className="flex items-center gap-2 text-gray-400 text-sm">
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                      </svg>
                      Loading events...
                    </div>
                  </div>
                ) : eventsError ? (
                  <p className="text-red-400 text-sm">{eventsError}</p>
                ) : events.length === 0 ? (
                  <p className="text-gray-500 text-sm py-4 text-center">No events recorded.</p>
                ) : (
                  <>
                    <div className="space-y-0 max-h-[400px] overflow-y-auto pr-1">
                      {events.map((event) => (
                        <EventTimelineItem key={event.id} event={event} />
                      ))}
                    </div>
                    {eventsTotal > eventsLimit && (
                      <div className="flex items-center justify-between mt-3 pt-2 border-t border-gray-700">
                        <span className="text-gray-500 text-xs">
                          Page {eventsPage} of {eventsTotalPages}
                        </span>
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
              </section>

              {/* Tool Call Breakdown */}
              <section>
                <h3 className="text-sm font-semibold text-gray-200 mb-3">Tool Call Breakdown</h3>
                {toolStats.length === 0 ? (
                  <p className="text-gray-500 text-sm">No tool calls recorded.</p>
                ) : (
                  <>
                    <BarList data={toolBarListData} color="blue" className="mb-3" />
                    <div className="overflow-x-auto">
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
              </section>

              {/* Cost Breakdown */}
              <section>
                <h3 className="text-sm font-semibold text-gray-200 mb-3">Cost Breakdown</h3>
                {costBreakdownData.length === 0 ? (
                  <p className="text-gray-500 text-sm">No cost data available.</p>
                ) : (
                  <>
                    <DonutChart
                      data={costBreakdownData}
                      category="value"
                      index="name"
                      colors={['blue', 'cyan', 'violet', 'slate']}
                      className="h-36"
                      valueFormatter={(v) => `$${v.toFixed(4)}`}
                      showAnimation
                    />
                    <div className="mt-3 space-y-1.5">
                      {costBreakdownData.map((item) => (
                        <div key={item.name} className="flex items-center justify-between text-sm">
                          <span className="text-gray-400">{item.name}</span>
                          <span className="text-gray-200 font-mono">${item.value.toFixed(4)}</span>
                        </div>
                      ))}
                      <div className="flex items-center justify-between text-sm pt-1.5 border-t border-gray-700">
                        <span className="text-gray-300 font-medium">Total</span>
                        <span className="text-gray-100 font-mono font-medium">{formatCost(session.totalCost)}</span>
                      </div>
                    </div>
                  </>
                )}
              </section>

              {/* Token Breakdown */}
              <section>
                <h3 className="text-sm font-semibold text-gray-200 mb-3">Token Breakdown</h3>
                <div className="space-y-2">
                  {[
                    { label: 'Input', value: session.tokenCounts.input },
                    { label: 'Output', value: session.tokenCounts.output },
                    { label: 'Cache Creation', value: session.tokenCounts.cacheCreation },
                    { label: 'Cache Read', value: session.tokenCounts.cacheRead },
                  ].map(({ label, value }) => (
                    <div key={label} className="flex items-center justify-between text-sm">
                      <span className="text-gray-400">{label}</span>
                      <span className="text-gray-200 font-mono">{formatTokens(value)}</span>
                    </div>
                  ))}
                  <div className="flex items-center justify-between text-sm pt-1.5 border-t border-gray-700">
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
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Stat Card (compact) ──────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  subtitle,
}: {
  label: string;
  value: React.ReactNode;
  subtitle?: string;
}) {
  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 p-3">
      <p className="text-xs text-gray-400 mb-0.5">{label}</p>
      <p className="text-lg font-semibold text-gray-100">{value}</p>
      {subtitle && <p className="text-[10px] text-gray-500 mt-0.5">{subtitle}</p>}
    </div>
  );
}
