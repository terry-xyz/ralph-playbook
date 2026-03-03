import { useState, useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useWebSocket } from './hooks/useWebSocket';

// ── Theme management ─────────────────────────────────────────────────────────

function getStoredTheme(): 'dark' | 'light' {
  try {
    const stored = localStorage.getItem('ralph-theme');
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // localStorage may be unavailable
  }
  return 'dark';
}

function applyTheme(theme: 'dark' | 'light') {
  const root = document.documentElement;
  if (theme === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
  try {
    localStorage.setItem('ralph-theme', theme);
  } catch {
    // ignore
  }
}

// ── Navigation links ─────────────────────────────────────────────────────────

interface NavItem {
  label: string;
  to: string;
  icon: string;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', to: '/dashboard', icon: '\u25A3' },
  { label: 'Sessions', to: '/sessions', icon: '\u25B6' },
  { label: 'Live Feed', to: '/live', icon: '\u25C9' },
  { label: 'Costs', to: '/costs', icon: '$' },
  { label: 'Errors', to: '/errors', icon: '!' },
  { label: 'Settings', to: '/settings', icon: '\u2699' },
];

// ── Link style helpers ───────────────────────────────────────────────────────

const baseLinkClass =
  'flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors';
const activeLinkClass =
  'bg-blue-600 text-white';
const inactiveLinkClass =
  'text-gray-400 hover:bg-gray-700 hover:text-gray-100 dark:text-gray-400 dark:hover:bg-gray-700';

function linkClassName({ isActive }: { isActive: boolean }) {
  return `${baseLinkClass} ${isActive ? activeLinkClass : inactiveLinkClass}`;
}

// ── Event type badge colors ──────────────────────────────────────────────────

const EVENT_TYPE_COLORS: Record<string, string> = {
  SessionStart: 'bg-green-500/20 text-green-400',
  SessionEnd: 'bg-blue-500/20 text-blue-400',
  Stop: 'bg-blue-500/20 text-blue-400',
  PostToolUse: 'bg-cyan-500/20 text-cyan-400',
  PreToolUse: 'bg-cyan-500/20 text-cyan-300',
  PostToolUseFailure: 'bg-red-500/20 text-red-400',
  SubagentStart: 'bg-purple-500/20 text-purple-400',
  SubagentStop: 'bg-purple-500/20 text-purple-300',
  UserPromptSubmit: 'bg-amber-500/20 text-amber-400',
  PreCompact: 'bg-gray-500/20 text-gray-400',
  Notification: 'bg-yellow-500/20 text-yellow-400',
  PermissionRequest: 'bg-orange-500/20 text-orange-400',
};

function formatRelativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function getEventDescription(event: Record<string, unknown>): string {
  const type = event.type as string;
  const payload = event.payload as Record<string, unknown> | undefined;
  const tool = (event.tool ?? payload?.tool_name ?? '') as string;

  switch (type) {
    case 'SessionStart':
      return 'Session started';
    case 'SessionEnd':
    case 'Stop':
      return 'Session ended';
    case 'PostToolUse':
      return tool ? `Used ${tool}` : 'Tool call completed';
    case 'PreToolUse':
      return tool ? `Calling ${tool}` : 'Tool call starting';
    case 'PostToolUseFailure':
      return tool ? `${tool} failed` : 'Tool call failed';
    case 'SubagentStart':
      return 'Subagent spawned';
    case 'SubagentStop':
      return 'Subagent completed';
    case 'UserPromptSubmit':
      return 'User prompt submitted';
    case 'PreCompact':
      return 'Context compaction';
    case 'Notification':
      return 'Notification';
    case 'PermissionRequest':
      return 'Permission requested';
    default:
      return type;
  }
}

// ── Sidebar event entry ──────────────────────────────────────────────────────

interface SidebarEvent {
  id: string;
  type: string;
  sessionId: string;
  timestamp: string;
  tool?: string;
  payload?: Record<string, unknown>;
}

function SidebarEventEntry({ event }: { event: SidebarEvent }) {
  const colorClass = EVENT_TYPE_COLORS[event.type] ?? 'bg-gray-500/20 text-gray-400';

  return (
    <div className="flex items-start gap-2 py-1.5 px-2 rounded hover:bg-gray-800/50 transition-colors">
      <span
        className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium shrink-0 mt-0.5 ${colorClass}`}
      >
        {event.type.replace(/([a-z])([A-Z])/g, '$1 $2').slice(0, 12)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-gray-300 truncate">
          {getEventDescription(event as unknown as Record<string, unknown>)}
        </p>
        <p className="text-[10px] text-gray-500 truncate">
          {event.sessionId?.slice(0, 8)}...
          <span className="ml-1">{formatRelativeTime(event.timestamp)}</span>
        </p>
      </div>
    </div>
  );
}

const MAX_SIDEBAR_EVENTS = 50;

// ── App component ────────────────────────────────────────────────────────────

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(getStoredTheme);
  const [activitySidebarOpen, setActivitySidebarOpen] = useState(true);
  const location = useLocation();
  const { events: wsEvents, status: wsStatus } = useWebSocket();
  const [, setTick] = useState(0);

  const isDashboard = location.pathname === '/dashboard';

  // Periodic tick to update relative timestamps
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(interval);
  }, []);

  // Derive sidebar events from WS events (most recent first, capped)
  const sidebarEvents: SidebarEvent[] = wsEvents
    .slice(-MAX_SIDEBAR_EVENTS)
    .reverse()
    .filter((e): e is SidebarEvent => {
      if (!e || typeof e !== 'object') return false;
      const obj = e as Record<string, unknown>;
      return typeof obj.type === 'string' && typeof obj.sessionId === 'string';
    });

  // Auto-scroll ref
  const sidebarScrollRef = useRef<HTMLDivElement>(null);

  // Apply theme on mount and when it changes
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  function toggleTheme() {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }

  return (
    <div className="flex h-screen flex-col bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      {/* ── Top navigation bar ─────────────────────────────────────────── */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4 dark:border-gray-800 dark:bg-gray-900">
        {/* Logo */}
        <div className="flex items-center gap-6">
          <NavLink to="/dashboard" className="text-lg font-bold text-blue-500">
            Ralph Monitor
          </NavLink>

          {/* Horizontal page links (top bar) */}
          <nav className="hidden lg:flex items-center gap-1">
            {NAV_ITEMS.map((item) => (
              <NavLink key={item.to} to={item.to} className={linkClassName}>
                <span className="w-4 text-center text-xs">{item.icon}</span>
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>

        {/* Right side: theme toggle */}
        <div className="flex items-center gap-3">
          <button
            onClick={toggleTheme}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800 transition-colors"
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === 'dark' ? '\u2600 Light' : '\u263E Dark'}
          </button>
        </div>
      </header>

      {/* ── Body: sidebar + main + activity panel ──────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar */}
        <aside className="flex w-52 shrink-0 flex-col border-r border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          <nav className="flex flex-col gap-1 p-3">
            {NAV_ITEMS.map((item) => (
              <NavLink key={item.to} to={item.to} className={linkClassName}>
                <span className="w-4 text-center text-xs">{item.icon}</span>
                {item.label}
              </NavLink>
            ))}
          </nav>
        </aside>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>

        {/* Live activity sidebar — visible only on /dashboard */}
        {isDashboard && (
          <aside
            className={`shrink-0 border-l border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 transition-all overflow-hidden ${
              activitySidebarOpen ? 'w-72' : 'w-10'
            }`}
          >
            <div className="flex items-center justify-between p-3 border-b border-gray-200 dark:border-gray-800">
              {activitySidebarOpen && (
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                    Live Activity
                  </h2>
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      wsStatus === 'connected' ? 'bg-green-500' : wsStatus === 'connecting' ? 'bg-yellow-500 animate-pulse' : 'bg-red-500'
                    }`}
                  />
                </div>
              )}
              <button
                onClick={() => setActivitySidebarOpen((prev) => !prev)}
                className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                title={activitySidebarOpen ? 'Collapse activity panel' : 'Expand activity panel'}
              >
                {activitySidebarOpen ? '\u00AB' : '\u00BB'}
              </button>
            </div>
            {activitySidebarOpen && (
              <div ref={sidebarScrollRef} className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 110px)' }}>
                {sidebarEvents.length === 0 ? (
                  <div className="p-3 text-sm text-gray-500 dark:text-gray-400">
                    <p>No live events yet. Activity will appear here when sessions are running.</p>
                  </div>
                ) : (
                  <div className="p-1 space-y-0.5">
                    {sidebarEvents.map((event, i) => (
                      <SidebarEventEntry key={event.id ?? i} event={event} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
