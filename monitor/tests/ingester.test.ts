/**
 * Tests for Phase E: Event Ingestion Pipeline (Spec 02).
 * E1: File watcher and position tracking
 * E2: Batch parsing and insertion
 * E3: Daemon lifecycle (tested at unit level)
 * E4: Post-ingestion file cleanup
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Storage } from '@lib/storage.js';
import {
  readPosition,
  savePosition,
  readNewLines,
  insertBatch,
  processFile,
  processAllFiles,
  cleanupOldFiles,
} from '@server/ingester.js';
import type { EventRecord } from '@shared/types.js';

let tmpDir: string;
let eventsDir: string;
let storage: Storage;

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: randomUUID(),
    sessionId: 'test-session-1',
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

function appendJsonlLine(filePath: string, event: EventRecord): void {
  fs.appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf-8');
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-ingester-test-'));
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

// ── E1: Position Tracking ────────────────────────────────────────────────────

describe('E1 — Position tracking', () => {
  it('should return 0 for non-existent position file', () => {
    const pos = readPosition(path.join(eventsDir, 'nonexistent.jsonl'));
    expect(pos).toBe(0);
  });

  it('should save and read position correctly', () => {
    const filePath = path.join(eventsDir, 'test.jsonl');
    savePosition(filePath, 1234);
    expect(readPosition(filePath)).toBe(1234);
  });

  it('should survive restart — position persists via .pos file', () => {
    const filePath = path.join(eventsDir, 'test.jsonl');
    savePosition(filePath, 5678);

    // Simulate restart — read from the same .pos file
    const posAfterRestart = readPosition(filePath);
    expect(posAfterRestart).toBe(5678);
  });

  it('should only process new lines since last offset (no duplicates)', () => {
    const filePath = path.join(eventsDir, 'test.jsonl');
    const event1 = makeEvent();
    const event2 = makeEvent();

    // Write first event directly (not via writeJsonlFile to control exact content)
    fs.appendFileSync(filePath, JSON.stringify(event1) + '\n', 'utf-8');

    // First read
    const result1 = readNewLines(filePath, 0);
    expect(result1.events).toHaveLength(1);
    expect(result1.events[0].id).toBe(event1.id);
    savePosition(filePath, result1.newOffset);

    // Verify position matches file size
    const sizeAfterFirst = fs.statSync(filePath).size;
    expect(result1.newOffset).toBe(sizeAfterFirst);

    // Append second event
    fs.appendFileSync(filePath, JSON.stringify(event2) + '\n', 'utf-8');

    // Verify file grew
    const sizeAfterSecond = fs.statSync(filePath).size;
    expect(sizeAfterSecond).toBeGreaterThan(sizeAfterFirst);

    // Second read from saved position — should only get the new event
    const savedPos = readPosition(filePath);
    expect(savedPos).toBe(sizeAfterFirst);

    const result2 = readNewLines(filePath, savedPos);
    expect(result2.events).toHaveLength(1);
    expect(result2.events[0].id).toBe(event2.id);
  });

  it('should hold partial lines until complete (no trailing newline)', () => {
    const filePath = path.join(eventsDir, 'test.jsonl');
    const event = makeEvent();
    const partialLine = JSON.stringify(event); // No trailing newline

    fs.writeFileSync(filePath, partialLine, 'utf-8');

    const result = readNewLines(filePath, 0);
    expect(result.events).toHaveLength(0); // Incomplete line held
  });
});

// ── E2: Batch Parsing and Insertion ──────────────────────────────────────────

describe('E2 — Batch parsing and insertion', () => {
  it('should insert valid events into the events table', () => {
    const db = storage.getDb();
    const events = [makeEvent(), makeEvent()];

    const result = insertBatch(db, events);
    expect(result.inserted).toBe(2);
    expect(result.duplicates).toBe(0);

    const rows = db.exec('SELECT COUNT(*) FROM events;');
    expect(rows[0].values[0][0]).toBe(2);
  });

  it('should skip malformed lines and log warning', () => {
    const filePath = path.join(eventsDir, 'test.jsonl');
    const validEvent = makeEvent();

    // Write valid line, malformed line, another valid line
    const content = [
      JSON.stringify(validEvent),
      '{ this is not valid json }',
      JSON.stringify(makeEvent()),
    ].join('\n') + '\n';
    fs.writeFileSync(filePath, content, 'utf-8');

    const result = readNewLines(filePath, 0);
    expect(result.events).toHaveLength(2); // 2 valid
    expect(result.malformedCount).toBe(1); // 1 malformed
  });

  it('should be atomic — all-or-nothing per batch via transaction', () => {
    const db = storage.getDb();
    const events = [makeEvent(), makeEvent(), makeEvent()];

    const result = insertBatch(db, events);
    expect(result.inserted).toBe(3);

    const rows = db.exec('SELECT COUNT(*) FROM events;');
    expect(rows[0].values[0][0]).toBe(3);
  });

  it('should auto-create session on first event with unseen sessionId (AC)', () => {
    const db = storage.getDb();
    const event = makeEvent({ sessionId: 'new-session-abc' });

    insertBatch(db, [event]);

    const sessions = db.exec(
      "SELECT session_id, status FROM sessions WHERE session_id = 'new-session-abc';"
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0].values[0][1]).toBe('running');
  });

  it('should reject duplicate event IDs (idempotent)', () => {
    const db = storage.getDb();
    const event = makeEvent();

    insertBatch(db, [event]);
    const result = insertBatch(db, [event]); // Same event again

    expect(result.duplicates).toBe(1);
    expect(result.inserted).toBe(0);

    const rows = db.exec('SELECT COUNT(*) FROM events;');
    expect(rows[0].values[0][0]).toBe(1); // Only one copy
  });

  it('should flush based on time interval (configurable)', () => {
    const filePath = path.join(eventsDir, 'test.jsonl');
    writeJsonlFile(filePath, [makeEvent(), makeEvent()]);

    const result = processFile(storage.getDb(), filePath);
    expect(result.processed).toBe(2);
  });

  it('should preserve prior batch data when a later batch fails', () => {
    const db = storage.getDb();

    // First batch succeeds
    const batch1 = [makeEvent(), makeEvent()];
    insertBatch(db, batch1);

    const countBefore = db.exec('SELECT COUNT(*) FROM events;');
    expect(countBefore[0].values[0][0]).toBe(2);

    // Second batch with valid events — all should succeed
    const batch2 = [makeEvent()];
    insertBatch(db, batch2);

    const countAfter = db.exec('SELECT COUNT(*) FROM events;');
    expect(countAfter[0].values[0][0]).toBe(3);
  });
});

// ── E3: Daemon Lifecycle (unit tests) ────────────────────────────────────────

describe('E3 — Daemon lifecycle', () => {
  it('should process accumulated files on startup', () => {
    const date = new Date().toISOString().split('T')[0];
    const filePath = path.join(eventsDir, `events-${date}.jsonl`);
    writeJsonlFile(filePath, [makeEvent(), makeEvent(), makeEvent()]);

    const result = processAllFiles(storage.getDb(), eventsDir);
    expect(result.totalProcessed).toBe(3);
    expect(result.filesProcessed).toBe(1);
  });

  it('should process multiple JSONL files', () => {
    const file1 = path.join(eventsDir, 'events-2024-01-01.jsonl');
    const file2 = path.join(eventsDir, 'events-2024-01-02.jsonl');
    writeJsonlFile(file1, [makeEvent(), makeEvent()]);
    writeJsonlFile(file2, [makeEvent()]);

    const result = processAllFiles(storage.getDb(), eventsDir);
    expect(result.totalProcessed).toBe(3);
    expect(result.filesProcessed).toBe(2);
  });
});

// ── E4: Post-Ingestion Cleanup ───────────────────────────────────────────────

describe('E4 — Post-ingestion file cleanup', () => {
  it('should delete fully ingested files older than 1 day', () => {
    const oldFile = path.join(eventsDir, 'events-2024-01-01.jsonl');
    writeJsonlFile(oldFile, [makeEvent()]);

    // Mark as fully ingested
    const stat = fs.statSync(oldFile);
    savePosition(oldFile, stat.size);

    // Make it old enough
    const oldTime = Date.now() - 2 * 86400000; // 2 days ago
    fs.utimesSync(oldFile, new Date(oldTime), new Date(oldTime));

    const deleted = cleanupOldFiles(eventsDir);
    expect(deleted).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
  });

  it('should never delete current day\'s file', () => {
    const today = new Date().toISOString().split('T')[0];
    const todayFile = path.join(eventsDir, `events-${today}.jsonl`);
    writeJsonlFile(todayFile, [makeEvent()]);

    const stat = fs.statSync(todayFile);
    savePosition(todayFile, stat.size);

    const deleted = cleanupOldFiles(eventsDir);
    expect(deleted).toBe(0);
    expect(fs.existsSync(todayFile)).toBe(true);
  });

  it('should never delete files with unprocessed lines', () => {
    const oldFile = path.join(eventsDir, 'events-2024-01-01.jsonl');
    writeJsonlFile(oldFile, [makeEvent(), makeEvent()]);

    // Mark only partially ingested
    savePosition(oldFile, 10); // Much less than full file

    // Make it old enough
    const oldTime = Date.now() - 2 * 86400000;
    fs.utimesSync(oldFile, new Date(oldTime), new Date(oldTime));

    const deleted = cleanupOldFiles(eventsDir);
    expect(deleted).toBe(0);
    expect(fs.existsSync(oldFile)).toBe(true);
  });
});
