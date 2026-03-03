/**
 * Phase R1 — End-to-end integration tests for Ralph Monitor.
 * Verifies the full pipeline: JSONL event ingestion → SQLite storage → API response.
 *
 * Strategy:
 * - In-memory sql.js database (no disk DB needed)
 * - Temp directories for JSONL event files
 * - Fastify.inject() for HTTP requests (no TCP listener)
 * - Tests cover ingestion, session lifecycle, analytics, search, config, concurrency,
 *   error categorization, and graceful shutdown.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import initSqlJs, { type Database } from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { processAllFiles, insertBatch, Ingester } from '@server/ingester.js';
import { processEvent } from '@server/session-lifecycle.js';
import { Storage } from '@lib/storage.js';
import { registerSessionRoutes } from '@server/routes/sessions.js';
import { registerAnalyticsRoutes } from '@server/routes/analytics.js';
import { registerConfigRoutes } from '@server/routes/config.js';
import { registerSearchRoutes } from '@server/routes/search.js';
import { registerGuardrailRoutes } from '@server/routes/guardrails.js';
import type { EventRecord, HookEventType } from '@shared/types.js';

// ── Schema DDL (mirrors storage.ts) ──────────────────────────────────────────

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    workspace TEXT NOT NULL DEFAULT '',
    model TEXT,
    status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'errored', 'stale')) DEFAULT 'running',
    start_time TEXT NOT NULL,
    end_time TEXT,
    total_cost REAL NOT NULL DEFAULT 0,
    token_counts TEXT NOT NULL DEFAULT '{"input":0,"output":0,"cacheCreation":0,"cacheRead":0}',
    turn_count INTEGER NOT NULL DEFAULT 0,
    inferred_phase TEXT,
    last_seen TEXT NOT NULL,
    error_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    type TEXT NOT NULL,
    tool_name TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    duration REAL,
    tool_use_id TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
  );

  CREATE TABLE IF NOT EXISTS metrics (
    session_id TEXT PRIMARY KEY,
    cost_breakdown TEXT NOT NULL DEFAULT '{}',
    token_breakdown TEXT NOT NULL DEFAULT '{}',
    model TEXT,
    wall_clock_duration REAL,
    api_duration REAL,
    turn_count INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
  );

  CREATE TABLE IF NOT EXISTS guardrail_log (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    rule_name TEXT NOT NULL,
    action TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
  );

  CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);
  CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
  CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  CREATE INDEX IF NOT EXISTS idx_sessions_start_time ON sessions(start_time);
  CREATE INDEX IF NOT EXISTS idx_guardrail_log_session_id ON guardrail_log(session_id);
  CREATE INDEX IF NOT EXISTS idx_metrics_session_id ON metrics(session_id);
`;

// ── Helpers ──────────────────────────────────────────────────────────────────

let db: Database;
let fastify: FastifyInstance;
let tmpDir: string;
let eventsDir: string;

/** Create a Fastify instance backed by an in-memory sql.js DB with all routes registered. */
async function createTestServer(): Promise<{
  fastify: FastifyInstance;
  db: Database;
  configPath: string;
}> {
  const SQL = await initSqlJs();
  db = new SQL.Database();
  db.run('PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA_DDL);

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-integration-'));
  eventsDir = path.join(tmpDir, 'events');
  fs.mkdirSync(eventsDir, { recursive: true });

  const configPath = path.join(tmpDir, 'test-config.json');

  fastify = Fastify({ logger: false });

  fastify.decorate('db', db);
  fastify.decorate('configPath', configPath);
  fastify.decorate('eventsDir', eventsDir);

  registerSessionRoutes(fastify);
  registerAnalyticsRoutes(fastify);
  registerConfigRoutes(fastify);
  registerSearchRoutes(fastify);
  registerGuardrailRoutes(fastify);

  await fastify.ready();
  return { fastify, db, configPath };
}

/** Build a well-formed EventRecord with overrides. */
function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: randomUUID(),
    sessionId: 'session-1',
    timestamp: new Date().toISOString(),
    type: 'PostToolUse',
    tool: 'Bash',
    payload: { input: { command: 'echo hello' } },
    project: 'test-project',
    workspace: '/home/user/test-project',
    ...overrides,
  };
}

/** Write an array of EventRecord objects to a JSONL file. */
function writeJsonlFile(filePath: string, events: EventRecord[]): void {
  const content = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(filePath, content, 'utf-8');
}

/** Append a single event to a JSONL file. */
function appendJsonlLine(filePath: string, event: EventRecord): void {
  fs.appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf-8');
}

