import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Badge, Card } from '@tremor/react';
import { useWebSocket } from '../hooks/useWebSocket';
import { api } from '../api';
import type { HookEventType, EventRecord, Config } from '@shared/types';

// ── Constants ────────────────────────────────────────────────────────────────

const ALL_EVENT_TYPES: HookEventType[] = [
  'SessionStart',
  'SessionEnd',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'PreCompact',
  'Notification',
  'PermissionRequest',
];

const SESSION_LEVEL_TYPES: Set<HookEventType> = new Set([
  'SessionStart',
  'SessionEnd',
  'Stop',
  'SubagentStart',
  'SubagentStop',
]);

const EVENT_TYPE_COLORS: Record<HookEventType, string> = {
  SessionStart: 'emerald',
  SessionEnd: 'gray',
  Stop: 'red',
  SubagentStart: 'cyan',
  SubagentStop: 'slate',
  PreToolUse: 'blue',
  PostToolUse: 'indigo',
  PostToolUseFailure: 'rose',
  UserPromptSubmit: 'amber',
  PreCompact: 'violet',
  Notification: 'yellow',
  PermissionRequest: 'orange',
};

const MAX_EVENTS = 500;

// ── Helpers ──────────────────────────────────────────────────────────────────

function isEventRecord(value: unknown): value is EventRecord {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.sessionId === 'string' &&
    typeof obj.timestamp === 'string' &&
    typeof obj.type === 'string'
  );
}

