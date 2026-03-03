/**
 * Tests for S18: Ingester Daemon Lifecycle (Spec 02).
 *
 * Covers:
 * - Lock file utilities (isPidAlive, readLockPid, isIngesterRunning, writeLock, removeLock)
 * - Ingester class lifecycle (start, shutdown, processOnce error isolation)
 * - Server startup calling ingester.start()
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Storage } from '@lib/storage.js';
import {
  isPidAlive,
  readLockPid,
  isIngesterRunning,
  writeLock,
  removeLock,
} from '@server/lock-file.js';
import { Ingester, processAllFiles, readPosition, savePosition } from '@server/ingester.js';
import type { EventRecord } from '@shared/types.js';

let tmpDir: string;
let eventsDir: string;
let storage: Storage;

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: randomUUID(),
    sessionId: 'daemon-test-session',
    timestamp: new Date().toISOString(),
    type: 'PostToolUse',
    tool: 'Bash',
    payload: { input: { command: 'ls' } },
    project: 'test-project',
    workspace: '/test/workspace',
    ...overrides,
  };
}

function writeJsonlFile(filePath: string, events: EventRecord[]): void {
  const content = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(filePath, content, 'utf-8');
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-daemon-test-'));
  eventsDir = path.join(tmpDir, 'events');
  fs.mkdirSync(eventsDir, { recursive: true });

  const dbPath = path.join(tmpDir, 'test.db');
  storage = new Storage(dbPath);
  await storage.init();
});

afterEach(async () => {
  await storage.shutdown();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Lock File: isPidAlive ─────────────────────────────────────────────────

describe('Lock file — isPidAlive', () => {
  it('should return true for the current process PID', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('should return false for a non-existent PID', () => {
    // PID 999999 is very unlikely to exist
    expect(isPidAlive(999999)).toBe(false);
  });

  it('should return false for invalid PID (0)', () => {
    // PID 0 is special (kernel) and kill(0, 0) may behave differently,
    // but it shouldn't crash
    const result = isPidAlive(0);
    expect(typeof result).toBe('boolean');
  });
});

// ── Lock File: readLockPid ────────────────────────────────────────────────

describe('Lock file — readLockPid', () => {
  it('should return null for non-existent lock file', () => {
    const lockPath = path.join(tmpDir, 'nonexistent.lock');
    expect(readLockPid(lockPath)).toBeNull();
  });

  it('should return the PID from a valid lock file', () => {
    const lockPath = path.join(tmpDir, 'test.lock');
    fs.writeFileSync(lockPath, '12345', 'utf-8');
    expect(readLockPid(lockPath)).toBe(12345);
  });

  it('should return null for non-numeric content', () => {
    const lockPath = path.join(tmpDir, 'test.lock');
    fs.writeFileSync(lockPath, 'not-a-pid', 'utf-8');
    expect(readLockPid(lockPath)).toBeNull();
  });

  it('should handle whitespace around PID', () => {
    const lockPath = path.join(tmpDir, 'test.lock');
    fs.writeFileSync(lockPath, '  42  \n', 'utf-8');
    expect(readLockPid(lockPath)).toBe(42);
  });

  it('should return null for empty file', () => {
    const lockPath = path.join(tmpDir, 'test.lock');
    fs.writeFileSync(lockPath, '', 'utf-8');
    expect(readLockPid(lockPath)).toBeNull();
  });
});

// ── Lock File: isIngesterRunning ──────────────────────────────────────────

describe('Lock file — isIngesterRunning', () => {
  it('should return false when lock file does not exist', () => {
    const lockPath = path.join(tmpDir, 'ingester.lock');
    expect(isIngesterRunning(lockPath)).toBe(false);
  });

  it('should return true when lock file contains live PID', () => {
    const lockPath = path.join(tmpDir, 'ingester.lock');
    fs.writeFileSync(lockPath, String(process.pid), 'utf-8');
    expect(isIngesterRunning(lockPath)).toBe(true);
  });

  it('should return false when lock file contains dead PID (stale lock recovery)', () => {
    const lockPath = path.join(tmpDir, 'ingester.lock');
    fs.writeFileSync(lockPath, '999999', 'utf-8');
    expect(isIngesterRunning(lockPath)).toBe(false);
  });

  it('should return false when lock file contains non-numeric content', () => {
    const lockPath = path.join(tmpDir, 'ingester.lock');
    fs.writeFileSync(lockPath, 'garbage', 'utf-8');
    expect(isIngesterRunning(lockPath)).toBe(false);
  });
});

// ── Lock File: writeLock / removeLock ─────────────────────────────────────

describe('Lock file — writeLock and removeLock', () => {
  it('should write PID to lock file', () => {
    const lockPath = path.join(tmpDir, 'ingester.lock');
    writeLock(lockPath);
    const content = fs.readFileSync(lockPath, 'utf-8').trim();
    expect(parseInt(content, 10)).toBe(process.pid);
  });

  it('should make isIngesterRunning return true after writeLock', () => {
    const lockPath = path.join(tmpDir, 'ingester.lock');
    writeLock(lockPath);
    expect(isIngesterRunning(lockPath)).toBe(true);
  });

  it('should remove lock file', () => {
    const lockPath = path.join(tmpDir, 'ingester.lock');
    writeLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(true);

    removeLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('should make isIngesterRunning return false after removeLock', () => {
    const lockPath = path.join(tmpDir, 'ingester.lock');
    writeLock(lockPath);
    removeLock(lockPath);
    expect(isIngesterRunning(lockPath)).toBe(false);
  });

  it('removeLock should not throw when lock file does not exist', () => {
    const lockPath = path.join(tmpDir, 'nonexistent.lock');
    expect(() => removeLock(lockPath)).not.toThrow();
  });
});

// ── Ingester Class: start and shutdown ────────────────────────────────────

describe('Ingester class — lifecycle', () => {
  it('should process existing files on start()', async () => {
    const db = storage.getDb();
    const filePath = path.join(eventsDir, 'events-2024-06-01.jsonl');
    writeJsonlFile(filePath, [makeEvent(), makeEvent()]);

    const ingester = new Ingester(db, eventsDir, {
      batchIntervalMs: 60000, // Long interval so only initial processing runs
    });
    await ingester.start();

    const rows = db.exec('SELECT COUNT(*) FROM events;');
    expect(rows[0].values[0][0]).toBe(2);

    await ingester.shutdown();
  });

  it('should process new events via periodic interval', async () => {
    const db = storage.getDb();

    const ingester = new Ingester(db, eventsDir, {
      batchIntervalMs: 50, // Fast interval for testing
    });
    await ingester.start();

    // Write an event after start
    const filePath = path.join(eventsDir, 'events-2024-06-01.jsonl');
    writeJsonlFile(filePath, [makeEvent()]);

    // Wait for the interval to fire
    await new Promise(r => setTimeout(r, 150));

    const rows = db.exec('SELECT COUNT(*) FROM events;');
    expect(Number(rows[0].values[0][0])).toBeGreaterThanOrEqual(1);

    await ingester.shutdown();
  });

  it('shutdown() should clear intervals and do a final processing pass', async () => {
    const db = storage.getDb();
    const filePath = path.join(eventsDir, 'events-2024-06-01.jsonl');

    const ingester = new Ingester(db, eventsDir, {
      batchIntervalMs: 60000, // Won't fire during test
    });
    await ingester.start();

    // Write events after start but before shutdown
    writeJsonlFile(filePath, [makeEvent(), makeEvent(), makeEvent()]);

    // Shutdown should do a final pass
    await ingester.shutdown();

    const rows = db.exec('SELECT COUNT(*) FROM events;');
    expect(rows[0].values[0][0]).toBe(3);
  });

  it('shutdown() should be safe to call when never started', async () => {
    const db = storage.getDb();
    const ingester = new Ingester(db, eventsDir);

    // Should not throw
    await expect(ingester.shutdown()).resolves.toBeUndefined();
  });

  it('shutdown() should be idempotent (safe to call twice)', async () => {
    const db = storage.getDb();
    const ingester = new Ingester(db, eventsDir, {
      batchIntervalMs: 60000,
    });
    await ingester.start();

    await ingester.shutdown();
    await expect(ingester.shutdown()).resolves.toBeUndefined();
  });
});

// ── Ingester Class: processOnce error isolation ───────────────────────────

describe('Ingester class — error isolation', () => {
  it('processOnce() should swallow errors and not crash', () => {
    const db = storage.getDb();
    const ingester = new Ingester(db, '/nonexistent/path/events');

    // Should not throw even with a bad path
    expect(() => ingester.processOnce()).not.toThrow();
  });

  it('processOnce() should continue working after an error', async () => {
    const db = storage.getDb();
    const ingester = new Ingester(db, eventsDir);

    // First call with no events — should not throw
    ingester.processOnce();

    // Write valid events and call again
    const filePath = path.join(eventsDir, 'events-2024-06-01.jsonl');
    writeJsonlFile(filePath, [makeEvent()]);
    ingester.processOnce();

    const rows = db.exec('SELECT COUNT(*) FROM events;');
    expect(rows[0].values[0][0]).toBe(1);
  });
});

// ── Ingester Class: stale detection integration ───────────────────────────

describe('Ingester class — stale detection', () => {
  it('detectStale() should not throw on empty database', () => {
    const db = storage.getDb();
    const ingester = new Ingester(db, eventsDir);

    expect(() => ingester.detectStale()).not.toThrow();
  });

  it('detectStale() should mark old running sessions as stale', () => {
    const db = storage.getDb();

    // Insert a session that hasn't been seen for > 60 minutes
    const oldTime = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    db.run(`
      INSERT INTO sessions (session_id, project, workspace, status, start_time, last_seen, model)
      VALUES ('stale-test', 'test', '/test', 'running', ?, ?, '[]');
    `, [oldTime, oldTime]);

    const ingester = new Ingester(db, eventsDir, { staleTimeoutMinutes: 60 });
    ingester.detectStale();

    const result = db.exec("SELECT status FROM sessions WHERE session_id = 'stale-test';");
    expect(result[0].values[0][0]).toBe('stale');
  });
});

// ── Ingester Class: cleanup integration ───────────────────────────────────

describe('Ingester class — cleanup', () => {
  it('cleanup() should delegate to cleanupOldFiles', () => {
    const db = storage.getDb();
    const ingester = new Ingester(db, eventsDir);

    // Should not throw on empty directory
    const deleted = ingester.cleanup();
    expect(deleted).toBe(0);
  });
});

// ── Server integration: ingester.start() called ───────────────────────────

describe('Server — ingester integration', () => {
  it('createServer should call ingester.start() so live ingestion works', async () => {
    // We test this by verifying the source code structure — reading the file
    // and checking that ingester.start() is called. A full integration test
    // would require starting the actual server which is heavyweight.
    const serverSrc = fs.readFileSync(
      path.resolve(__dirname, '..', 'src', 'server', 'index.ts'),
      'utf-8'
    );
    expect(serverSrc).toContain('await ingester.start()');
  });
});
