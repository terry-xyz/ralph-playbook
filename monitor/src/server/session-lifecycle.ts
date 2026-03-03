/**
 * Session Lifecycle Management (Spec 05).
 * Tracks sessions through 4 states, infers agent phases, detects stale sessions,
 * derives project names, tracks subagents, and categorizes errors.
 *
 * State machine:
 *   running → completed (normal Stop)
 *   running → errored   (error Stop)
 *   running → stale     (no events for 60+ min)
 *   stale   → running   (activity resumes)
 *   stale   → completed (delayed Stop)
 *   stale   → errored   (delayed error Stop)
 *   completed, errored are TERMINAL
 */

import type { Database } from 'sql.js';
import type {
  EventRecord,
  SessionStatus,
  SessionPhase,
  ErrorCategory,
} from '@shared/types.js';

// ── Phase Inference (G2) ─────────────────────────────────────────────────────

/** Infer the current agent phase from a tool call event. */
export function inferPhase(event: EventRecord): SessionPhase | null {
  const tool = event.tool;
  const payload = event.payload;

  if (!tool) return null;

  // Delegating — Agent tool spawning subagents
  if (tool === 'Agent' || event.type === 'SubagentStart') {
    return 'Delegating';
  }

  // Reading plan/spec files
  if (tool === 'Read') {
    const filePath = (payload.input as Record<string, unknown>)?.file_path as string ?? '';
    const lower = filePath.toLowerCase();
    if (lower.includes('plan') || lower.includes('spec') || lower.includes('task')) {
      return 'Reading the plan';
    }
    if (lower.includes('claude.md') || lower.includes('.claude/') || lower.includes('config')) {
      return 'Orienting';
    }
    if (lower.includes('todo') || lower.includes('task-list')) {
      return 'Updating the plan';
    }
    return 'Investigating code';
  }

  // Investigating code — search tools
  if (tool === 'Glob' || tool === 'Grep') {
    return 'Investigating code';
  }

  // Implementing — write/edit tools on source files
  if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
    const filePath = (payload.input as Record<string, unknown>)?.file_path as string ?? '';
    const lower = filePath.toLowerCase();
    if (lower.includes('todo') || lower.includes('plan') || lower.includes('task')) {
      return 'Updating the plan';
    }
    return 'Implementing';
  }

  // Bash — could be validating or committing
  if (tool === 'Bash') {
    const command = (payload.input as Record<string, unknown>)?.command as string ?? '';
    const lower = command.toLowerCase();
    if (lower.includes('git add') || lower.includes('git commit') || lower.includes('git push')) {
      return 'Committing';
    }
    if (lower.includes('test') || lower.includes('lint') || lower.includes('check') || lower.includes('vitest') || lower.includes('jest') || lower.includes('npm run')) {
      return 'Validating';
    }
    return 'Implementing';
  }

  // TodoWrite
  if (tool === 'TodoWrite') {
    return 'Updating the plan';
  }

  return null;
}

// ── Project Derivation (G4) ──────────────────────────────────────────────────

/** Derive project name from workspace path. Uses git remote URL if available. */
export function deriveProject(workspace: string): string {
  // The hook handler already derives project from git remote.
  // Here we just provide a fallback for direct invocation.
  if (!workspace) return 'unknown';

  const parts = workspace.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || 'unknown';
}

/** Derive a human-readable agent name from workspace path. */
export function deriveAgentName(workspace: string): string {
  if (!workspace) return 'Agent';
  const parts = workspace.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || 'Agent';
}

// ── Error Categorization (G6) ────────────────────────────────────────────────

/** Categorize an error event into one of 5 categories. */
export function categorizeError(event: EventRecord): ErrorCategory {
  // PostToolUseFailure → always tool_failure
  if (event.type === 'PostToolUseFailure') {
    return 'tool_failure';
  }

  const errorStr = JSON.stringify(event.payload).toLowerCase();

  // Rate limit detection
  if (errorStr.includes('rate limit') || errorStr.includes('429') || errorStr.includes('too many requests')) {
    return 'rate_limit';
  }

  // Auth error detection
  if (errorStr.includes('auth') || errorStr.includes('401') || errorStr.includes('unauthorized') || errorStr.includes('forbidden') || errorStr.includes('403')) {
    return 'auth_error';
  }

  // Billing error detection
  if (errorStr.includes('billing') || errorStr.includes('payment') || errorStr.includes('quota') || errorStr.includes('credit')) {
    return 'billing_error';
  }

  // Server error detection
  if (errorStr.includes('500') || errorStr.includes('502') || errorStr.includes('503') || errorStr.includes('internal server error') || errorStr.includes('service unavailable')) {
    return 'server_error';
  }

  // Default: tool failure for Stop errors, server error otherwise
  if (event.type === 'Stop') {
    return 'server_error';
  }

  return 'tool_failure';
}

// ── Session State Transitions (G1) ───────────────────────────────────────────

/**
 * Process an event and update the session in the database.
 * Handles auto-creation, status transitions, phase inference, and subagent tracking.
 */
