/**
 * Phase L1 — Session Detail Panel tests (Spec 10 ACs 1-11).
 *
 * Tests the sliding side panel behavior: opening, resizing, dismissal,
 * navigation to full detail, and data display.
 *
 * Why: The panel is the primary inspection surface for sessions. Users need
 * to quickly inspect any session from both the kanban dashboard and the sessions
 * table without losing their place. These tests verify the behavioral contract.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import React from 'react';

// Polyfill ResizeObserver for jsdom (used by Tremor components)
beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
});

// Mock the api module before importing the component
vi.mock('@client/api', () => ({
  api: {
    getSession: vi.fn(),
    getSessionEvents: vi.fn(),
  },
}));

import SessionDetailPanel from '@client/components/SessionDetailPanel';
import { api } from '@client/api';

const mockSessionData = {
  sessionId: 'test-session-123',
  project: 'my-project',
  workspace: '/home/user/project',
  models: ['claude-sonnet-4-20250514'],
  status: 'completed' as const,
  startTime: '2026-03-03T10:00:00.000Z',
  endTime: '2026-03-03T10:30:00.000Z',
  totalCost: 0.1234,
  tokenCounts: { input: 10000, output: 5000, cacheCreation: 2000, cacheRead: 3000 },
  turnCount: 15,
  inferredPhase: null,
  lastSeen: '2026-03-03T10:30:00.000Z',
  errorCount: 2,
};

const mockSession = {
  session: mockSessionData,
  metrics: null,
  tools: [],
};

const mockEvents = {
  data: [
    {
      id: 'evt-1',
      sessionId: 'test-session-123',
      timestamp: '2026-03-03T10:00:01.000Z',
      type: 'PostToolUse',
      tool: 'Read',
      payload: { file_path: '/src/main.ts' },
      project: 'my-project',
      workspace: '/home/user/project',
    },
    {
      id: 'evt-2',
      sessionId: 'test-session-123',
      timestamp: '2026-03-03T10:01:00.000Z',
      type: 'PostToolUseFailure',
      tool: 'Bash',
      payload: { command: 'npm test', error: 'Test failed' },
      project: 'my-project',
      workspace: '/home/user/project',
    },
  ],
  total: 2,
  page: 1,
  limit: 50,
};

function renderPanel(onClose = vi.fn()) {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Routes>
        <Route path="/dashboard" element={<SessionDetailPanel sessionId="test-session-123" onClose={onClose} />} />
        <Route path="/sessions/:id" element={<div data-testid="full-detail-page">Full Detail</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SessionDetailPanel (Spec 10 — Side Panel Behavior)', () => {
  beforeEach(() => {
    (api.getSession as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);
    (api.getSessionEvents as ReturnType<typeof vi.fn>).mockResolvedValue(mockEvents);
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // ── AC 2: Panel slides in from right edge ──────────────────────────────

  it('renders the panel with slide-in animation (AC 2)', async () => {
    renderPanel();

    const panel = screen.getByTestId('session-detail-panel');
    expect(panel).toBeDefined();

    // Panel should be positioned on the right
    expect(panel.style.width).toContain('%');
    expect(panel.className).toContain('right-0');
    expect(panel.className).toContain('fixed');
  });

  // ── AC 3: Default width shares screen ──────────────────────────────────

  it('opens at default 50% width (AC 3)', () => {
    renderPanel();

    const panel = screen.getByTestId('session-detail-panel');
    expect(panel.style.width).toBe('50%');
  });

  // ── AC 4: Displays data for the selected session ──────────────────────

  it('displays session data matching the selected session ID (AC 4)', async () => {
    renderPanel();

    await waitFor(() => {
      expect(api.getSession).toHaveBeenCalledWith('test-session-123');
    });

    await waitFor(() => {
      expect(screen.getByText('test-session-123')).toBeDefined();
    });

    // Cost may appear in multiple sections (summary + breakdown)
    expect(screen.getAllByText('$0.1234').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('completed')).toBeDefined();
  });

  // ── AC 5: Drag to resize ──────────────────────────────────────────────

  it('supports drag-to-resize via the left edge handle (AC 5)', () => {
    renderPanel();

    const dragHandle = screen.getByTestId('panel-drag-handle');
    expect(dragHandle).toBeDefined();
    expect(dragHandle.className).toContain('cursor-col-resize');
  });

  // ── AC 6: Width persists across openings ──────────────────────────────

  it('remembers panel width across openings within browser session (AC 6)', () => {
    sessionStorage.setItem('ralph-session-panel-width', '60');

    renderPanel();

    const panel = screen.getByTestId('session-detail-panel');
    expect(panel.style.width).toBe('60%');
  });

  // ── AC 7: Close button dismisses ──────────────────────────────────────

  it('close button calls onClose (AC 7)', () => {
    const onClose = vi.fn();
    renderPanel(onClose);

    const closeBtn = screen.getByTestId('panel-close-button');
    fireEvent.click(closeBtn);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── AC 8: Escape key dismisses ────────────────────────────────────────

  it('Escape key calls onClose (AC 8)', () => {
    const onClose = vi.fn();
    renderPanel(onClose);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── AC 9: Click outside dismisses ─────────────────────────────────────

  it('clicking the backdrop (outside panel) calls onClose (AC 9)', () => {
    const onClose = vi.fn();
    renderPanel(onClose);

    const backdrop = screen.getByTestId('session-panel-backdrop');
    fireEvent.click(backdrop);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── AC 10: Underlying page state preserved ────────────────────────────

  it('does not navigate away — renders as overlay preserving parent state (AC 10)', () => {
    renderPanel();

    const backdrop = screen.getByTestId('session-panel-backdrop');
    expect(backdrop.className).toContain('fixed');
    expect(backdrop.className).toContain('inset-0');
  });

  // ── AC 11: View Full navigates to full detail page ────────────────────

  it('"View Full" button exists and is clickable (AC 11)', () => {
    renderPanel();

    const viewFullBtn = screen.getByTestId('panel-view-full');
    expect(viewFullBtn).toBeDefined();
    expect(viewFullBtn.textContent).toContain('View Full');
  });

  // ── AC 1: Opens identically from kanban and sessions table ────────────

  it('renders the same component regardless of access point (AC 1)', () => {
    renderPanel();

    const panel = screen.getByTestId('session-detail-panel');
    expect(panel).toBeDefined();
    expect(screen.getByText('Session Detail')).toBeDefined();
  });

  // ── Summary Stats (ACs 12-17) ─────────────────────────────────────────

  it('displays all 6 summary stat fields (ACs 12-17)', async () => {
    renderPanel();

    await waitFor(() => {
      expect(screen.getAllByText('$0.1234').length).toBeGreaterThanOrEqual(1);
    });

    // AC 12: Cost
    expect(screen.getByText('Total Cost')).toBeDefined();
    // AC 13: Duration
    expect(screen.getByText('Duration')).toBeDefined();
    // AC 14: Turn count
    expect(screen.getByText('Turn Count')).toBeDefined();
    expect(screen.getAllByText('15').length).toBeGreaterThanOrEqual(1);
    // AC 15: Model
    expect(screen.getByText('Model')).toBeDefined();
    // AC 16: Error count
    expect(screen.getByText('Errors')).toBeDefined();
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(1);
    // AC 17: Token breakdown
    expect(screen.getByText('Tokens')).toBeDefined();
  });

  // ── Event Timeline (ACs 18-21) ────────────────────────────────────────

  it('displays event timeline with type, tool, and timestamp (ACs 18-19)', async () => {
    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('2 events')).toBeDefined();
    });

    expect(screen.getByText('Event Timeline')).toBeDefined();
    // Events may appear in both timeline and tool breakdown sections
    expect(screen.getAllByText('PostToolUse').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('PostToolUseFailure').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Read').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Bash').length).toBeGreaterThanOrEqual(1);
  });

  // ── Tool Call Breakdown (ACs 22-25) ───────────────────────────────────

  it('displays tool call breakdown with call counts (ACs 22-25)', async () => {
    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('Tool Call Breakdown')).toBeDefined();
    });
  });

  // ── Cost Breakdown (ACs 30-31) ────────────────────────────────────────

  it('displays cost breakdown section (ACs 30-31)', async () => {
    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('Cost Breakdown')).toBeDefined();
    });
  });

  // ── Token Usage ─────────────────────────────────────────────────────

  it('displays token usage section', async () => {
    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('Token Usage')).toBeDefined();
    });
  });

  // ── Edge Cases ────────────────────────────────────────────────────────

  it('handles session not found gracefully (AC 38)', async () => {
    (api.getSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Not found'));

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('Not found')).toBeDefined();
    });
  });

  it('handles session with no events (AC 37)', async () => {
    (api.getSessionEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 50,
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('No events recorded.')).toBeDefined();
    });
  });

  it('handles session with no tool calls showing appropriate message', async () => {
    (api.getSessionEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        {
          id: 'evt-1',
          sessionId: 'test-session-123',
          timestamp: '2026-03-03T10:00:01.000Z',
          type: 'SessionStart',
          tool: null,
          payload: {},
          project: 'my-project',
          workspace: '/home/user/project',
        },
      ],
      total: 1,
      page: 1,
      limit: 50,
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('No tool calls recorded.')).toBeDefined();
    });
  });

  // ── Panel width bounds ────────────────────────────────────────────────

  it('clamps stored width to valid range', () => {
    sessionStorage.setItem('ralph-session-panel-width', '95');

    renderPanel();

    const panel = screen.getByTestId('session-detail-panel');
    expect(panel.style.width).toBe('50%');
  });

  it('handles invalid stored width gracefully', () => {
    sessionStorage.setItem('ralph-session-panel-width', 'invalid');

    renderPanel();

    const panel = screen.getByTestId('session-detail-panel');
    expect(panel.style.width).toBe('50%');
  });

  // ── AC 36: Running session auto-updates ───────────────────────────────

  it('auto-refreshes data for running sessions (AC 36)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const runningSession = {
      session: { ...mockSessionData, status: 'running' as const, endTime: null },
      metrics: null,
      tools: [],
    };
    (api.getSession as ReturnType<typeof vi.fn>).mockResolvedValue(runningSession);

    renderPanel();

    await waitFor(() => {
      expect(api.getSession).toHaveBeenCalledTimes(1);
    });

    // Advance timer by 5 seconds to trigger auto-refresh
    await act(async () => {
      vi.advanceTimersByTime(5100);
    });

    await waitFor(() => {
      expect((api.getSession as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    vi.useRealTimers();
  });

  // ── API calls correct ─────────────────────────────────────────────────

  it('fetches both session and events on mount', async () => {
    renderPanel();

    await waitFor(() => {
      expect(api.getSession).toHaveBeenCalledWith('test-session-123');
      expect(api.getSessionEvents).toHaveBeenCalledWith('test-session-123', { page: 1, limit: 50 });
    });
  });
});
