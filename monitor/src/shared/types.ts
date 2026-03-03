/**
 * Core type definitions for Ralph Monitor.
 * Matches Spec 01 (12 event types), Spec 04 (4 tables), Spec 05 (4 statuses, 8 phases),
 * and Spec 14 (configuration schema).
 */

// ── Event Types ──────────────────────────────────────────────────────────────

export type HookEventType =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'Notification'
  | 'PermissionRequest'
  | 'SessionStart'
  | 'SessionEnd';

/** Raw event payload from a Claude Code hook (read from stdin). */
export interface HookEventPayload {
  session_id?: string;
  tool_name?: string;
  tool_use_id?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  error?: string;
  message?: string;
  [key: string]: unknown;
}

/** Normalized event record written to JSONL and stored in the events table. */
export interface EventRecord {
  id: string;
  sessionId: string;
  timestamp: string; // ISO 8601
  type: HookEventType;
  tool: string | null;
  payload: HookEventPayload;
  project: string;
  workspace: string;
  toolUseId?: string;
  duration?: number;
}

// ── Session Types ────────────────────────────────────────────────────────────

export type SessionStatus = 'running' | 'completed' | 'errored' | 'stale';

export type SessionPhase =
  | 'Reading the plan'
  | 'Orienting'
  | 'Investigating code'
  | 'Implementing'
  | 'Validating'
  | 'Committing'
  | 'Updating the plan'
  | 'Delegating';

export interface TokenCounts {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface Session {
  sessionId: string;
  project: string;
  workspace: string;
  model: string | null;
  status: SessionStatus;
  startTime: string; // ISO 8601
  endTime: string | null;
  totalCost: number;
  tokenCounts: TokenCounts;
  turnCount: number;
  inferredPhase: SessionPhase | null;
  lastSeen: string; // ISO 8601
  errorCount: number;
}

// ── Metrics Types ────────────────────────────────────────────────────────────

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  cacheCreationCost: number;
  cacheReadCost: number;
}

export interface SessionMetrics {
  sessionId: string;
  costBreakdown: CostBreakdown;
  tokenBreakdown: TokenCounts;
  model: string;
  wallClockDuration: number; // seconds
  apiDuration: number; // seconds
  turnCount: number;
}

// ── Guardrail Types ──────────────────────────────────────────────────────────

export type GuardrailAction = 'block' | 'warn' | 'off';

export interface GuardrailLogEntry {
  id: string;
  sessionId: string;
  ruleName: string;
  action: GuardrailAction;
  timestamp: string;
  payload: Record<string, unknown>;
}

// ── Error Types ──────────────────────────────────────────────────────────────

export type ErrorCategory =
  | 'tool_failure'
  | 'rate_limit'
  | 'auth_error'
  | 'billing_error'
  | 'server_error';

export interface ErrorRecord {
  id: string;
  sessionId: string;
  timestamp: string;
  category: ErrorCategory;
  message: string;
  tool: string | null;
  project: string;
}

// ── Configuration Types (Spec 14) ────────────────────────────────────────────

export interface ModelPricing {
  inputPer1k: number;
  outputPer1k: number;
  cacheCreationPer1k: number;
  cacheReadPer1k: number;
}

export interface GuardrailRuleConfig {
  mode: GuardrailAction;
  patterns?: string[];
  paths?: string[];
  costLimit?: number;
  chainLimit?: number;
  delayMs?: number;
}

export interface Config {
  general: {
    port: number;
    dataDir: string;
    staleTimeoutMinutes: number;
    retentionDays: number;
  };
  ingestion: {
    batchIntervalMs: number;
    batchSize: number;
    mode: 'auto' | 'manual';
  };
  scrape: {
    claudeDir: string;
    captureFullResponses: boolean;
    captureExtendedThinking: boolean;
  };
  guardrails: {
    [ruleName: string]: GuardrailRuleConfig;
  };
  display: {
    theme: 'dark' | 'light';
    liveFeedVerbosity: 'summary' | 'granular';
    defaultCostRange: 'today' | 'this week' | 'this month';
  };
  pricing: {
    [model: string]: ModelPricing;
  };
  alerts: {
    perSessionCostLimit: number | null;
    perDayCostLimit: number | null;
  };
}
