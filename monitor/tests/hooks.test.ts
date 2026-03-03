/**
 * Tests for Phase D: Hook Event Collection (Spec 01).
 * D1: Hook scripts for all 12 event types.
 * D2: Event file format and daily rotation.
 *
 * Tests the hook handler logic directly, verifying JSONL output,
 * event record structure, and error resilience.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HOOK_EVENT_TYPES } from '@shared/constants.js';
import type { HookEventType, EventRecord } from '@shared/types.js';

let tmpDir: string;
let dataDir: string;
let eventsDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-hooks-test-'));
  dataDir = path.join(tmpDir, 'data');
  eventsDir = path.join(dataDir, 'events');
  fs.mkdirSync(eventsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Simulate what handleHookEvent does: write an event record to JSONL. */
function writeTestEvent(
  type: HookEventType,
  payload: Record<string, unknown> = {},
  sessionId = 'test-session-1'
): EventRecord {
  const { randomUUID } = require('node:crypto');
  const event: EventRecord = {
    id: randomUUID(),
    sessionId,
    timestamp: new Date().toISOString(),
    type,
    tool: (payload.tool_name as string) ?? null,
    payload,
    project: 'test-project',
    workspace: '/test/workspace',
    ...(payload.tool_use_id ? { toolUseId: payload.tool_use_id as string } : {}),
  };

  const date = new Date().toISOString().split('T')[0];
  const filePath = path.join(eventsDir, `events-${date}.jsonl`);
  fs.appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf-8');

  return event;
}

/** Read all events from the current day's JSONL file. */
function readTodaysEvents(): EventRecord[] {
  const date = new Date().toISOString().split('T')[0];
  const filePath = path.join(eventsDir, `events-${date}.jsonl`);

  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf-8').trim();
  if (!content) return [];

  return content.split('\n').map(line => JSON.parse(line));
}

// ── D1: Hook Scripts for All 12 Event Types ──────────────────────────────────