function formatRelativeTime(isoTimestamp: string): string {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return 'just now';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function truncateSessionId(sessionId: string): string {
  if (sessionId.length <= 12) return sessionId;
  return `${sessionId.slice(0, 8)}...`;
}

// ── Connection Status Badge ──────────────────────────────────────────────────

function ConnectionBadge({ status }: { status: 'connected' | 'connecting' | 'disconnected' }) {
  const colorMap = {
    connected: 'emerald',
    connecting: 'yellow',
    disconnected: 'red',
  } as const;

  const labelMap = {
    connected: 'Connected',
    connecting: 'Connecting...',
    disconnected: 'Disconnected',
  } as const;

  return (
    <Badge color={colorMap[status]} size="sm">
      <span className="flex items-center gap-1.5">
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            status === 'connected'
              ? 'bg-emerald-400 animate-pulse'
              : status === 'connecting'
                ? 'bg-yellow-400 animate-pulse'
                : 'bg-red-400'
          }`}
        />
        {labelMap[status]}
      </span>
    </Badge>
  );
}

// ── Event Type Filter Button ─────────────────────────────────────────────────

function EventTypeToggle({
  type,
  active,
  onToggle,
}: {
  type: HookEventType;
  active: boolean;
  onToggle: (type: HookEventType) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(type)}
      className={`px-2 py-1 text-xs rounded font-medium transition-colors border ${
        active
          ? 'bg-gray-600 border-gray-500 text-gray-100'
          : 'bg-gray-800/50 border-gray-700 text-gray-500 hover:text-gray-400 hover:border-gray-600'
      }`}
    >
      {type}
    </button>
  );
}

// ── Single Event Row ─────────────────────────────────────────────────────────

function EventRow({ event }: { event: EventRecord }) {
  const [expanded, setExpanded] = useState(false);

  const badgeColor = EVENT_TYPE_COLORS[event.type] ?? 'gray';

  return (
    <div
      className="border-b border-gray-700/50 px-4 py-2.5 hover:bg-gray-800/50 transition-colors cursor-pointer"
      onClick={() => setExpanded((prev) => !prev)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setExpanded((prev) => !prev);
        }
      }}
    >
      <div className="flex items-center gap-3 min-w-0">
        {/* Event type badge */}
        <Badge color={badgeColor as never} size="sm" className="shrink-0">
          {event.type}
        </Badge>

        {/* Tool name */}
        {event.tool && (
          <span className="text-sm font-mono text-blue-300 truncate shrink-0 max-w-[180px]">
            {event.tool}
          </span>
        )}

        {/* Session ID */}
        <span
          className="text-xs font-mono text-gray-500 shrink-0"
          title={event.sessionId}
        >
          {truncateSessionId(event.sessionId)}
        </span>

        {/* Spacer */}
        <span className="flex-1" />

        {/* Timestamp */}
        <span className="text-xs text-gray-500 shrink-0 tabular-nums">
          {formatRelativeTime(event.timestamp)}
        </span>

        {/* Expand indicator */}
        <svg
          className={`h-4 w-4 text-gray-500 shrink-0 transition-transform ${
            expanded ? 'rotate-180' : ''
          }`}
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {/* Expanded payload */}
      {expanded && (
        <div className="mt-2 ml-1">
          <pre className="text-xs text-gray-400 bg-gray-900/70 rounded p-3 overflow-x-auto max-h-64 whitespace-pre-wrap break-all">
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Main Page Component ──────────────────────────────────────────────────────

export default function LiveFeedPage() {
  const { status, events: rawEvents } = useWebSocket();

  // ── Config-driven default verbosity ──────────────────────────────────────
  const [verbosity, setVerbosity] = useState<'summary' | 'granular'>('summary');
  const [configLoaded, setConfigLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getConfig()
      .then((cfg: Config) => {
        if (!cancelled && !configLoaded) {
          setVerbosity(cfg.display.liveFeedVerbosity);
          setConfigLoaded(true);
        }
      })
      .catch(() => {
        // Fallback to default 'summary'
        if (!cancelled) setConfigLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [configLoaded]);

  // ── Filter state ─────────────────────────────────────────────────────────
  const [activeTypes, setActiveTypes] = useState<Set<HookEventType>>(
    () => new Set(ALL_EVENT_TYPES),
  );
  const [sessionFilter, setSessionFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('');

  const handleTypeToggle = useCallback((type: HookEventType) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setActiveTypes(new Set(ALL_EVENT_TYPES));
  }, []);

  const handleSelectNone = useCallback(() => {
    setActiveTypes(new Set());
  }, []);

  // ── Parse and filter events ──────────────────────────────────────────────
  const parsedEvents: EventRecord[] = useMemo(() => {
    const result: EventRecord[] = [];
    for (const raw of rawEvents) {
      if (isEventRecord(raw)) {
        result.push(raw);
      }
    }
    // Cap to MAX_EVENTS
    if (result.length > MAX_EVENTS) {
      return result.slice(result.length - MAX_EVENTS);
    }
    return result;
  }, [rawEvents]);

  const filteredEvents: EventRecord[] = useMemo(() => {
    const sessionQuery = sessionFilter.trim().toLowerCase();
    const projectQuery = projectFilter.trim().toLowerCase();

    return parsedEvents.filter((event) => {
      // Verbosity filter
      if (verbosity === 'summary' && !SESSION_LEVEL_TYPES.has(event.type)) {
        return false;
      }

      // Event type filter
      if (!activeTypes.has(event.type)) {
        return false;
      }

      // Session ID filter
      if (sessionQuery && !event.sessionId.toLowerCase().includes(sessionQuery)) {
        return false;
      }

      // Project filter
      if (projectQuery && !(event.project ?? '').toLowerCase().includes(projectQuery)) {
        return false;
      }

      return true;
    });
  }, [parsedEvents, verbosity, activeTypes, sessionFilter, projectFilter]);

  // ── Auto-scroll & pause logic ────────────────────────────────────────────
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [bufferedCount, setBufferedCount] = useState(0);
  const lastRenderedCountRef = useRef(0);
  const isUserScrollingRef = useRef(false);

  const isNearBottom = useCallback((): boolean => {
    const container = scrollContainerRef.current;
    if (!container) return true;
    const threshold = 40;
    return (
      container.scrollHeight - container.scrollTop - container.clientHeight <
      threshold
    );
  }, []);

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, []);

  const handleResumeClick = useCallback(() => {
    setIsPaused(false);
    setBufferedCount(0);
    // Wait for render to complete then scroll to bottom
    requestAnimationFrame(() => {
      scrollToBottom();
    });
  }, [scrollToBottom]);

  // Handle scroll events to detect user scrolling up
  const handleScroll = useCallback(() => {
    if (isUserScrollingRef.current) {
      if (isNearBottom()) {
        // User scrolled back down to bottom
        setIsPaused(false);
        setBufferedCount(0);
      } else {
        setIsPaused(true);
      }
    }
  }, [isNearBottom]);

  // Track user-initiated scroll vs programmatic scroll
  const handlePointerDown = useCallback(() => {
    isUserScrollingRef.current = true;
  }, []);

  const handlePointerUp = useCallback(() => {
    // Delay reset slightly so scroll handler can still detect user intent
    requestAnimationFrame(() => {
      isUserScrollingRef.current = false;
    });
  }, []);

  const handleWheel = useCallback(() => {
    isUserScrollingRef.current = true;
    // Reset after a short delay
    setTimeout(() => {
      isUserScrollingRef.current = false;
    }, 150);
  }, []);

  // Auto-scroll when new events arrive (only if not paused)
  useEffect(() => {
    const newCount = filteredEvents.length;
    const delta = newCount - lastRenderedCountRef.current;
    lastRenderedCountRef.current = newCount;

    if (delta <= 0) return;

    if (isPaused) {
      setBufferedCount((prev) => prev + delta);
    } else {
      requestAnimationFrame(() => {
        scrollToBottom();
      });
    }
  }, [filteredEvents.length, isPaused, scrollToBottom]);

  // ── Relative time refresh ────────────────────────────────────────────────
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(interval);
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-100">Live Feed</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-400">
            {parsedEvents.length} events
          </span>
          <ConnectionBadge status={status} />
        </div>
      </div>

      {/* Controls Card */}
      <Card className="bg-gray-800 ring-gray-700 p-4">
        <div className="space-y-4">
          {/* Verbosity Toggle */}
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-gray-300 w-20 shrink-0">
              Verbosity
            </span>
            <div className="inline-flex rounded-md overflow-hidden border border-gray-600">
              <button
                type="button"
                onClick={() => setVerbosity('summary')}
                className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                  verbosity === 'summary'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                Summary
              </button>
              <button
                type="button"
                onClick={() => setVerbosity('granular')}
                className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                  verbosity === 'granular'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                Granular
              </button>
            </div>
          </div>

          {/* Text Filters */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm font-medium text-gray-300 w-20 shrink-0">
              Filters
            </span>
            <input
              type="text"
              placeholder="Session ID..."
              value={sessionFilter}
              onChange={(e) => setSessionFilter(e.target.value)}
              className="px-3 py-1.5 text-sm bg-gray-900 border border-gray-600 rounded text-gray-200 placeholder-gray-500 focus:border-blue-500 focus:outline-none w-48"
            />
            <input
              type="text"
              placeholder="Project..."
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              className="px-3 py-1.5 text-sm bg-gray-900 border border-gray-600 rounded text-gray-200 placeholder-gray-500 focus:border-blue-500 focus:outline-none w-48"
            />
          </div>

          {/* Event Type Filters */}
          <div className="flex items-start gap-3">
            <span className="text-sm font-medium text-gray-300 w-20 shrink-0 pt-1">
              Events
            </span>
            <div className="flex flex-wrap gap-1.5 flex-1">
              {ALL_EVENT_TYPES.map((type) => (
                <EventTypeToggle
                  key={type}
                  type={type}
                  active={activeTypes.has(type)}
                  onToggle={handleTypeToggle}
                />
              ))}
              <div className="flex gap-1.5 ml-2">
                <button
                  type="button"
                  onClick={handleSelectAll}
                  className="px-2 py-1 text-xs rounded font-medium text-blue-400 hover:text-blue-300 transition-colors"
                >
                  All
                </button>
                <button
                  type="button"
                  onClick={handleSelectNone}
                  className="px-2 py-1 text-xs rounded font-medium text-blue-400 hover:text-blue-300 transition-colors"
                >
                  None
                </button>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* Event Feed */}
      <Card className="bg-gray-800 ring-gray-700 p-0 relative overflow-hidden">
        {/* Pause Banner */}
        {isPaused && (
          <div className="sticky top-0 z-10 bg-yellow-900/80 backdrop-blur-sm border-b border-yellow-700/50 px-4 py-2 flex items-center justify-between">
            <span className="text-sm text-yellow-200">
              <span className="font-medium">Paused</span>
              <span className="text-yellow-300 ml-2">
                {bufferedCount} new event{bufferedCount !== 1 ? 's' : ''} buffered
              </span>
            </span>
            <button
              type="button"
              onClick={handleResumeClick}
              className="px-3 py-1 text-xs font-medium rounded bg-yellow-700 text-yellow-100 hover:bg-yellow-600 transition-colors"
            >
              Resume
            </button>
          </div>
        )}

        {/* Scrollable event list */}
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onWheel={handleWheel}
          className="overflow-y-auto"
          style={{ maxHeight: 'calc(100vh - 380px)', minHeight: '300px' }}
        >
          {filteredEvents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-gray-500">
              {parsedEvents.length === 0 ? (
                <>
                  <svg
                    className="h-12 w-12 mb-3 text-gray-600"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={1.5}
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M9.348 14.651a3.75 3.75 0 010-5.303m5.304 0a3.75 3.75 0 010 5.303m-7.425 2.122a6.75 6.75 0 010-9.546m9.546 0a6.75 6.75 0 010 9.546M5.106 18.894c-3.808-3.808-3.808-9.98 0-13.788m13.788 0c3.808 3.808 3.808 9.98 0 13.788M12 12h.008v.008H12V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"
                    />
                  </svg>
                  <p className="text-sm">Waiting for events...</p>
                  <p className="text-xs text-gray-600 mt-1">
                    Events will appear here as Claude Code sessions send hook data.
                  </p>
                </>
              ) : (
                <>
                  <svg
                    className="h-12 w-12 mb-3 text-gray-600"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={1.5}
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 01-.659 1.591l-5.432 5.432a2.25 2.25 0 00-.659 1.591v2.927a2.25 2.25 0 01-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 00-.659-1.591L3.659 7.409A2.25 2.25 0 013 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0112 3z"
                    />
                  </svg>
                  <p className="text-sm">No events match current filters</p>
                  <p className="text-xs text-gray-600 mt-1">
                    Try adjusting verbosity, event types, or filter text.
                  </p>
                </>
              )}
            </div>
          ) : (
            filteredEvents.map((event) => (
              <EventRow key={event.id} event={event} />
            ))
          )}
        </div>

        {/* Bottom bar with count */}
        <div className="border-t border-gray-700/50 px-4 py-2 flex items-center justify-between bg-gray-800/80">
          <span className="text-xs text-gray-500">
            Showing {filteredEvents.length} of {parsedEvents.length} events
          </span>
          <span className="text-xs text-gray-600">
            Buffer limit: {MAX_EVENTS}
          </span>
        </div>
      </Card>
    </div>
  );
}