export function processEvent(db: Database, event: EventRecord): void {
  const now = event.timestamp;

  // Check if session exists
  const existing = db.exec(
    'SELECT session_id, status FROM sessions WHERE session_id = ?;',
    [event.sessionId]
  );

  if (existing.length === 0 || existing[0].values.length === 0) {
    // Auto-create session on first event (Spec 05 AC 1)
    const agentName = deriveAgentName(event.workspace);
    const initialModels = event.payload.model ? [event.payload.model as string] : [];
    db.run(`
      INSERT INTO sessions (session_id, project, workspace, status, start_time, last_seen, model, agent_name)
      VALUES (?, ?, ?, 'running', ?, ?, ?, ?);
    `, [
      event.sessionId,
      event.project,
      event.workspace,
      now,
      now,
      JSON.stringify(initialModels),
      agentName,
    ]);
  } else {
    const currentStatus = existing[0].values[0][1] as SessionStatus;

    // Terminal states cannot transition (Spec 05 AC 6)
    if (currentStatus === 'completed' || currentStatus === 'errored') {
      return;
    }

    // Stale → running on new activity (Spec 05 AC 5)
    if (currentStatus === 'stale') {
      if (event.type === 'Stop') {
        // Stale → completed or errored based on stop type
        const hasError = event.payload.error || event.payload.is_error;
        const newStatus: SessionStatus = hasError ? 'errored' : 'completed';
        db.run(
          'UPDATE sessions SET status = ?, end_time = ?, last_seen = ? WHERE session_id = ?;',
          [newStatus, now, now, event.sessionId]
        );
        return;
      }
      // Resume from stale
      db.run(
        'UPDATE sessions SET status = ?, last_seen = ? WHERE session_id = ?;',
        ['running', now, event.sessionId]
      );
    }

    // Update last_seen
    db.run(
      'UPDATE sessions SET last_seen = ? WHERE session_id = ?;',
      [now, event.sessionId]
    );
  }

  // Handle Stop event → completed or errored
  if (event.type === 'Stop' || event.type === 'SessionEnd') {
    const hasError = event.payload.error || event.payload.is_error;
    const newStatus: SessionStatus = hasError ? 'errored' : 'completed';
    db.run(
      'UPDATE sessions SET status = ?, end_time = ? WHERE session_id = ?;',
      [newStatus, now, event.sessionId]
    );
  }

  // Accumulate models: add new model to JSON array if not already present (Spec 03 AC 2)
  if (event.payload.model) {
    const newModel = event.payload.model as string;
    const modelsResult = db.exec(
      'SELECT model FROM sessions WHERE session_id = ?;',
      [event.sessionId]
    );
    let models: string[] = [];
    if (modelsResult.length > 0 && modelsResult[0].values.length > 0) {
      try { models = JSON.parse(modelsResult[0].values[0][0] as string || '[]'); } catch { /* use empty */ }
    }
    if (!models.includes(newModel)) {
      models.push(newModel);
      db.run(
        'UPDATE sessions SET model = ? WHERE session_id = ?;',
        [JSON.stringify(models), event.sessionId]
      );
    }
  }

  // Infer phase (G2) — update for tool events only
  const phase = inferPhase(event);
  if (phase) {
    db.run(
      'UPDATE sessions SET inferred_phase = ? WHERE session_id = ?;',
      [phase, event.sessionId]
    );
  }

  // Track subagents (G5) — increment spawn count and capture task description
  if (event.type === 'SubagentStart') {
    db.run(
      'UPDATE sessions SET turn_count = turn_count + 1, subagent_count = subagent_count + 1 WHERE session_id = ?;',
      [event.sessionId]
    );
    // Append task description to subagent_tasks JSON array
    const taskDesc = (event.payload.description as string)
      ?? (event.payload.task as string)
      ?? (event.payload.message as string)
      ?? 'subagent task';
    const existing = db.exec(
      'SELECT subagent_tasks FROM sessions WHERE session_id = ?;',
      [event.sessionId]
    );
    let tasks: string[] = [];
    if (existing.length > 0 && existing[0].values.length > 0) {
      try { tasks = JSON.parse(existing[0].values[0][0] as string || '[]'); } catch { /* use empty */ }
    }
    tasks.push(taskDesc);
    db.run(
      'UPDATE sessions SET subagent_tasks = ? WHERE session_id = ?;',
      [JSON.stringify(tasks), event.sessionId]
    );
  }

  // Error counting
  if (event.type === 'PostToolUseFailure') {
    db.run(
      'UPDATE sessions SET error_count = error_count + 1 WHERE session_id = ?;',
      [event.sessionId]
    );
  }

  // Count turns for user prompts
  if (event.type === 'UserPromptSubmit') {
    db.run(
      'UPDATE sessions SET turn_count = turn_count + 1 WHERE session_id = ?;',
      [event.sessionId]
    );
  }
}

// ── Stale Detection (G3) ─────────────────────────────────────────────────────

/**
 * Mark running sessions as stale if no events received within the timeout period.
 * @param db Database instance
 * @param staleTimeoutMinutes Minutes of inactivity before marking stale (default 60)
 */
export function detectStaleSessions(db: Database, staleTimeoutMinutes: number): void {
  const cutoff = new Date(Date.now() - staleTimeoutMinutes * 60 * 1000).toISOString();
  db.run(
    `UPDATE sessions SET status = 'stale' WHERE status = 'running' AND last_seen < ?;`,
    [cutoff]
  );
}
