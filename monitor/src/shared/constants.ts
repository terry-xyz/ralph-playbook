/**
 * Canonical constants for Ralph Monitor.
 * Single source of truth for event types, statuses, phases, defaults, and paths.
 */

import type { Config, HookEventType, SessionPhase, SessionStatus } from './types.js';

// ── Event Types (Spec 01: 12 hook event types) ──────────────────────────────

export const HOOK_EVENT_TYPES: readonly HookEventType[] = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'Notification',
  'PermissionRequest',
  'SessionStart',
  'SessionEnd',
] as const;

// ── Session Statuses (Spec 05: exactly 4) ────────────────────────────────────

export const SESSION_STATUSES: readonly SessionStatus[] = [
  'running',
  'completed',
  'errored',
  'stale',
] as const;

// ── Session Phases (Spec 05: exactly 8 inferred phases) ──────────────────────

export const SESSION_PHASES: readonly SessionPhase[] = [
  'Reading the plan',
  'Orienting',
  'Investigating code',
  'Implementing',
  'Validating',
  'Committing',
  'Updating the plan',
  'Delegating',
] as const;

// ── File Paths ───────────────────────────────────────────────────────────────

export const DEFAULT_DATA_DIR = './data';
export const EVENTS_SUBDIR = 'events';
export const DB_FILENAME = 'ralph-monitor.db';
export const CONFIG_FILENAME = 'ralph-monitor.config.json';
export const INGESTER_LOCK_FILENAME = 'ingester.lock';

/** Resolve the events directory relative to a base data dir. */
export function eventsDir(dataDir: string): string {
  return `${dataDir}/${EVENTS_SUBDIR}`;
}

/** Resolve the database file path relative to a base data dir. */
export function dbPath(dataDir: string): string {
  return `${dataDir}/${DB_FILENAME}`;
}

/** Resolve the ingester lock file path relative to a base data dir. */
export function lockPath(dataDir: string): string {
  return `${dataDir}/${INGESTER_LOCK_FILENAME}`;
}

// ── Default Port ─────────────────────────────────────────────────────────────

export const DEFAULT_PORT = 9100;

// ── Status Colors (Spec 07: green=running, blue=completed, red=errored, yellow=stale) ──

export const STATUS_COLORS: Record<SessionStatus, string> = {
  running: 'green',
  completed: 'blue',
  errored: 'red',
  stale: 'yellow',
} as const;

// ── Default Configuration (Spec 14: all 17+ defaults) ────────────────────────

export const DEFAULT_CONFIG: Config = {
  general: {
    port: 9100,
    dataDir: './data',
    staleTimeoutMinutes: 60,
    retentionDays: 30,
  },
  ingestion: {
    batchIntervalMs: 1000,
    batchSize: 100,
    mode: 'auto',
  },
  scrape: {
    claudeDir: '~/.claude',
    captureFullResponses: false,
    captureExtendedThinking: true,
  },
  guardrails: {},
  display: {
    theme: 'dark',
    liveFeedVerbosity: 'summary',
    defaultCostRange: 'today',
  },
  pricing: {
    'claude-sonnet-4-20250514': {
      inputPer1k: 0.003,
      outputPer1k: 0.015,
      cacheCreationPer1k: 0.00375,
      cacheReadPer1k: 0.0003,
    },
    'claude-opus-4-20250514': {
      inputPer1k: 0.015,
      outputPer1k: 0.075,
      cacheCreationPer1k: 0.01875,
      cacheReadPer1k: 0.0015,
    },
    'claude-haiku-4-20250414': {
      inputPer1k: 0.0008,
      outputPer1k: 0.004,
      cacheCreationPer1k: 0.001,
      cacheReadPer1k: 0.00008,
    },
  },
  alerts: {
    perSessionCostLimit: null,
    perDayCostLimit: null,
  },
};