/** Clean up after each test. */
async function teardown(): Promise<void> {
  await fastify.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Test 1: Full pipeline — event ingestion to API ──────────────────────────

describe('Integration Test 1 — Full pipeline: event ingestion to API', () => {
  beforeEach(async () => { await createTestServer(); });
  afterEach(async () => { await teardown(); });

  it('should ingest JSONL events and expose them via sessions API', async () => {
    const sessionId = 'pipeline-sess-1';
    const now = new Date().toISOString();

    const events: EventRecord[] = [
      makeEvent({
        id: 'evt-start-1',
        sessionId,
        type: 'SessionStart',
        tool: null,
        timestamp: now,
        payload: { model: 'claude-sonnet-4' },
      }),
      makeEvent({
        id: 'evt-tool-1',
        sessionId,
        type: 'PostToolUse',
        tool: 'Read',
        timestamp: new Date(Date.now() + 1000).toISOString(),
        payload: { input: { file_path: '/src/index.ts' } },
      }),
      makeEvent({
        id: 'evt-tool-2',
        sessionId,
        type: 'PostToolUse',
        tool: 'Edit',
        timestamp: new Date(Date.now() + 2000).toISOString(),
        payload: { input: { file_path: '/src/main.ts' } },
      }),
    ];

    const filePath = path.join(eventsDir, '2026-03-03.jsonl');
    writeJsonlFile(filePath, events);

    // Ingest via the pipeline
    const result = processAllFiles(db, eventsDir);
    expect(result.totalProcessed).toBe(3);
    expect(result.filesProcessed).toBe(1);

    // Verify session appears via API
    const listRes = await fastify.inject({ method: 'GET', url: '/api/sessions' });
    expect(listRes.statusCode).toBe(200);
    const listBody = JSON.parse(listRes.body);
    expect(listBody.sessions).toHaveLength(1);
    expect(listBody.sessions[0].sessionId).toBe(sessionId);
    expect(listBody.sessions[0].project).toBe('test-project');
    expect(listBody.sessions[0].status).toBe('running');

    // Verify session detail via API
    const detailRes = await fastify.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
    expect(detailRes.statusCode).toBe(200);
    const detailBody = JSON.parse(detailRes.body);
    expect(detailBody.session.sessionId).toBe(sessionId);
    expect(detailBody.session.model).toBe('claude-sonnet-4');
    expect(detailBody.tools).toHaveLength(2); // Read and Edit

    // Verify events endpoint
    const eventsRes = await fastify.inject({ method: 'GET', url: `/api/sessions/${sessionId}/events` });
    expect(eventsRes.statusCode).toBe(200);
    const eventsBody = JSON.parse(eventsRes.body);
    expect(eventsBody.events).toHaveLength(3);
    expect(eventsBody.total).toBe(3);
  });

  it('should skip malformed JSONL lines and still ingest valid events', async () => {
    const sessionId = 'pipeline-sess-2';
    const validEvent = makeEvent({ id: 'evt-valid-1', sessionId });

    const filePath = path.join(eventsDir, '2026-03-03-mixed.jsonl');
    // Write a mix of valid and malformed lines
    const content = [
      '{ this is not valid json',
      JSON.stringify(validEvent),
      '{"id": "no-session"}', // missing required fields
      '',
    ].join('\n') + '\n';
    fs.writeFileSync(filePath, content, 'utf-8');

    const result = processAllFiles(db, eventsDir);
    expect(result.totalProcessed).toBeGreaterThanOrEqual(1);
    expect(result.totalMalformed).toBeGreaterThanOrEqual(1);

    // The valid event should appear as a session
    const listRes = await fastify.inject({ method: 'GET', url: '/api/sessions' });
    const listBody = JSON.parse(listRes.body);
    expect(listBody.sessions).toHaveLength(1);
    expect(listBody.sessions[0].sessionId).toBe(sessionId);
  });

  it('should not re-ingest already processed events on second pass', async () => {
    const sessionId = 'pipeline-dedup';
    const events = [makeEvent({ id: 'evt-dup-1', sessionId })];

    const filePath = path.join(eventsDir, '2026-03-03-dedup.jsonl');
    writeJsonlFile(filePath, events);

    // First pass
    const result1 = processAllFiles(db, eventsDir);
    expect(result1.totalProcessed).toBe(1);

    // Second pass (position tracked, so should skip)
    const result2 = processAllFiles(db, eventsDir);
    expect(result2.totalProcessed).toBe(0);

    // Still only one session
    const listRes = await fastify.inject({ method: 'GET', url: '/api/sessions' });
    const listBody = JSON.parse(listRes.body);
    expect(listBody.sessions).toHaveLength(1);
  });
});

// ── Test 2: Session lifecycle transitions ────────────────────────────────────

describe('Integration Test 2 — Session lifecycle transitions', () => {
  beforeEach(async () => { await createTestServer(); });
  afterEach(async () => { await teardown(); });

  it('should transition session from running to completed via Stop event', async () => {
    const sessionId = 'lifecycle-sess-1';
    const filePath = path.join(eventsDir, 'lifecycle.jsonl');

    // Step 1: SessionStart → session created as "running"
    const startEvent = makeEvent({
      id: 'lc-start',
      sessionId,
      type: 'SessionStart',
      tool: null,
      timestamp: new Date(Date.now()).toISOString(),
      payload: { model: 'claude-sonnet-4' },
    });
    writeJsonlFile(filePath, [startEvent]);
    processAllFiles(db, eventsDir);

    let res = await fastify.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
    let body = JSON.parse(res.body);
    expect(body.session.status).toBe('running');

    // Step 2: UserPromptSubmit events → turn count incremented
    const prompt1 = makeEvent({
      id: 'lc-prompt-1',
      sessionId,
      type: 'UserPromptSubmit',
      tool: null,
      timestamp: new Date(Date.now() + 1000).toISOString(),
      payload: { message: 'Do something' },
    });
    const prompt2 = makeEvent({
      id: 'lc-prompt-2',
      sessionId,
      type: 'UserPromptSubmit',
      tool: null,
      timestamp: new Date(Date.now() + 2000).toISOString(),
      payload: { message: 'Do another thing' },
    });
    appendJsonlLine(filePath, prompt1);
    appendJsonlLine(filePath, prompt2);
    processAllFiles(db, eventsDir);

    res = await fastify.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
    body = JSON.parse(res.body);
    expect(body.session.turnCount).toBe(2);
    expect(body.session.status).toBe('running');

    // Step 3: Stop event → session transitions to "completed"
    const stopEvent = makeEvent({
      id: 'lc-stop',
      sessionId,
      type: 'Stop',
      tool: null,
      timestamp: new Date(Date.now() + 5000).toISOString(),
      payload: {},
    });
    appendJsonlLine(filePath, stopEvent);
    processAllFiles(db, eventsDir);

    res = await fastify.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
    body = JSON.parse(res.body);
    expect(body.session.status).toBe('completed');
    expect(body.session.endTime).toBeTruthy();
  });

  it('should transition session to errored when Stop has error payload', async () => {
    const sessionId = 'lifecycle-err-1';
    const filePath = path.join(eventsDir, 'lifecycle-err.jsonl');

    const startEvent = makeEvent({
      id: 'lc-err-start',
      sessionId,
      type: 'SessionStart',
      tool: null,
      timestamp: new Date().toISOString(),
      payload: {},
    });
    const stopWithError = makeEvent({
      id: 'lc-err-stop',
      sessionId,
      type: 'Stop',
      tool: null,
      timestamp: new Date(Date.now() + 1000).toISOString(),
      payload: { error: 'Out of context window' },
    });

    writeJsonlFile(filePath, [startEvent, stopWithError]);
    processAllFiles(db, eventsDir);

    const res = await fastify.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
    const body = JSON.parse(res.body);
    expect(body.session.status).toBe('errored');
  });

  it('should increment error_count for PostToolUseFailure events', async () => {
    const sessionId = 'lifecycle-errcnt';
    const filePath = path.join(eventsDir, 'lifecycle-errcnt.jsonl');

    const events: EventRecord[] = [
      makeEvent({
        id: 'lc-ec-start',
        sessionId,
        type: 'SessionStart',
        tool: null,
        timestamp: new Date().toISOString(),
        payload: {},
      }),
      makeEvent({
        id: 'lc-ec-fail-1',
        sessionId,
        type: 'PostToolUseFailure',
        tool: 'Bash',
        timestamp: new Date(Date.now() + 1000).toISOString(),
        payload: { error: 'command not found' },
      }),
      makeEvent({
        id: 'lc-ec-fail-2',
        sessionId,
        type: 'PostToolUseFailure',
        tool: 'Edit',
        timestamp: new Date(Date.now() + 2000).toISOString(),
        payload: { error: 'file not found' },
      }),
    ];

    writeJsonlFile(filePath, events);
    processAllFiles(db, eventsDir);

    const res = await fastify.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
    const body = JSON.parse(res.body);
    expect(body.session.errorCount).toBe(2);
  });

  it('should infer session phase from tool events', async () => {
    const sessionId = 'lifecycle-phase';
    const filePath = path.join(eventsDir, 'lifecycle-phase.jsonl');

    const events: EventRecord[] = [
      makeEvent({
        id: 'lc-ph-start',
        sessionId,
        type: 'SessionStart',
        tool: null,
        timestamp: new Date().toISOString(),
        payload: {},
      }),
      makeEvent({
        id: 'lc-ph-grep',
        sessionId,
        type: 'PostToolUse',
        tool: 'Grep',
        timestamp: new Date(Date.now() + 1000).toISOString(),
        payload: { input: { pattern: 'TODO' } },
      }),
    ];

    writeJsonlFile(filePath, events);
    processAllFiles(db, eventsDir);

    const res = await fastify.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
    const body = JSON.parse(res.body);
    expect(body.session.inferredPhase).toBe('Investigating code');
  });
});

// ── Test 3: Analytics endpoint accuracy ──────────────────────────────────────

describe('Integration Test 3 — Analytics endpoint accuracy', () => {
  beforeEach(async () => { await createTestServer(); });
  afterEach(async () => { await teardown(); });

  it('should return correct session counts and cost data via overview', async () => {
    const now = new Date();
    const filePath = path.join(eventsDir, 'analytics.jsonl');

    // Create sessions with different statuses using lifecycle events
    const sessionA = 'analytics-sess-a';
    const sessionB = 'analytics-sess-b';
    const sessionC = 'analytics-sess-c';

    const events: EventRecord[] = [
      // Session A — running
      makeEvent({
        id: 'an-a-start',
        sessionId: sessionA,
        type: 'SessionStart',
        tool: null,
        timestamp: now.toISOString(),
        payload: { model: 'claude-sonnet-4' },
        project: 'alpha',
      }),
      // Session B — completed (start + stop)
      makeEvent({
        id: 'an-b-start',
        sessionId: sessionB,
        type: 'SessionStart',
        tool: null,
        timestamp: now.toISOString(),
        payload: {},
        project: 'beta',
      }),
      makeEvent({
        id: 'an-b-stop',
        sessionId: sessionB,
        type: 'Stop',
        tool: null,
        timestamp: new Date(now.getTime() + 1000).toISOString(),
        payload: {},
        project: 'beta',
      }),
      // Session C — errored (start + error stop)
      makeEvent({
        id: 'an-c-start',
        sessionId: sessionC,
        type: 'SessionStart',
        tool: null,
        timestamp: now.toISOString(),
        payload: {},
        project: 'gamma',
      }),
      makeEvent({
        id: 'an-c-stop',
        sessionId: sessionC,
        type: 'Stop',
        tool: null,
        timestamp: new Date(now.getTime() + 2000).toISOString(),
        payload: { error: 'crash' },
        project: 'gamma',
      }),
    ];

    writeJsonlFile(filePath, events);
    processAllFiles(db, eventsDir);

    // Verify via overview API
    const res = await fastify.inject({ method: 'GET', url: '/api/analytics/overview' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // Only session A should be running
    expect(body.activeSessions).toBe(1);
    expect(typeof body.totalCost).toBe('number');
    expect(typeof body.errorRate).toBe('number');
    expect(body.toolCallsPerMin).toHaveLength(10);
  });

  it('should report correct error counts when tool failures are present', async () => {
    const now = new Date();
    const filePath = path.join(eventsDir, 'analytics-errors.jsonl');
    const sessionId = 'analytics-err-sess';

    const events: EventRecord[] = [
      makeEvent({
        id: 'an-err-start',
        sessionId,
        type: 'SessionStart',
        tool: null,
        timestamp: now.toISOString(),
        payload: {},
      }),
      makeEvent({
        id: 'an-err-ok1',
        sessionId,
        type: 'PostToolUse',
        tool: 'Read',
        timestamp: new Date(now.getTime() + 100).toISOString(),
        payload: {},
      }),
      makeEvent({
        id: 'an-err-ok2',
        sessionId,
        type: 'PostToolUse',
        tool: 'Read',
        timestamp: new Date(now.getTime() + 200).toISOString(),
        payload: {},
      }),
      makeEvent({
        id: 'an-err-fail1',
        sessionId,
        type: 'PostToolUseFailure',
        tool: 'Edit',
        timestamp: new Date(now.getTime() + 300).toISOString(),
        payload: { error: 'old_string not found' },
      }),
    ];

    writeJsonlFile(filePath, events);
    processAllFiles(db, eventsDir);

    const res = await fastify.inject({ method: 'GET', url: '/api/analytics/overview' });
    const body = JSON.parse(res.body);

    expect(body.errorCount).toBe(1);
    // 1 failure out of 3 tool calls (2 PostToolUse + 1 PostToolUseFailure)
    expect(body.errorRate).toBeCloseTo(1 / 3, 2);
  });
});

// ── Test 4: Search endpoint ──────────────────────────────────────────────────

describe('Integration Test 4 — Search endpoint', () => {
  beforeEach(async () => { await createTestServer(); });
  afterEach(async () => { await teardown(); });

  it('should find events by keyword in payload after ingestion', async () => {
    const filePath = path.join(eventsDir, 'search.jsonl');
    const sessionId = 'search-sess-1';

    const events: EventRecord[] = [
      makeEvent({
        id: 'search-start',
        sessionId,
        type: 'SessionStart',
        tool: null,
        timestamp: new Date().toISOString(),
        payload: {},
      }),
      makeEvent({
        id: 'search-evt-1',
        sessionId,
        type: 'PostToolUse',
        tool: 'Read',
        timestamp: new Date(Date.now() + 100).toISOString(),
        payload: { input: { file_path: '/src/authentication.ts' }, output: 'token validation logic' },
      }),
      makeEvent({
        id: 'search-evt-2',
        sessionId,
        type: 'PostToolUse',
        tool: 'Bash',
        timestamp: new Date(Date.now() + 200).toISOString(),
        payload: { input: { command: 'npm run build' }, output: 'Build succeeded' },
      }),
      makeEvent({
        id: 'search-evt-3',
        sessionId,
        type: 'PostToolUse',
        tool: 'Grep',
        timestamp: new Date(Date.now() + 300).toISOString(),
        payload: { input: { pattern: 'authentication' }, output: 'Found 5 matches' },
      }),
    ];

    writeJsonlFile(filePath, events);
    processAllFiles(db, eventsDir);

    // Search for "authentication" — should match events 1 and 3
    const res = await fastify.inject({ method: 'GET', url: '/api/search?q=authentication' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.query).toBe('authentication');
    expect(body.events.length).toBe(2);

    const eventIds = body.events.map((e: { eventId: string }) => e.eventId);
    expect(eventIds).toContain('search-evt-1');
    expect(eventIds).toContain('search-evt-3');
  });

  it('should return empty results for non-matching queries', async () => {
    const filePath = path.join(eventsDir, 'search-empty.jsonl');
    const sessionId = 'search-sess-empty';

    const events: EventRecord[] = [
      makeEvent({
        id: 'search-empty-start',
        sessionId,
        type: 'SessionStart',
        tool: null,
        timestamp: new Date().toISOString(),
        payload: {},
      }),
      makeEvent({
        id: 'search-empty-evt',
        sessionId,
        type: 'PostToolUse',
        tool: 'Read',
        timestamp: new Date(Date.now() + 100).toISOString(),
        payload: { input: { file_path: '/src/utils.ts' } },
      }),
    ];

    writeJsonlFile(filePath, events);
    processAllFiles(db, eventsDir);

    const res = await fastify.inject({ method: 'GET', url: '/api/search?q=zyxnonexistentkeyword' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.events).toHaveLength(0);
  });

  it('should return 400 when q parameter is missing', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/search' });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('required');
  });
});

// ── Test 5: Config persistence ───────────────────────────────────────────────

describe('Integration Test 5 — Config persistence', () => {
  beforeEach(async () => { await createTestServer(); });
  afterEach(async () => { await teardown(); });

  it('should return default config when no config file exists', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.general.port).toBe(9100);
    expect(body.general.staleTimeoutMinutes).toBe(60);
    expect(body.display.theme).toBe('dark');
  });

  it('should persist config changes via PUT and retrieve via GET', async () => {
    // PUT a partial config update
    const putRes = await fastify.inject({
      method: 'PUT',
      url: '/api/config',
      headers: { 'Content-Type': 'application/json' },
      payload: {
        general: { port: 9200 },
        display: { theme: 'light' },
      },
    });
    expect(putRes.statusCode).toBe(200);
    const putBody = JSON.parse(putRes.body);
    expect(putBody.general.port).toBe(9200);
    expect(putBody.display.theme).toBe('light');

    // GET to verify persistence
    const getRes = await fastify.inject({ method: 'GET', url: '/api/config' });
    expect(getRes.statusCode).toBe(200);
    const getBody = JSON.parse(getRes.body);
    expect(getBody.general.port).toBe(9200);
    expect(getBody.display.theme).toBe('light');
    // Other fields should retain defaults
    expect(getBody.general.staleTimeoutMinutes).toBe(60);
    expect(getBody.ingestion.batchIntervalMs).toBe(1000);
  });

  it('should allow multiple sequential config updates without overwriting unrelated fields', async () => {
    // First update: change port
    await fastify.inject({
      method: 'PUT',
      url: '/api/config',
      headers: { 'Content-Type': 'application/json' },
      payload: { general: { port: 9300 } },
    });

    // Second update: change theme (port should still be 9300)
    await fastify.inject({
      method: 'PUT',
      url: '/api/config',
      headers: { 'Content-Type': 'application/json' },
      payload: { display: { theme: 'light' } },
    });

    const getRes = await fastify.inject({ method: 'GET', url: '/api/config' });
    const body = JSON.parse(getRes.body);
    expect(body.general.port).toBe(9300);
    expect(body.display.theme).toBe('light');
  });
});

// ── Test 6: Concurrent sessions ──────────────────────────────────────────────

describe('Integration Test 6 — Concurrent sessions', () => {
  beforeEach(async () => { await createTestServer(); });
  afterEach(async () => { await teardown(); });

  it('should correctly track multiple interleaved sessions independently', async () => {
    const filePath = path.join(eventsDir, 'concurrent.jsonl');
    const sessA = 'concurrent-a';
    const sessB = 'concurrent-b';
    const sessC = 'concurrent-c';
    const baseTime = Date.now();

    // Interleave events from three sessions
    const events: EventRecord[] = [
      // t+0: A starts
      makeEvent({
        id: 'cc-a-start',
        sessionId: sessA,
        type: 'SessionStart',
        tool: null,
        timestamp: new Date(baseTime).toISOString(),
        payload: { model: 'claude-sonnet-4' },
        project: 'project-alpha',
      }),
      // t+100: B starts
      makeEvent({
        id: 'cc-b-start',
        sessionId: sessB,
        type: 'SessionStart',
        tool: null,
        timestamp: new Date(baseTime + 100).toISOString(),
        payload: { model: 'claude-opus-4' },
        project: 'project-beta',
      }),
      // t+200: A gets a tool call
      makeEvent({
        id: 'cc-a-tool',
        sessionId: sessA,
        type: 'PostToolUse',
        tool: 'Read',
        timestamp: new Date(baseTime + 200).toISOString(),
        payload: { input: { file_path: '/a.ts' } },
        project: 'project-alpha',
      }),
      // t+300: C starts
      makeEvent({
        id: 'cc-c-start',
        sessionId: sessC,
        type: 'SessionStart',
        tool: null,
        timestamp: new Date(baseTime + 300).toISOString(),
        payload: {},
        project: 'project-gamma',
      }),
      // t+400: B gets a prompt
      makeEvent({
        id: 'cc-b-prompt',
        sessionId: sessB,
        type: 'UserPromptSubmit',
        tool: null,
        timestamp: new Date(baseTime + 400).toISOString(),
        payload: { message: 'fix the bug' },
        project: 'project-beta',
      }),
      // t+500: A completes
      makeEvent({
        id: 'cc-a-stop',
        sessionId: sessA,
        type: 'Stop',
        tool: null,
        timestamp: new Date(baseTime + 500).toISOString(),
        payload: {},
        project: 'project-alpha',
      }),
      // t+600: C gets error
      makeEvent({
        id: 'cc-c-fail',
        sessionId: sessC,
        type: 'PostToolUseFailure',
        tool: 'Bash',
        timestamp: new Date(baseTime + 600).toISOString(),
        payload: { error: 'command failed' },
        project: 'project-gamma',
      }),
      // t+700: B completes
      makeEvent({
        id: 'cc-b-stop',
        sessionId: sessB,
        type: 'Stop',
        tool: null,
        timestamp: new Date(baseTime + 700).toISOString(),
        payload: {},
        project: 'project-beta',
      }),
    ];

    writeJsonlFile(filePath, events);
    processAllFiles(db, eventsDir);

    // Verify all 3 sessions exist
    const listRes = await fastify.inject({ method: 'GET', url: '/api/sessions' });
    const listBody = JSON.parse(listRes.body);
    expect(listBody.total).toBe(3);

    // Session A: completed, project-alpha, model claude-sonnet-4
    const aRes = await fastify.inject({ method: 'GET', url: `/api/sessions/${sessA}` });
    const aBody = JSON.parse(aRes.body);
    expect(aBody.session.status).toBe('completed');
    expect(aBody.session.project).toBe('project-alpha');
    expect(aBody.session.model).toBe('claude-sonnet-4');

    // Session B: completed, project-beta, model claude-opus-4, 1 turn
    const bRes = await fastify.inject({ method: 'GET', url: `/api/sessions/${sessB}` });
    const bBody = JSON.parse(bRes.body);
    expect(bBody.session.status).toBe('completed');
    expect(bBody.session.project).toBe('project-beta');
    expect(bBody.session.model).toBe('claude-opus-4');
    expect(bBody.session.turnCount).toBe(1); // 1 UserPromptSubmit

    // Session C: running (not stopped), project-gamma, 1 error
    const cRes = await fastify.inject({ method: 'GET', url: `/api/sessions/${sessC}` });
    const cBody = JSON.parse(cRes.body);
    expect(cBody.session.status).toBe('running');
    expect(cBody.session.project).toBe('project-gamma');
    expect(cBody.session.errorCount).toBe(1);
  });

  it('should isolate events per session in detail endpoints', async () => {
    const filePath = path.join(eventsDir, 'concurrent-isolation.jsonl');
    const sessX = 'iso-x';
    const sessY = 'iso-y';

    const events: EventRecord[] = [
      makeEvent({
        id: 'iso-x-start',
        sessionId: sessX,
        type: 'SessionStart',
        tool: null,
        timestamp: new Date().toISOString(),
        payload: {},
      }),
      makeEvent({
        id: 'iso-y-start',
        sessionId: sessY,
        type: 'SessionStart',
        tool: null,
        timestamp: new Date(Date.now() + 100).toISOString(),
        payload: {},
      }),
      makeEvent({
        id: 'iso-x-evt1',
        sessionId: sessX,
        type: 'PostToolUse',
        tool: 'Bash',
        timestamp: new Date(Date.now() + 200).toISOString(),
        payload: {},
      }),
      makeEvent({
        id: 'iso-x-evt2',
        sessionId: sessX,
        type: 'PostToolUse',
        tool: 'Bash',
        timestamp: new Date(Date.now() + 300).toISOString(),
        payload: {},
      }),
      makeEvent({
        id: 'iso-y-evt1',
        sessionId: sessY,
        type: 'PostToolUse',
        tool: 'Read',
        timestamp: new Date(Date.now() + 400).toISOString(),
        payload: {},
      }),
    ];

    writeJsonlFile(filePath, events);
    processAllFiles(db, eventsDir);

    // X should have 3 events (start + 2 tool), Y should have 2 events (start + 1 tool)
    const xEventsRes = await fastify.inject({ method: 'GET', url: `/api/sessions/${sessX}/events` });
    const xBody = JSON.parse(xEventsRes.body);
    expect(xBody.total).toBe(3);

    const yEventsRes = await fastify.inject({ method: 'GET', url: `/api/sessions/${sessY}/events` });
    const yBody = JSON.parse(yEventsRes.body);
    expect(yBody.total).toBe(2);
  });
});

// ── Test 7: Error categorization through pipeline ────────────────────────────

describe('Integration Test 7 — Error categorization through pipeline', () => {
  beforeEach(async () => { await createTestServer(); });
  afterEach(async () => { await teardown(); });

  it('should return PostToolUseFailure events via analytics errors endpoint', async () => {
    const filePath = path.join(eventsDir, 'error-cat.jsonl');
    const sessionId = 'errcat-sess-1';

    const events: EventRecord[] = [
      makeEvent({
        id: 'ec-start',
        sessionId,
        type: 'SessionStart',
        tool: null,
        timestamp: new Date().toISOString(),
        payload: {},
        project: 'error-project',
      }),
      makeEvent({
        id: 'ec-fail-1',
        sessionId,
        type: 'PostToolUseFailure',
        tool: 'Edit',
        timestamp: new Date(Date.now() + 100).toISOString(),
        payload: { error: 'old_string not unique in file' },
        project: 'error-project',
      }),
      makeEvent({
        id: 'ec-fail-2',
        sessionId,
        type: 'PostToolUseFailure',
        tool: 'Bash',
        timestamp: new Date(Date.now() + 200).toISOString(),
        payload: { error: 'command exited with code 1' },
        project: 'error-project',
      }),
      makeEvent({
        id: 'ec-success',
        sessionId,
        type: 'PostToolUse',
        tool: 'Read',
        timestamp: new Date(Date.now() + 300).toISOString(),
        payload: {},
        project: 'error-project',
      }),
    ];

    writeJsonlFile(filePath, events);
    processAllFiles(db, eventsDir);

    // Verify errors endpoint returns only PostToolUseFailure events
    const res = await fastify.inject({ method: 'GET', url: '/api/analytics/errors' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(2);
    expect(body.errors).toHaveLength(2);

    // Each error should be categorized as tool_failure (PostToolUseFailure default)
    for (const err of body.errors) {
      expect(err.category).toBe('tool_failure');
      expect(err.sessionId).toBe(sessionId);
      expect(err.project).toBe('error-project');
    }

    // Verify the tool names are present
    const tools = body.errors.map((e: { toolName: string }) => e.toolName);
    expect(tools).toContain('Edit');
    expect(tools).toContain('Bash');
  });

  it('should filter errors by session via query param', async () => {
    const filePath = path.join(eventsDir, 'error-filter.jsonl');
    const sessA = 'errfilt-a';
    const sessB = 'errfilt-b';

    const events: EventRecord[] = [
      makeEvent({
        id: 'ef-a-start',
        sessionId: sessA,
        type: 'SessionStart',
        tool: null,
        timestamp: new Date().toISOString(),
        payload: {},
      }),
      makeEvent({
        id: 'ef-b-start',
        sessionId: sessB,
        type: 'SessionStart',
        tool: null,
        timestamp: new Date(Date.now() + 50).toISOString(),
        payload: {},
      }),
      makeEvent({
        id: 'ef-a-fail',
        sessionId: sessA,
        type: 'PostToolUseFailure',
        tool: 'Edit',
        timestamp: new Date(Date.now() + 100).toISOString(),
        payload: { error: 'a error' },
      }),
      makeEvent({
        id: 'ef-b-fail',
        sessionId: sessB,
        type: 'PostToolUseFailure',
        tool: 'Bash',
        timestamp: new Date(Date.now() + 200).toISOString(),
        payload: { error: 'b error' },
      }),
    ];

    writeJsonlFile(filePath, events);
    processAllFiles(db, eventsDir);

    const res = await fastify.inject({ method: 'GET', url: `/api/analytics/errors?session=${sessA}` });
    const body = JSON.parse(res.body);
    expect(body.total).toBe(1);
    expect(body.errors[0].sessionId).toBe(sessA);
  });
});

// ── Test 8: Graceful shutdown ────────────────────────────────────────────────

describe('Integration Test 8 — Graceful shutdown', () => {
  it('should shut down Storage without errors', async () => {
    const localTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-shutdown-'));
    const dbPath = path.join(localTmpDir, 'shutdown-test.db');
    const storage = new Storage(dbPath);
    await storage.init();

    // Verify DB is functional
    const testDb = storage.getDb();
    expect(testDb).toBeTruthy();

    // Start periodic flush, then shutdown
    storage.startPeriodicFlush(5000);
    await expect(storage.shutdown()).resolves.toBeUndefined();

    // DB should be closed (getDb throws)
    expect(() => storage.getDb()).toThrow('Database not initialized');

    fs.rmSync(localTmpDir, { recursive: true, force: true });
  });

  it('should shut down Ingester without errors', async () => {
    const localTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-shutdown-ingester-'));
    const localEventsDir = path.join(localTmpDir, 'events');
    fs.mkdirSync(localEventsDir, { recursive: true });

    const dbPath = path.join(localTmpDir, 'shutdown-ingester-test.db');
    const storage = new Storage(dbPath);
    await storage.init();
    const testDb = storage.getDb();

    const ingester = new Ingester(testDb, localEventsDir, {
      batchIntervalMs: 60000, // Long interval to avoid triggering during test
      batchSize: 100,
      staleTimeoutMinutes: 60,
    });

    // Shutdown should complete without throwing
    await expect(ingester.shutdown()).resolves.toBeUndefined();

    await storage.shutdown();
    fs.rmSync(localTmpDir, { recursive: true, force: true });
  });

  it('should perform final processing pass on ingester shutdown', async () => {
    const localTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-shutdown-final-'));
    const localEventsDir = path.join(localTmpDir, 'events');
    fs.mkdirSync(localEventsDir, { recursive: true });

    const dbPath = path.join(localTmpDir, 'shutdown-final.db');
    const storage = new Storage(dbPath);
    await storage.init();
    const testDb = storage.getDb();

    const ingester = new Ingester(testDb, localEventsDir, {
      batchIntervalMs: 600000, // Very long — won't trigger during test
      batchSize: 100,
      staleTimeoutMinutes: 60,
    });

    // Write events AFTER creating the ingester (simulating late-arriving events)
    const filePath = path.join(localEventsDir, 'late-events.jsonl');
    const event = makeEvent({
      id: 'shutdown-evt-1',
      sessionId: 'shutdown-sess',
      type: 'PostToolUse',
      tool: 'Read',
    });
    writeJsonlFile(filePath, [event]);

    // Shutdown should run a final processAllFiles pass
    await ingester.shutdown();

    // Verify the event was ingested during the shutdown pass
    const result = testDb.exec("SELECT COUNT(*) FROM events WHERE event_id = 'shutdown-evt-1';");
    const count = result.length > 0 ? result[0].values[0][0] as number : 0;
    expect(count).toBe(1);

    // Verify the session was created
    const sessResult = testDb.exec("SELECT status FROM sessions WHERE session_id = 'shutdown-sess';");
    expect(sessResult.length).toBe(1);
    expect(sessResult[0].values[0][0]).toBe('running');

    await storage.shutdown();
    fs.rmSync(localTmpDir, { recursive: true, force: true });
  });
});
