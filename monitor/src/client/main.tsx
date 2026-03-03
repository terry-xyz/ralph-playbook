import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import App from './App';
import './index.css';

// ── Lazy-loaded page components ──────────────────────────────────────────────

const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const SessionsPage = lazy(() => import('./pages/SessionsPage'));
const SessionDetailPage = lazy(() => import('./pages/SessionDetailPage'));
const LiveFeedPage = lazy(() => import('./pages/LiveFeedPage'));
const CostsPage = lazy(() => import('./pages/CostsPage'));
const ErrorsPage = lazy(() => import('./pages/ErrorsPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));

// ── Loading fallback ─────────────────────────────────────────────────────────

function PageLoading() {
  return (
    <div className="flex items-center justify-center py-20">
      <p className="text-sm text-gray-500 dark:text-gray-400">Loading...</p>
    </div>
  );
}

// ── Apply initial theme before render ────────────────────────────────────────

(function applyInitialTheme() {
  try {
    const stored = localStorage.getItem('ralph-theme');
    if (stored === 'light') {
      document.documentElement.classList.remove('dark');
    } else {
      document.documentElement.classList.add('dark');
    }
  } catch {
    document.documentElement.classList.add('dark');
  }
})();

// ── Render ───────────────────────────────────────────────────────────────────

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <BrowserRouter>
      <Suspense fallback={<PageLoading />}>
        <Routes>
          <Route element={<App />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="dashboard" element={<DashboardPage />} />
            <Route path="sessions" element={<SessionsPage />} />
            <Route path="sessions/:id" element={<SessionDetailPage />} />
            <Route path="live" element={<LiveFeedPage />} />
            <Route path="costs" element={<CostsPage />} />
            <Route path="errors" element={<ErrorsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  </React.StrictMode>,
);
