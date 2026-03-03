/**
 * Tests for Phase G: Session Lifecycle Management (Spec 05).
 * G1: Session status tracking (4 states, 6 transitions)
 * G2: Agent phase inference (8 phases)
 * G3: Orphan/stale detection
 * G4: Project derivation
 * G5: Subagent tracking
 * G6: Error categorization
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Storage } from '@lib/storage.js';
import {
  processEvent,
  inferPhase,
  deriveProject,
  deriveAgentName,
  categorizeError,
  detectStaleSessions,
} from '@server/session-lifecycle.js';
import type { EventRecord, SessionPhase } from '@shared/types.js';

let tmpDir: string;
let storage: Storage;

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: randomUUID(),
    sessionId: 'session-1',
    timestamp: new Date().toISOString(),
    type: 'PostToolUse',
    tool: 'Bash',
    payload: {},
    project: 'test-project',
    workspace: '/test/workspace',
    ...overrides,
  };
}

function getSessionStatus(db: import('sql.js').Database, sessionId: string): string | null {
  const result = db.exec(`SELECT status FROM sessions WHERE session_id = ?;`, [sessionId]);
  if (result.length === 0 || result[0].values.length === 0) return null;
  return result[0].values[0][0] as string;
}

function getSessionField(db: import('sql.js').Database, sessionId: string, field: string): unknown {
  const result = db.exec(`SELECT ${field} FROM sessions WHERE session_id = ?;`, [sessionId]);
  if (result.length === 0 || result[0].values.length === 0) return null;
  return result[0].values[0][0];
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-lifecycle-test-'));
  storage = new Storage(path.join(tmpDir, 'test.db'));
  await storage.init();
});

afterEach(async () => {
  await storage.shutdown();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── G1: Session Status Tracking ──────────────────────────────────────────────

describe('G1 — Session status tracking', () => {
  it('should create session with status running on first event (AC 1)', () => {
    const db = storage.getDb();
    const event = makeEvent({ sessionId: 'new-session' });
    processEvent(db, event);

    expect(getSessionStatus(db, 'new-session')).toBe('running');
  });

  it('should transition running → completed on normal Stop (AC 2)', () => {
    const db = storage.getDb();
    processEvent(db, makeEvent({ sessionId: 's-1' }));
    expect(getSessionStatus(db, 's-1')).toBe('running');

    processEvent(db, makeEvent({
      sessionId: 's-1',
      type: 'Stop',
      payload: {},
    }));
    expect(getSessionStatus(db, 's-1')).toBe('completed');
  });

  it('should transition running → errored on error Stop (AC 3)', () => {
    const db = storage.getDb();
    processEvent(db, makeEvent({ sessionId: 's-1' }));

    processEvent(db, makeEvent({
      sessionId: 's-1',
      type: 'Stop',
      payload: { error: 'something went wrong', is_error: true },
    }));
    expect(getSessionStatus(db, 's-1')).toBe('errored');
  });

  it('should mark running sessions as stale after timeout (AC 4)', () => {
    const db = storage.getDb();
    const oldTime = new Date(Date.now() - 70 * 60 * 1000).toISOString(); // 70 min ago

    processEvent(db, makeEvent({
      sessionId: 's-1',
      timestamp: oldTime,
    }));

    detectStaleSessions(db, 60);
    expect(getSessionStatus(db, 's-1')).toBe('stale');
  });

  it('should transition stale → running on new activity (AC 5)', () => {
    const db = storage.getDb();
    const oldTime = new Date(Date.now() - 70 * 60 * 1000).toISOString();

    processEvent(db, makeEvent({ sessionId: 's-1', timestamp: oldTime }));
    detectStaleSessions(db, 60);
    expect(getSessionStatus(db, 's-1')).toBe('stale');

    // New event resumes the session
    processEvent(db, makeEvent({ sessionId: 's-1' }));
    expect(getSessionStatus(db, 's-1')).toBe('running');
  });

  it('should not transition from completed (terminal) (AC 6)', () => {
    const db = storage.getDb();
    processEvent(db, makeEvent({ sessionId: 's-1' }));
    processEvent(db, makeEvent({ sessionId: 's-1', type: 'Stop' }));
    expect(getSessionStatus(db, 's-1')).toBe('completed');

    // Another event should not change status
    processEvent(db, makeEvent({ sessionId: 's-1' }));
    expect(getSessionStatus(db, 's-1')).toBe('completed');
  });

  it('should not transition from errored (terminal) (AC 6)', () => {
    const db = storage.getDb();
    processEvent(db, makeEvent({ sessionId: 's-1' }));
    processEvent(db, makeEvent({
      sessionId: 's-1',
      type: 'Stop',
      payload: { error: 'fail' },
    }));
    expect(getSessionStatus(db, 's-1')).toBe('errored');

    processEvent(db, makeEvent({ sessionId: 's-1' }));
    expect(getSessionStatus(db, 's-1')).toBe('errored');
  });

  it('should transition stale → completed on delayed normal Stop', () => {
    const db = storage.getDb();
    const oldTime = new Date(Date.now() - 70 * 60 * 1000).toISOString();

    processEvent(db, makeEvent({ sessionId: 's-1', timestamp: oldTime }));
    detectStaleSessions(db, 60);
    expect(getSessionStatus(db, 's-1')).toBe('stale');

    processEvent(db, makeEvent({ sessionId: 's-1', type: 'Stop' }));
    expect(getSessionStatus(db, 's-1')).toBe('completed');
  });

  it('should transition stale → errored on delayed error Stop', () => {
    const db = storage.getDb();
    const oldTime = new Date(Date.now() - 70 * 60 * 1000).toISOString();

    processEvent(db, makeEvent({ sessionId: 's-1', timestamp: oldTime }));
    detectStaleSessions(db, 60);
    expect(getSessionStatus(db, 's-1')).toBe('stale');

    processEvent(db, makeEvent({
      sessionId: 's-1',
      type: 'Stop',
      payload: { error: 'late error' },
    }));
    expect(getSessionStatus(db, 's-1')).toBe('errored');
  });

  it('should update last_seen on every event', () => {
    const db = storage.getDb();
    const time1 = new Date(Date.now() - 5000).toISOString();
    const time2 = new Date().toISOString();

    processEvent(db, makeEvent({ sessionId: 's-1', timestamp: time1 }));
    const lastSeen1 = getSessionField(db, 's-1', 'last_seen');

    processEvent(db, makeEvent({ sessionId: 's-1', timestamp: time2 }));
    const lastSeen2 = getSessionField(db, 's-1', 'last_seen');

    expect(lastSeen2).toBe(time2);
    expect(lastSeen1).toBe(time1);
  });
});

// ── G2: Agent Phase Inference ────────────────────────────────────────────────

describe('G2 — Agent phase inference', () => {
  it('should infer "Reading the plan" for reading plan/spec files', () => {
    expect(inferPhase(makeEvent({
      tool: 'Read',
      payload: { input: { file_path: '/project/PLAN.md' } },
    }))).toBe('Reading the plan');

    expect(inferPhase(makeEvent({
      tool: 'Read',
      payload: { input: { file_path: '/project/specs/01-spec.md' } },
    }))).toBe('Reading the plan');
  });

  it('should infer "Orienting" for reading CLAUDE.md/config', () => {
    expect(inferPhase(makeEvent({
      tool: 'Read',
      payload: { input: { file_path: '/project/CLAUDE.md' } },
    }))).toBe('Orienting');
  });

  it('should infer "Investigating code" for Glob/Grep/Read on source', () => {
    expect(inferPhase(makeEvent({ tool: 'Glob' }))).toBe('Investigating code');
    expect(inferPhase(makeEvent({ tool: 'Grep' }))).toBe('Investigating code');
    expect(inferPhase(makeEvent({
      tool: 'Read',
      payload: { input: { file_path: '/project/src/app.ts' } },
    }))).toBe('Investigating code');
  });

  it('should infer "Implementing" for Write/Edit on source files', () => {
    expect(inferPhase(makeEvent({
      tool: 'Write',
      payload: { input: { file_path: '/project/src/app.ts' } },
    }))).toBe('Implementing');

    expect(inferPhase(makeEvent({
      tool: 'Edit',
      payload: { input: { file_path: '/project/src/app.ts' } },
    }))).toBe('Implementing');
  });

  it('should infer "Validating" for Bash running tests', () => {
    expect(inferPhase(makeEvent({
      tool: 'Bash',
      payload: { input: { command: 'npm test' } },
    }))).toBe('Validating');

    expect(inferPhase(makeEvent({
      tool: 'Bash',
      payload: { input: { command: 'npx vitest run' } },
    }))).toBe('Validating');
  });

  it('should infer "Committing" for git commands', () => {
    expect(inferPhase(makeEvent({
      tool: 'Bash',
      payload: { input: { command: 'git commit -m "fix bug"' } },
    }))).toBe('Committing');

    expect(inferPhase(makeEvent({
      tool: 'Bash',
      payload: { input: { command: 'git push origin main' } },
    }))).toBe('Committing');
  });

  it('should infer "Updating the plan" for TODO/task file operations', () => {
    expect(inferPhase(makeEvent({
      tool: 'Read',
      payload: { input: { file_path: '/project/TODO.md' } },
    }))).toBe('Updating the plan');

    expect(inferPhase(makeEvent({ tool: 'TodoWrite' }))).toBe('Updating the plan');
  });

  it('should infer "Delegating" for Agent tool', () => {
    expect(inferPhase(makeEvent({ tool: 'Agent' }))).toBe('Delegating');
    expect(inferPhase(makeEvent({ type: 'SubagentStart' }))).toBe('Delegating');
  });

  it('should update phase near-real-time as events arrive (AC 9)', () => {
    const db = storage.getDb();

    // First event: investigating
    processEvent(db, makeEvent({
      sessionId: 's-1',
      tool: 'Grep',
    }));
    expect(getSessionField(db, 's-1', 'inferred_phase')).toBe('Investigating code');

    // Second event: implementing
    processEvent(db, makeEvent({
      sessionId: 's-1',
      tool: 'Edit',
      payload: { input: { file_path: '/src/app.ts' } },
    }));
    expect(getSessionField(db, 's-1', 'inferred_phase')).toBe('Implementing');
  });
});

// ── G3: Stale Detection ──────────────────────────────────────────────────────

describe('G3 — Orphan/stale detection', () => {
  it('should mark running sessions as stale after timeout (AC 4)', () => {
    const db = storage.getDb();
    const oldTime = new Date(Date.now() - 70 * 60 * 1000).toISOString();

    processEvent(db, makeEvent({ sessionId: 's-1', timestamp: oldTime }));
    detectStaleSessions(db, 60);

    expect(getSessionStatus(db, 's-1')).toBe('stale');
  });

  it('should not mark completed/errored sessions as stale', () => {
    const db = storage.getDb();
    const oldTime = new Date(Date.now() - 70 * 60 * 1000).toISOString();

    // Complete session
    processEvent(db, makeEvent({ sessionId: 's-completed', timestamp: oldTime }));
    processEvent(db, makeEvent({ sessionId: 's-completed', type: 'Stop', timestamp: oldTime }));

    // Error session
    processEvent(db, makeEvent({ sessionId: 's-errored', timestamp: oldTime }));
    processEvent(db, makeEvent({
      sessionId: 's-errored',
      type: 'Stop',
      payload: { error: 'fail' },
      timestamp: oldTime,
    }));

    detectStaleSessions(db, 60);

    expect(getSessionStatus(db, 's-completed')).toBe('completed');
    expect(getSessionStatus(db, 's-errored')).toBe('errored');
  });

  it('should use configurable stale timeout (AC 10)', () => {
    const db = storage.getDb();
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    processEvent(db, makeEvent({ sessionId: 's-1', timestamp: thirtyMinAgo }));

    // 60-minute timeout: should NOT be stale
    detectStaleSessions(db, 60);
    expect(getSessionStatus(db, 's-1')).toBe('running');

    // 20-minute timeout: should be stale
    detectStaleSessions(db, 20);
    expect(getSessionStatus(db, 's-1')).toBe('stale');
  });
});

// ── G4: Project Derivation ───────────────────────────────────────────────────

describe('G4 — Project derivation', () => {
  it('should fall back to last directory segment', () => {
    expect(deriveProject('/home/user/projects/my-app')).toBe('my-app');
    expect(deriveProject('C:\\Users\\user\\projects\\my-app')).toBe('my-app');
  });

  it('should handle empty workspace', () => {
    expect(deriveProject('')).toBe('unknown');
  });
});

// ── S14: Agent Name Derivation ────────────────────────────────────────────────

describe('S14 — Agent name derivation', () => {
  it('should derive agent name from workspace path', () => {
    expect(deriveAgentName('/home/user/projects/my-app')).toBe('my-app');
    expect(deriveAgentName('C:\\Users\\user\\projects\\my-app')).toBe('my-app');
  });

  it('should handle empty workspace', () => {
    expect(deriveAgentName('')).toBe('Agent');
  });

  it('should store agent_name when creating a session', () => {
    const db = storage.getDb();
    processEvent(db, makeEvent({
      sessionId: 's-agent-test',
      workspace: '/home/user/awesome-project',
    }));
    const agentName = getSessionField(db, 's-agent-test', 'agent_name');
    expect(agentName).toBe('awesome-project');
  });
});

// ── G5: Subagent Tracking ────────────────────────────────────────────────────

describe('G5 — Subagent tracking', () => {
  it('should increment turn count on SubagentStart', () => {
    const db = storage.getDb();
    processEvent(db, makeEvent({ sessionId: 's-1' }));
    processEvent(db, makeEvent({ sessionId: 's-1', type: 'SubagentStart' }));

    const turnCount = getSessionField(db, 's-1', 'turn_count');
    expect(turnCount).toBeGreaterThanOrEqual(1);
  });

  it('should increment subagent_count on SubagentStart (Spec 05 AC 11)', () => {
    const db = storage.getDb();
    processEvent(db, makeEvent({ sessionId: 's-1' }));
    processEvent(db, makeEvent({
      sessionId: 's-1',
      type: 'SubagentStart',
      payload: { description: 'search for files' },
    }));
    processEvent(db, makeEvent({
      sessionId: 's-1',
      type: 'SubagentStart',
      payload: { description: 'run tests' },
    }));

    const subagentCount = getSessionField(db, 's-1', 'subagent_count');
    expect(subagentCount).toBe(2);
  });

  it('should track subagent task descriptions (Spec 05 AC 12)', () => {
    const db = storage.getDb();
    processEvent(db, makeEvent({ sessionId: 's-1' }));
    processEvent(db, makeEvent({
      sessionId: 's-1',
      type: 'SubagentStart',
      payload: { description: 'explore codebase' },
    }));
    processEvent(db, makeEvent({
      sessionId: 's-1',
      type: 'SubagentStart',
      payload: { task: 'run integration tests' },
    }));

    const tasksJson = getSessionField(db, 's-1', 'subagent_tasks') as string;
    const tasks = JSON.parse(tasksJson);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toBe('explore codebase');
    expect(tasks[1]).toBe('run integration tests');
  });

  it('should use fallback task description when no description/task in payload', () => {
    const db = storage.getDb();
    processEvent(db, makeEvent({ sessionId: 's-1' }));
    processEvent(db, makeEvent({
      sessionId: 's-1',
      type: 'SubagentStart',
      payload: {},
    }));

    const tasksJson = getSessionField(db, 's-1', 'subagent_tasks') as string;
    const tasks = JSON.parse(tasksJson);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toBe('subagent task');
  });
});

// ── G6: Error Categorization ─────────────────────────────────────────────────

describe('G6 — Error categorization', () => {
  it('should categorize PostToolUseFailure as tool_failure', () => {
    const event = makeEvent({ type: 'PostToolUseFailure', payload: { error: 'command failed' } });
    expect(categorizeError(event)).toBe('tool_failure');
  });

  it('should categorize rate limit errors as rate_limit', () => {
    const event = makeEvent({ type: 'Stop', payload: { error: 'Rate limit exceeded (429)' } });
    expect(categorizeError(event)).toBe('rate_limit');
  });

  it('should categorize auth errors as auth_error', () => {
    const event = makeEvent({ type: 'Stop', payload: { error: 'Unauthorized (401)' } });
    expect(categorizeError(event)).toBe('auth_error');
  });

  it('should categorize billing errors as billing_error', () => {
    const event = makeEvent({ type: 'Stop', payload: { error: 'Billing quota exceeded' } });
    expect(categorizeError(event)).toBe('billing_error');
  });

  it('should categorize server errors as server_error', () => {
    const event = makeEvent({ type: 'Stop', payload: { error: 'Internal server error (500)' } });
    expect(categorizeError(event)).toBe('server_error');
  });

  it('should assign exactly one category to every error', () => {
    const events = [
      makeEvent({ type: 'PostToolUseFailure' }),
      makeEvent({ type: 'Stop', payload: { error: '429 rate limit' } }),
      makeEvent({ type: 'Stop', payload: { error: 'auth failed 401' } }),
      makeEvent({ type: 'Stop', payload: { error: 'billing problem' } }),
      makeEvent({ type: 'Stop', payload: { error: '500 server crash' } }),
      makeEvent({ type: 'Stop', payload: { error: 'unknown error' } }),
    ];

    for (const event of events) {
      const category = categorizeError(event);
      expect(['tool_failure', 'rate_limit', 'auth_error', 'billing_error', 'server_error']).toContain(category);
    }
  });

  it('should be fully automatic with no manual input', () => {
    // Categorization happens purely from event data
    const event = makeEvent({ type: 'PostToolUseFailure', payload: { error: 'test' } });
    const category = categorizeError(event);
    expect(category).toBe('tool_failure');
  });
});
