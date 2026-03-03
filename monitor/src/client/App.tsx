import { useState, useEffect } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

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

// ── App component ────────────────────────────────────────────────────────────

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(getStoredTheme);
  const [activitySidebarOpen, setActivitySidebarOpen] = useState(true);
  const location = useLocation();

  const isDashboard = location.pathname === '/dashboard';

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
            className={`shrink-0 border-l border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 transition-all overflow-y-auto ${
              activitySidebarOpen ? 'w-72' : 'w-10'
            }`}
          >
            <div className="flex items-center justify-between p-3 border-b border-gray-200 dark:border-gray-800">
              {activitySidebarOpen && (
                <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                  Live Activity
                </h2>
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
              <div className="p-3 text-sm text-gray-500 dark:text-gray-400">
                <p>No live events yet. Activity will appear here when sessions are running.</p>
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