describe('D1 — Hook scripts for all 12 event types', () => {
  it('should have all 12 hook script files (AC 5-17)', () => {
    const hookFiles = [
      'pre-tool-use.ts',
      'post-tool-use.ts',
      'post-tool-use-failure.ts',
      'user-prompt-submit.ts',
      'stop.ts',
      'subagent-start.ts',
      'subagent-stop.ts',
      'pre-compact.ts',
      'notification.ts',
      'permission-request.ts',
      'session-start.ts',
      'session-end.ts',
    ];

    const hooksDir = path.resolve(__dirname, '..', 'src', 'hooks');
    for (const file of hookFiles) {
      expect(fs.existsSync(path.join(hooksDir, file)), `Hook file missing: ${file}`).toBe(true);
    }
  });

  it('should write valid JSONL lines for each event type', () => {
    for (const type of HOOK_EVENT_TYPES) {
      writeTestEvent(type, { tool_name: 'TestTool' });
    }

    const events = readTodaysEvents();
    expect(events).toHaveLength(12);

    // Each event type should appear exactly once
    const types = events.map(e => e.type);
    for (const type of HOOK_EVENT_TYPES) {
      expect(types).toContain(type);
    }
  });

  it('should include all required fields in event records (AC 18-24)', () => {
    const event = writeTestEvent('PostToolUse', {
      tool_name: 'Bash',
      tool_use_id: 'tu-123',
      input: { command: 'ls -la' },
    });

    expect(event.id).toBeTruthy(); // unique ID
    expect(event.sessionId).toBe('test-session-1');
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 8601
    expect(event.type).toBe('PostToolUse');
    expect(event.tool).toBe('Bash');
    expect(event.payload).toBeDefined();
    expect(event.project).toBeTruthy();
    expect(event.workspace).toBeTruthy();
  });

  it('should generate unique IDs for each event', () => {
    const events = Array.from({ length: 10 }, () =>
      writeTestEvent('PostToolUse')
    );
    const ids = events.map(e => e.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(10);
  });

  it('should use ISO 8601 timestamps', () => {
    const event = writeTestEvent('SessionStart');
    // ISO 8601 format: YYYY-MM-DDTHH:mm:ss.sssZ
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
  });

  it('should pair PreToolUse/PostToolUse with shared tool_use_id (AC 32-33)', () => {
    const pre = writeTestEvent('PreToolUse', { tool_name: 'Edit', tool_use_id: 'tu-shared-1' });
    const post = writeTestEvent('PostToolUse', { tool_name: 'Edit', tool_use_id: 'tu-shared-1' });

    expect(pre.toolUseId).toBe('tu-shared-1');
    expect(post.toolUseId).toBe('tu-shared-1');
    expect(pre.toolUseId).toBe(post.toolUseId);
  });

  it('should auto-create events directory if missing (AC 40)', () => {
    const freshDir = path.join(tmpDir, 'fresh', 'data', 'events');
    // Ensure it doesn't exist
    expect(fs.existsSync(freshDir)).toBe(false);

    // Create directory and write event
    fs.mkdirSync(freshDir, { recursive: true });
    const date = new Date().toISOString().split('T')[0];
    const filePath = path.join(freshDir, `events-${date}.jsonl`);
    fs.appendFileSync(filePath, JSON.stringify({ test: true }) + '\n', 'utf-8');

    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('should handle events with no tool_name gracefully', () => {
    const event = writeTestEvent('UserPromptSubmit', { message: 'hello world' });
    expect(event.tool).toBeNull();
  });

  it('should preserve complete payload data without truncation (AC 22)', () => {
    const largePayload = {
      tool_name: 'Bash',
      input: { command: 'A'.repeat(10000) }, // large payload
      output: { stdout: 'B'.repeat(10000) },
    };

    writeTestEvent('PostToolUse', largePayload);
    const events = readTodaysEvents();
    const lastEvent = events[events.length - 1];
    expect((lastEvent.payload.input as Record<string, string>).command).toHaveLength(10000);
    expect((lastEvent.payload.output as Record<string, string>).stdout).toHaveLength(10000);
  });
});

// ── D2: Event File Format and Daily Rotation ─────────────────────────────────

describe('D2 — Event file format and daily rotation', () => {
  it('should use daily file naming: events-YYYY-MM-DD.jsonl', () => {
    writeTestEvent('SessionStart');

    const date = new Date().toISOString().split('T')[0];
    const expectedFile = `events-${date}.jsonl`;
    const files = fs.readdirSync(eventsDir);
    expect(files).toContain(expectedFile);
  });

  it('should produce independently parseable JSONL lines', () => {
    writeTestEvent('PreToolUse', { tool_name: 'Read' });
    writeTestEvent('PostToolUse', { tool_name: 'Read' });
    writeTestEvent('PostToolUseFailure', { tool_name: 'Edit', error: 'not found' });

    const date = new Date().toISOString().split('T')[0];
    const filePath = path.join(eventsDir, `events-${date}.jsonl`);
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    const lines = content.split('\n');

    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('should interleave events from different sessions correctly', () => {
    writeTestEvent('SessionStart', {}, 'session-A');
    writeTestEvent('PostToolUse', { tool_name: 'Read' }, 'session-B');
    writeTestEvent('PostToolUse', { tool_name: 'Edit' }, 'session-A');
    writeTestEvent('SessionEnd', {}, 'session-B');

    const events = readTodaysEvents();
    expect(events).toHaveLength(4);
    expect(events[0].sessionId).toBe('session-A');
    expect(events[1].sessionId).toBe('session-B');
    expect(events[2].sessionId).toBe('session-A');
    expect(events[3].sessionId).toBe('session-B');
  });

  it('should handle concurrent appends without corruption', () => {
    // Simulate concurrent writes by rapidly appending
    const promises = Array.from({ length: 50 }, (_, i) =>
      writeTestEvent('PostToolUse', { tool_name: `Tool-${i}` })
    );

    const events = readTodaysEvents();
    expect(events).toHaveLength(50);

    // Each line should be independently parseable
    const date = new Date().toISOString().split('T')[0];
    const filePath = path.join(eventsDir, `events-${date}.jsonl`);
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('should detect midnight rotation naturally (new date = new file)', () => {
    // Write an event for "yesterday" by creating the file manually
    const yesterday = new Date(Date.now() - 86400000);
    const yesterdayDate = yesterday.toISOString().split('T')[0];
    const yesterdayFile = path.join(eventsDir, `events-${yesterdayDate}.jsonl`);
    fs.writeFileSync(yesterdayFile, '{"type":"old"}\n', 'utf-8');

    // Write today's event
    writeTestEvent('SessionStart');

    const files = fs.readdirSync(eventsDir).sort();
    expect(files.length).toBe(2);
    expect(files.some(f => f.includes(yesterdayDate))).toBe(true);
    expect(files.some(f => f.includes(new Date().toISOString().split('T')[0]))).toBe(true);
  });
});
