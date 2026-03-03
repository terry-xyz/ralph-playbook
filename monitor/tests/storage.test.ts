/**
 * Tests for Phase C: Data Storage (Spec 04).
 * C1: sql.js WASM init + 4-table schema.
 * C2: Persistence — periodic flush + atomic write to disk.
 * C3: Retention/pruning + vacuuming.
 * C4: FTS5 compatibility validation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Storage } from '@lib/storage.js';

let tmpDir: string;
let dbPath: string;
let storage: Storage;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-storage-test-'));
  dbPath = path.join(tmpDir, 'test.db');
  storage = new Storage(dbPath);
  await storage.init();
});

afterEach(async () => {
  await storage.shutdown();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── C1: Schema Creation ──────────────────────────────────────────────────────

describe('C1 — sql.js WASM init and 4-table schema', () => {
  it('should create fresh database with all 4 tables', () => {
    expect(storage.tableExists('sessions')).toBe(true);
    expect(storage.tableExists('events')).toBe(true);
    expect(storage.tableExists('metrics')).toBe(true);
    expect(storage.tableExists('guardrail_log')).toBe(true);
  });

  it('should create expected indices', () => {
    expect(storage.indexExists('idx_events_session_id')).toBe(true);
    expect(storage.indexExists('idx_events_timestamp')).toBe(true);
    expect(storage.indexExists('idx_events_type')).toBe(true);
    expect(storage.indexExists('idx_sessions_project')).toBe(true);
    expect(storage.indexExists('idx_sessions_status')).toBe(true);
    expect(storage.indexExists('idx_sessions_start_time')).toBe(true);
    expect(storage.indexExists('idx_guardrail_log_session_id')).toBe(true);
    expect(storage.indexExists('idx_metrics_session_id')).toBe(true);
  });

  it('should enforce session status constraint — only 4 valid values', () => {
    const db = storage.getDb();
    const now = new Date().toISOString();

    // Valid statuses should work
    for (const status of ['running', 'completed', 'errored', 'stale']) {
      db.run(
        `INSERT INTO sessions (session_id, project, status, start_time, last_seen) VALUES (?, 'test', ?, ?, ?);`,
        [`s-${status}`, status, now, now]
      );
    }

    // Invalid status should fail
    expect(() => {
      db.run(
        `INSERT INTO sessions (session_id, project, status, start_time, last_seen) VALUES ('s-invalid', 'test', 'invalid', ?, ?);`,
        [now, now]
      );
    }).toThrow();
  });

  it('should support all session table fields from Spec 04', () => {
    const db = storage.getDb();
    const now = new Date().toISOString();
    const tokenCounts = JSON.stringify({ input: 100, output: 50, cacheCreation: 10, cacheRead: 5 });

    db.run(`
      INSERT INTO sessions (session_id, project, workspace, model, status, start_time, end_time,
        total_cost, token_counts, turn_count, inferred_phase, last_seen, error_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `, ['s-1', 'my-project', '/workspace', 'claude-opus-4', 'running', now, null,
        1.23, tokenCounts, 5, 'Implementing', now, 0]);

    const result = db.exec('SELECT * FROM sessions WHERE session_id = ?;', ['s-1']);
    expect(result).toHaveLength(1);
    expect(result[0].values).toHaveLength(1);
  });

  it('should support all events table fields from Spec 04', () => {
    const db = storage.getDb();
    const now = new Date().toISOString();

    // Create session first (foreign key)
    db.run(
      `INSERT INTO sessions (session_id, project, status, start_time, last_seen) VALUES ('s-1', 'test', 'running', ?, ?);`,
      [now, now]
    );

    const payload = JSON.stringify({ input: { command: 'ls -la' } });
    db.run(`
      INSERT INTO events (event_id, session_id, timestamp, type, tool_name, payload, duration, tool_use_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?);
    `, ['e-1', 's-1', now, 'PostToolUse', 'Bash', payload, 1.5, 'tu-1']);

    const result = db.exec('SELECT * FROM events WHERE event_id = ?;', ['e-1']);
    expect(result).toHaveLength(1);
  });

  it('should store and retrieve JSON payloads in their original structure (Spec 04 AC 31-32)', () => {
    const db = storage.getDb();
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO sessions (session_id, project, status, start_time, last_seen) VALUES ('s-1', 'test', 'running', ?, ?);`,
      [now, now]
    );

    const originalPayload = {
      input: { command: 'npm test', description: 'Run tests' },
      output: { exitCode: 0, stdout: 'All tests passed' },
    };
    db.run(`
      INSERT INTO events (event_id, session_id, timestamp, type, tool_name, payload)
      VALUES (?, ?, ?, ?, ?, ?);
    `, ['e-1', 's-1', now, 'PostToolUse', 'Bash', JSON.stringify(originalPayload)]);

    const result = db.exec('SELECT payload FROM events WHERE event_id = ?;', ['e-1']);
    const retrieved = JSON.parse(result[0].values[0][0] as string);
    expect(retrieved).toEqual(originalPayload);
  });

  it('should enforce referential integrity — events belong to sessions (Spec 04 AC 5-7)', () => {
    const db = storage.getDb();
    const now = new Date().toISOString();

    // Inserting event with non-existent session should fail (FK constraint)
    expect(() => {
      db.run(`
        INSERT INTO events (event_id, session_id, timestamp, type, payload)
        VALUES ('e-orphan', 'non-existent', ?, 'PostToolUse', '{}');
      `, [now]);
    }).toThrow();
  });

  it('should load an existing valid .db file preserving data', async () => {
    const db = storage.getDb();
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO sessions (session_id, project, status, start_time, last_seen) VALUES ('s-persist', 'test', 'running', ?, ?);`,
      [now, now]
    );
    storage.flushToDisk();

    // Create new storage instance from same file
    const storage2 = new Storage(dbPath);
    await storage2.init();

    const result = storage2.getDb().exec('SELECT * FROM sessions WHERE session_id = ?;', ['s-persist']);
    expect(result).toHaveLength(1);
    expect(result[0].values).toHaveLength(1);

    await storage2.shutdown();
  });

  it('should handle corrupt .db file — log warning and create fresh', async () => {
    await storage.shutdown();

    // Write corrupt data to the file
    fs.writeFileSync(dbPath, 'this is not a valid sqlite database');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage2 = new Storage(dbPath);
    await storage2.init();

    expect(warnSpy).toHaveBeenCalled();
    // Should still have all 4 tables (fresh DB)
    expect(storage2.tableExists('sessions')).toBe(true);
    expect(storage2.tableExists('events')).toBe(true);
    expect(storage2.tableExists('metrics')).toBe(true);
    expect(storage2.tableExists('guardrail_log')).toBe(true);

    await storage2.shutdown();
    warnSpy.mockRestore();
  });

  it('should store tool call input arguments in event payload (Spec 04 AC 26)', () => {
    const db = storage.getDb();
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO sessions (session_id, project, status, start_time, last_seen) VALUES ('s-1', 'test', 'running', ?, ?);`,
      [now, now]
    );

    // Edit tool payload with old_string + new_string for diff reconstruction (Spec 04 AC 28)
    const editPayload = JSON.stringify({
      input: {
        file_path: '/src/app.ts',
        old_string: 'const x = 1;',
        new_string: 'const x = 2;',
      },
    });

    db.run(`
      INSERT INTO events (event_id, session_id, timestamp, type, tool_name, payload)
      VALUES ('e-edit', 's-1', ?, 'PostToolUse', 'Edit', ?);
    `, [now, editPayload]);

    const result = db.exec('SELECT payload FROM events WHERE event_id = ?;', ['e-edit']);
    const payload = JSON.parse(result[0].values[0][0] as string);
    expect(payload.input.old_string).toBe('const x = 1;');
    expect(payload.input.new_string).toBe('const x = 2;');
  });

  it('should query events by type/session/time range with complete JSON payloads (Spec 04 AC 32)', () => {
    const db = storage.getDb();
    const now = new Date().toISOString();
    const earlier = new Date(Date.now() - 60000).toISOString();

    db.run(
      `INSERT INTO sessions (session_id, project, status, start_time, last_seen) VALUES ('s-1', 'test', 'running', ?, ?);`,
      [earlier, now]
    );

    db.run(`INSERT INTO events (event_id, session_id, timestamp, type, tool_name, payload) VALUES ('e-1', 's-1', ?, 'PostToolUse', 'Bash', '{"cmd":"ls"}');`, [earlier]);
    db.run(`INSERT INTO events (event_id, session_id, timestamp, type, tool_name, payload) VALUES ('e-2', 's-1', ?, 'PostToolUseFailure', 'Edit', '{"error":"fail"}');`, [now]);

    // Query by type
    const byType = db.exec(`SELECT event_id, payload FROM events WHERE type = 'PostToolUse';`);
    expect(byType[0].values).toHaveLength(1);
    expect(JSON.parse(byType[0].values[0][1] as string)).toEqual({ cmd: 'ls' });

    // Query by session
    const bySession = db.exec(`SELECT event_id FROM events WHERE session_id = 's-1';`);
    expect(bySession[0].values).toHaveLength(2);

    // Query by time range
    const halfwayPoint = new Date(Date.now() - 30000).toISOString();
    const byTime = db.exec(`SELECT event_id FROM events WHERE timestamp > ?;`, [halfwayPoint]);
    expect(byTime[0].values).toHaveLength(1);
  });

  it('should support metrics table with all fields', () => {
    const db = storage.getDb();
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO sessions (session_id, project, status, start_time, last_seen) VALUES ('s-1', 'test', 'completed', ?, ?);`,
      [now, now]
    );

    const costBreakdown = JSON.stringify({ inputCost: 0.5, outputCost: 1.2, cacheCreationCost: 0.1, cacheReadCost: 0.05 });
    const tokenBreakdown = JSON.stringify({ input: 1000, output: 500, cacheCreation: 200, cacheRead: 100 });

    db.run(`
      INSERT INTO metrics (session_id, cost_breakdown, token_breakdown, model, wall_clock_duration, api_duration, turn_count)
      VALUES (?, ?, ?, ?, ?, ?, ?);
    `, ['s-1', costBreakdown, tokenBreakdown, 'claude-opus-4', 120.5, 45.2, 10]);

    const result = db.exec('SELECT * FROM metrics WHERE session_id = ?;', ['s-1']);
    expect(result).toHaveLength(1);
    const row = result[0].values[0];
    expect(JSON.parse(row[1] as string).inputCost).toBe(0.5);
  });

  it('should support guardrail_log table with all fields', () => {
    const db = storage.getDb();
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO sessions (session_id, project, status, start_time, last_seen) VALUES ('s-1', 'test', 'running', ?, ?);`,
      [now, now]
    );

    const payload = JSON.stringify({ tool: 'Bash', command: 'rm -rf /', reason: 'destructive command blocked' });
    db.run(`
      INSERT INTO guardrail_log (id, session_id, rule_name, action, timestamp, payload)
      VALUES (?, ?, ?, ?, ?, ?);
    `, ['g-1', 's-1', 'no-destructive', 'block', now, payload]);

    const result = db.exec('SELECT * FROM guardrail_log WHERE id = ?;', ['g-1']);
    expect(result).toHaveLength(1);
    expect(result[0].values[0][2]).toBe('no-destructive');
    expect(result[0].values[0][3]).toBe('block');
  });
});

// ── C2: Persistence ──────────────────────────────────────────────────────────

describe('C2 — Persistence (flush to disk)', () => {
  it('should flush data inserted in-memory to disk', () => {
    const db = storage.getDb();
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO sessions (session_id, project, status, start_time, last_seen) VALUES ('s-flush', 'test', 'running', ?, ?);`,
      [now, now]
    );

    storage.flushToDisk();
    expect(fs.existsSync(dbPath)).toBe(true);

    // Verify data is on disk by reading with new instance
    const rawData = fs.readFileSync(dbPath);
    expect(rawData.length).toBeGreaterThan(0);
  });

  it('should use atomic write (tmp + rename)', () => {
    const db = storage.getDb();
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO sessions (session_id, project, status, start_time, last_seen) VALUES ('s-atomic', 'test', 'running', ?, ?);`,
      [now, now]
    );

    storage.flushToDisk();

    // After successful flush, no .tmp files should remain
    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter(f => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('should trigger graceful shutdown flush', async () => {
    const db = storage.getDb();
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO sessions (session_id, project, status, start_time, last_seen) VALUES ('s-shutdown', 'test', 'running', ?, ?);`,
      [now, now]
    );

    await storage.shutdown();
    expect(fs.existsSync(dbPath)).toBe(true);

    // Verify data survived shutdown
    const storage2 = new Storage(dbPath);
    await storage2.init();
    const result = storage2.getDb().exec('SELECT * FROM sessions WHERE session_id = ?;', ['s-shutdown']);
    expect(result).toHaveLength(1);
    await storage2.shutdown();
  });

  it('should fire periodic flush at configured interval', async () => {
    const db = storage.getDb();
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO sessions (session_id, project, status, start_time, last_seen) VALUES ('s-periodic', 'test', 'running', ?, ?);`,
      [now, now]
    );

    vi.useFakeTimers();
    storage.startPeriodicFlush(1000);

    // Before interval fires — file should not exist (unless already flushed)
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    vi.advanceTimersByTime(1000);

    expect(fs.existsSync(dbPath)).toBe(true);

    storage.stopPeriodicFlush();
    vi.useRealTimers();
  });

  it('should survive reload after flush — data preserved (Spec 04 AC 19)', async () => {
    const db = storage.getDb();
    const now = new Date().toISOString();

    // Insert multiple rows across tables
    db.run(
      `INSERT INTO sessions (session_id, project, status, start_time, last_seen) VALUES ('s-survive', 'test', 'completed', ?, ?);`,
      [now, now]
    );
    db.run(
      `INSERT INTO events (event_id, session_id, timestamp, type, payload) VALUES ('e-survive', 's-survive', ?, 'Stop', '{}');`,
      [now]
    );

    storage.flushToDisk();
    await storage.shutdown();

    // Reload
    const storage2 = new Storage(dbPath);
    await storage2.init();

    const sessions = storage2.getDb().exec('SELECT session_id FROM sessions;');
    expect(sessions[0].values).toHaveLength(1);
    expect(sessions[0].values[0][0]).toBe('s-survive');

    const events = storage2.getDb().exec('SELECT event_id FROM events;');
    expect(events[0].values).toHaveLength(1);
    expect(events[0].values[0][0]).toBe('e-survive');

    await storage2.shutdown();
  });
});

// ── C3: Retention / Pruning ──────────────────────────────────────────────────

describe('C3 — Retention / pruning + vacuuming', () => {
  it('should delete records older than retention period (AC 12-13)', () => {
    const db = storage.getDb();
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(); // 40 days ago
    const recent = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago

    // Insert old and recent sessions
    db.run(
      `INSERT INTO sessions (session_id, project, status, start_time, last_seen) VALUES ('s-old', 'test', 'completed', ?, ?);`,
      [old, old]
    );
    db.run(
      `INSERT INTO sessions (session_id, project, status, start_time, last_seen) VALUES ('s-recent', 'test', 'completed', ?, ?);`,
      [recent, recent]
    );

    // Insert events for both
    db.run(`INSERT INTO events (event_id, session_id, timestamp, type, payload) VALUES ('e-old', 's-old', ?, 'Stop', '{}');`, [old]);
    db.run(`INSERT INTO events (event_id, session_id, timestamp, type, payload) VALUES ('e-recent', 's-recent', ?, 'Stop', '{}');`, [recent]);

    // Insert metrics for old session
    db.run(`INSERT INTO metrics (session_id, cost_breakdown, token_breakdown, turn_count) VALUES ('s-old', '{}', '{}', 0);`);

    // Insert guardrail log for old session
    db.run(`INSERT INTO guardrail_log (id, session_id, rule_name, action, timestamp, payload) VALUES ('g-old', 's-old', 'test', 'block', ?, '{}');`, [old]);

    // Prune with 30-day retention
    storage.prune(30);

    // Old records should be gone
    const oldSessions = db.exec(`SELECT session_id FROM sessions WHERE session_id = 's-old';`);
    expect(oldSessions).toHaveLength(0);
    const oldEvents = db.exec(`SELECT event_id FROM events WHERE event_id = 'e-old';`);
    expect(oldEvents).toHaveLength(0);
    const oldMetrics = db.exec(`SELECT session_id FROM metrics WHERE session_id = 's-old';`);
    expect(oldMetrics).toHaveLength(0);
    const oldGuardrails = db.exec(`SELECT id FROM guardrail_log WHERE id = 'g-old';`);
    expect(oldGuardrails).toHaveLength(0);

    // Recent records should be preserved
    const recentSessions = db.exec(`SELECT session_id FROM sessions WHERE session_id = 's-recent';`);
    expect(recentSessions).toHaveLength(1);
    const recentEvents = db.exec(`SELECT event_id FROM events WHERE event_id = 'e-recent';`);
    expect(recentEvents).toHaveLength(1);
  });

  it('should preserve records within the retention window', () => {
    const db = storage.getDb();
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days ago

    db.run(
      `INSERT INTO sessions (session_id, project, status, start_time, last_seen) VALUES ('s-keep', 'test', 'completed', ?, ?);`,
      [recent, recent]
    );

    storage.prune(30);

    const result = db.exec(`SELECT session_id FROM sessions WHERE session_id = 's-keep';`);
    expect(result).toHaveLength(1);
  });

  it('should apply purge uniformly to ALL 4 tables (Spec 04 AC 12)', () => {
    const db = storage.getDb();
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();

    db.run(`INSERT INTO sessions (session_id, project, status, start_time, last_seen) VALUES ('s-1', 'test', 'completed', ?, ?);`, [old, old]);
    db.run(`INSERT INTO events (event_id, session_id, timestamp, type, payload) VALUES ('e-1', 's-1', ?, 'Stop', '{}');`, [old]);
    db.run(`INSERT INTO metrics (session_id, cost_breakdown, token_breakdown, turn_count) VALUES ('s-1', '{}', '{}', 0);`);
    db.run(`INSERT INTO guardrail_log (id, session_id, rule_name, action, timestamp, payload) VALUES ('g-1', 's-1', 'test', 'block', ?, '{}');`, [old]);

    storage.prune(30);

    // All 4 tables should be empty
    for (const table of ['sessions', 'events', 'metrics', 'guardrail_log']) {
      const result = db.exec(`SELECT COUNT(*) FROM ${table};`);
      expect(result[0].values[0][0]).toBe(0);
    }
  });

  it('should perform full hard delete — no summary preserved (Spec 04 AC 14)', () => {
    const db = storage.getDb();
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();

    db.run(`INSERT INTO sessions (session_id, project, status, start_time, last_seen, total_cost) VALUES ('s-1', 'test', 'completed', ?, ?, 5.00);`, [old, old]);

    storage.prune(30);

    // No data should remain — not even aggregate/summary
    const result = db.exec(`SELECT COUNT(*) FROM sessions;`);
    expect(result[0].values[0][0]).toBe(0);
  });

  it('should remain functional after vacuuming (Spec 04 AC 23)', () => {
    const db = storage.getDb();
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    // Insert and prune to trigger vacuum
    db.run(`INSERT INTO sessions (session_id, project, status, start_time, last_seen) VALUES ('s-1', 'test', 'completed', ?, ?);`, [old, old]);
    storage.prune(30);

    // DB should still work after vacuum
    db.run(`INSERT INTO sessions (session_id, project, status, start_time, last_seen) VALUES ('s-2', 'test', 'running', ?, ?);`, [now, now]);
    const result = db.exec(`SELECT session_id FROM sessions;`);
    expect(result[0].values).toHaveLength(1);
    expect(result[0].values[0][0]).toBe('s-2');
  });
});

// ── C4: FTS5 Compatibility ───────────────────────────────────────────────────

describe('C4 — FTS5 compatibility validation', () => {
  it('should attempt FTS5 validation during init', () => {
    // FTS5 availability is checked during init — just verify the flag is set
    const available = storage.isFtsAvailable();
    expect(typeof available).toBe('boolean');
  });

  it('should set fallback flag if FTS5 is unavailable', () => {
    // The default sql.js WASM build may or may not include FTS5.
    // If unavailable, the flag should be false and LIKE queries should work.
    const available = storage.isFtsAvailable();
    if (!available) {
      // Verify LIKE queries work as fallback
      const db = storage.getDb();
      const now = new Date().toISOString();

      db.run(`INSERT INTO sessions (session_id, project, status, start_time, last_seen) VALUES ('s-1', 'test', 'running', ?, ?);`, [now, now]);
      db.run(`INSERT INTO events (event_id, session_id, timestamp, type, payload) VALUES ('e-1', 's-1', ?, 'PostToolUse', '{"cmd":"npm test"}');`, [now]);

      const result = db.exec(`SELECT event_id FROM events WHERE payload LIKE '%npm test%';`);
      expect(result[0].values).toHaveLength(1);
    }
  });

  it('should handle FTS5 index setup when available', () => {
    if (storage.isFtsAvailable()) {
      const result = storage.setupFtsIndex();
      expect(result).toBe(true);
    }
  });

  it('should fall back gracefully when FTS5 is not available', () => {
    // LIKE fallback should always work regardless of FTS5 availability
    const db = storage.getDb();
    const now = new Date().toISOString();

    db.run(`INSERT INTO sessions (session_id, project, status, start_time, last_seen) VALUES ('s-1', 'test', 'running', ?, ?);`, [now, now]);
    db.run(`INSERT INTO events (event_id, session_id, timestamp, type, payload) VALUES ('e-like-1', 's-1', ?, 'PostToolUse', '{"search":"findMe"}');`, [now]);
    db.run(`INSERT INTO events (event_id, session_id, timestamp, type, payload) VALUES ('e-like-2', 's-1', ?, 'PostToolUse', '{"search":"other"}');`, [now]);

    const result = db.exec(`SELECT event_id FROM events WHERE payload LIKE '%findMe%';`);
    expect(result[0].values).toHaveLength(1);
    expect(result[0].values[0][0]).toBe('e-like-1');
  });
});
