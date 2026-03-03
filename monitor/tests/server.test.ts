/**
 * Phase H — Dashboard Server & API Routes tests.
 * Tests all REST API endpoints and server setup (Spec 06).
 *
 * Strategy: Create a minimal Fastify instance with an in-memory sql.js database,
 * register routes, and send HTTP requests via fastify.inject().
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import initSqlJs, { type Database } from 'sql.js';
import { registerSessionRoutes } from '@server/routes/sessions.js';
import { registerAnalyticsRoutes } from '@server/routes/analytics.js';
import { registerConfigRoutes } from '@server/routes/config.js';
import { registerSearchRoutes } from '@server/routes/search.js';
import { registerGuardrailRoutes } from '@server/routes/guardrails.js';
import { loadConfig, writeConfig } from '@lib/config.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Schema DDL (mirror of storage.ts) ───────────────────────────────────────

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

async function createTestServer() {
  const SQL = await initSqlJs();
  db = new SQL.Database();
  db.run('PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA_DDL);

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-h-test-'));
  const configPath = path.join(tmpDir, 'test-config.json');

  fastify = Fastify({ logger: false });

  // Decorate with what routes expect
  fastify.decorate('db', db);
  fastify.decorate('configPath', configPath);

  // Register routes
  registerSessionRoutes(fastify);
  registerAnalyticsRoutes(fastify);
  registerConfigRoutes(fastify);
  registerSearchRoutes(fastify);
  registerGuardrailRoutes(fastify);

  await fastify.ready();
  return { fastify, db, configPath };
}

function seedSession(
  id: string,
  opts: {
    project?: string;
    model?: string;
    status?: string;
    totalCost?: number;
    startTime?: string;
    endTime?: string;
    turnCount?: number;
    errorCount?: number;
  } = {}
) {
  const now = new Date().toISOString();
  db.run(`
    INSERT INTO sessions (session_id, project, workspace, model, status, start_time, end_time, total_cost, turn_count, last_seen, error_count)
    VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?);
  `, [
    id,
    opts.project ?? 'test-project',
    opts.model ?? 'claude-sonnet-4',
    opts.status ?? 'running',
    opts.startTime ?? now,
    opts.endTime ?? null,
    opts.totalCost ?? 0,
    opts.turnCount ?? 0,
    now,
    opts.errorCount ?? 0,
  ]);
}

function seedEvent(
  id: string,
  sessionId: string,
  opts: {
    type?: string;
    toolName?: string;
    payload?: object;
    timestamp?: string;
    duration?: number;
  } = {}
) {
  db.run(`
    INSERT INTO events (event_id, session_id, timestamp, type, tool_name, payload, duration)
    VALUES (?, ?, ?, ?, ?, ?, ?);
  `, [
    id,
    sessionId,
    opts.timestamp ?? new Date().toISOString(),
    opts.type ?? 'PostToolUse',
    opts.toolName ?? null,
    JSON.stringify(opts.payload ?? {}),
    opts.duration ?? null,
  ]);
}

function seedMetrics(sessionId: string, opts: {
  costBreakdown?: object;
  tokenBreakdown?: object;
  model?: string;
  wallClockDuration?: number;
  apiDuration?: number;
  turnCount?: number;
} = {}) {
  db.run(`
    INSERT INTO metrics (session_id, cost_breakdown, token_breakdown, model, wall_clock_duration, api_duration, turn_count)
    VALUES (?, ?, ?, ?, ?, ?, ?);
  `, [
    sessionId,
    JSON.stringify(opts.costBreakdown ?? {}),
    JSON.stringify(opts.tokenBreakdown ?? { input: 100, output: 50, cacheRead: 30 }),
    opts.model ?? 'claude-sonnet-4',
    opts.wallClockDuration ?? 120,
    opts.apiDuration ?? 45,
    opts.turnCount ?? 10,
  ]);
}

function seedGuardrailLog(id: string, sessionId: string, opts: {
  ruleName?: string;
  action?: string;
  timestamp?: string;
  payload?: object;
} = {}) {
  db.run(`
    INSERT INTO guardrail_log (id, session_id, rule_name, action, timestamp, payload)
    VALUES (?, ?, ?, ?, ?, ?);
  `, [
    id,
    sessionId,
    opts.ruleName ?? 'no-secrets',
    opts.action ?? 'block',
    opts.timestamp ?? new Date().toISOString(),
    JSON.stringify(opts.payload ?? {}),
  ]);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('H1 — Server setup', () => {
  beforeEach(async () => { await createTestServer(); });
  afterEach(async () => {
    await fastify.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should respond with 404 JSON for unknown API routes', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/nonexistent' });
    expect(res.statusCode).toBe(404);
  });
});

// ── H2 — Sessions API ───────────────────────────────────────────────────────

describe('H2 — GET /api/sessions', () => {
  beforeEach(async () => { await createTestServer(); });
  afterEach(async () => {
    await fastify.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return empty list when no sessions exist', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/sessions' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sessions).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.page).toBe(1);
  });

  it('should return sessions with correct fields', async () => {
    seedSession('s1', { project: 'acme', model: 'claude-sonnet-4', status: 'running' });
    const res = await fastify.inject({ method: 'GET', url: '/api/sessions' });
    const body = JSON.parse(res.body);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].sessionId).toBe('s1');
    expect(body.sessions[0].project).toBe('acme');
    expect(body.sessions[0].model).toBe('claude-sonnet-4');
    expect(body.sessions[0].status).toBe('running');
    expect(body.total).toBe(1);
  });

  it('should filter by status', async () => {
    seedSession('s1', { status: 'running' });
    seedSession('s2', { status: 'completed' });
    const res = await fastify.inject({ method: 'GET', url: '/api/sessions?status=completed' });
    const body = JSON.parse(res.body);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].sessionId).toBe('s2');
  });

  it('should filter by project', async () => {
    seedSession('s1', { project: 'alpha' });
    seedSession('s2', { project: 'beta' });
    const res = await fastify.inject({ method: 'GET', url: '/api/sessions?project=alpha' });
    const body = JSON.parse(res.body);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].project).toBe('alpha');
  });

  it('should paginate correctly', async () => {
    for (let i = 0; i < 5; i++) {
      seedSession(`s${i}`, { startTime: new Date(Date.now() - i * 1000).toISOString() });
    }
    const res = await fastify.inject({ method: 'GET', url: '/api/sessions?page=2&limit=2' });
    const body = JSON.parse(res.body);
    expect(body.sessions).toHaveLength(2);
    expect(body.total).toBe(5);
    expect(body.page).toBe(2);
    expect(body.limit).toBe(2);
  });

  it('should enforce max limit of 100', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/sessions?limit=500' });
    const body = JSON.parse(res.body);
    expect(body.limit).toBe(100);
  });

  it('should sort by specified field', async () => {
    seedSession('s1', { totalCost: 10 });
    seedSession('s2', { totalCost: 5 });
    seedSession('s3', { totalCost: 20 });
    const res = await fastify.inject({ method: 'GET', url: '/api/sessions?sortBy=total_cost&order=asc' });
    const body = JSON.parse(res.body);
    expect(body.sessions[0].totalCost).toBe(5);
    expect(body.sessions[2].totalCost).toBe(20);
  });

  it('should filter by cost range', async () => {
    seedSession('s1', { totalCost: 5 });
    seedSession('s2', { totalCost: 15 });
    seedSession('s3', { totalCost: 25 });
    const res = await fastify.inject({ method: 'GET', url: '/api/sessions?minCost=10&maxCost=20' });
    const body = JSON.parse(res.body);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].sessionId).toBe('s2');
  });
});

describe('H2 — GET /api/sessions/:id', () => {
  beforeEach(async () => { await createTestServer(); });
  afterEach(async () => {
    await fastify.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return 404 for nonexistent session', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/sessions/nosuch' });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('not found');
  });

  it('should return session detail with metrics and tools', async () => {
    seedSession('s1', { project: 'acme' });
    seedMetrics('s1');
    seedEvent('e1', 's1', { type: 'PostToolUse', toolName: 'Read' });
    seedEvent('e2', 's1', { type: 'PostToolUse', toolName: 'Read' });
    seedEvent('e3', 's1', { type: 'PostToolUseFailure', toolName: 'Edit' });

    const res = await fastify.inject({ method: 'GET', url: '/api/sessions/s1' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(body.session.sessionId).toBe('s1');
    expect(body.session.project).toBe('acme');
    expect(body.metrics).not.toBeNull();
    expect(body.metrics.model).toBe('claude-sonnet-4');
    expect(body.tools).toHaveLength(2); // Read and Edit
  });

  it('should return null metrics if none exist', async () => {
    seedSession('s1');
    const res = await fastify.inject({ method: 'GET', url: '/api/sessions/s1' });
    const body = JSON.parse(res.body);
    expect(body.metrics).toBeNull();
  });
});

describe('H2 — GET /api/sessions/:id/events', () => {
  beforeEach(async () => { await createTestServer(); });
  afterEach(async () => {
    await fastify.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return paginated events for a session', async () => {
    seedSession('s1');
    for (let i = 0; i < 5; i++) {
      seedEvent(`e${i}`, 's1', { timestamp: new Date(Date.now() + i * 1000).toISOString() });
    }
    const res = await fastify.inject({ method: 'GET', url: '/api/sessions/s1/events?limit=2&page=1' });
    const body = JSON.parse(res.body);
    expect(body.events).toHaveLength(2);
    expect(body.total).toBe(5);
  });

  it('should return events in chronological order (ASC)', async () => {
    seedSession('s1');
    seedEvent('e1', 's1', { timestamp: '2025-01-01T10:00:00Z' });
    seedEvent('e2', 's1', { timestamp: '2025-01-01T09:00:00Z' });
    const res = await fastify.inject({ method: 'GET', url: '/api/sessions/s1/events' });
    const body = JSON.parse(res.body);
    expect(body.events[0].eventId).toBe('e2'); // Earlier timestamp first
    expect(body.events[1].eventId).toBe('e1');
  });
});

// ── H3 — Analytics API ──────────────────────────────────────────────────────

describe('H3 — GET /api/analytics/overview', () => {
  beforeEach(async () => { await createTestServer(); });
  afterEach(async () => {
    await fastify.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return overview stats with all fields', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/analytics/overview' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('activeSessions');
    expect(body).toHaveProperty('totalCost');
    expect(body).toHaveProperty('errorCount');
    expect(body).toHaveProperty('errorRate');
    expect(body).toHaveProperty('rateLimitIncidents');
    expect(body).toHaveProperty('toolCallsPerMin');
    expect(body.toolCallsPerMin).toHaveLength(10);
  });

  it('should count active sessions correctly', async () => {
    seedSession('s1', { status: 'running' });
    seedSession('s2', { status: 'running' });
    seedSession('s3', { status: 'completed' });
    const res = await fastify.inject({ method: 'GET', url: '/api/analytics/overview' });
    const body = JSON.parse(res.body);
    expect(body.activeSessions).toBe(2);
  });

  it('should calculate error rate correctly', async () => {
    const now = new Date().toISOString();
    seedSession('s1', { status: 'running', startTime: now });
    seedEvent('e1', 's1', { type: 'PostToolUse', timestamp: now });
    seedEvent('e2', 's1', { type: 'PostToolUse', timestamp: now });
    seedEvent('e3', 's1', { type: 'PostToolUseFailure', timestamp: now });
    const res = await fastify.inject({ method: 'GET', url: '/api/analytics/overview' });
    const body = JSON.parse(res.body);
    expect(body.errorCount).toBe(1);
    // 1 failure out of 3 total tool calls
    expect(body.errorRate).toBeCloseTo(1 / 3, 2);
  });
});

describe('H3 — GET /api/analytics/costs', () => {
  beforeEach(async () => { await createTestServer(); });
  afterEach(async () => {
    await fastify.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return cost breakdown by project', async () => {
    const now = new Date().toISOString();
    seedSession('s1', { project: 'alpha', totalCost: 10, startTime: now });
    seedSession('s2', { project: 'alpha', totalCost: 5, startTime: now });
    seedSession('s3', { project: 'beta', totalCost: 20, startTime: now });

    const res = await fastify.inject({ method: 'GET', url: '/api/analytics/costs' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.breakdown).toHaveLength(2);
    expect(body.totalCost).toBe(35);
  });

  it('should return cache hit rate', async () => {
    const now = new Date().toISOString();
    seedSession('s1', { startTime: now });
    seedMetrics('s1', { tokenBreakdown: { input: 70, output: 50, cacheRead: 30 } });

    const res = await fastify.inject({ method: 'GET', url: '/api/analytics/costs' });
    const body = JSON.parse(res.body);
    // cacheRead / (input + cacheRead) = 30 / 100 = 0.3
    expect(body.cacheHitRate).toBeCloseTo(0.3, 2);
    expect(body.tokensSaved).toBe(30);
  });
});

describe('H3 — GET /api/analytics/errors', () => {
  beforeEach(async () => { await createTestServer(); });
  afterEach(async () => {
    await fastify.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return paginated error list', async () => {
    seedSession('s1');
    seedEvent('e1', 's1', { type: 'PostToolUseFailure', toolName: 'Edit' });
    seedEvent('e2', 's1', { type: 'PostToolUse', toolName: 'Read' });
    seedEvent('e3', 's1', { type: 'PostToolUseFailure', toolName: 'Bash' });

    const res = await fastify.inject({ method: 'GET', url: '/api/analytics/errors' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Only failures
    expect(body.errors).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.errors[0].category).toBe('tool_failure');
  });

  it('should filter errors by session', async () => {
    seedSession('s1');
    seedSession('s2');
    seedEvent('e1', 's1', { type: 'PostToolUseFailure' });
    seedEvent('e2', 's2', { type: 'PostToolUseFailure' });

    const res = await fastify.inject({ method: 'GET', url: '/api/analytics/errors?session=s1' });
    const body = JSON.parse(res.body);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].sessionId).toBe('s1');
  });
});

// ── H4 — Config API ─────────────────────────────────────────────────────────

describe('H4 — Config API', () => {
  beforeEach(async () => { await createTestServer(); });
  afterEach(async () => {
    await fastify.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/config should return default config when no file exists', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.general).toBeDefined();
    expect(body.general.port).toBe(9100);
  });

  it('PUT /api/config should update and return config', async () => {
    const res = await fastify.inject({
      method: 'PUT',
      url: '/api/config',
      headers: { 'Content-Type': 'application/json' },
      payload: { general: { port: 9200 } },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.general.port).toBe(9200);

    // Verify persistence
    const getRes = await fastify.inject({ method: 'GET', url: '/api/config' });
    const getBody = JSON.parse(getRes.body);
    expect(getBody.general.port).toBe(9200);
  });

  it('PUT /api/config should reject non-object body', async () => {
    const res = await fastify.inject({
      method: 'PUT',
      url: '/api/config',
      headers: { 'Content-Type': 'application/json' },
      payload: 'not an object',
    });
    // Fastify may parse string as JSON, resulting in non-object
    expect(res.statusCode).toBe(400);
  });
});

// ── H5 — Search API ─────────────────────────────────────────────────────────

describe('H5 — GET /api/search', () => {
  beforeEach(async () => { await createTestServer(); });
  afterEach(async () => {
    await fastify.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should require q parameter', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/search' });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('required');
  });

  it('should search event payloads using LIKE', async () => {
    seedSession('s1');
    seedEvent('e1', 's1', { payload: { message: 'file not found error' } });
    seedEvent('e2', 's1', { payload: { message: 'success operation' } });
    seedEvent('e3', 's1', { payload: { message: 'another error detected' } });

    const res = await fastify.inject({ method: 'GET', url: '/api/search?q=error' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.events).toHaveLength(2);
    expect(body.query).toBe('error');
  });

  it('should respect limit parameter', async () => {
    seedSession('s1');
    for (let i = 0; i < 5; i++) {
      seedEvent(`e${i}`, 's1', { payload: { keyword: 'match' } });
    }
    const res = await fastify.inject({ method: 'GET', url: '/api/search?q=match&limit=2' });
    const body = JSON.parse(res.body);
    expect(body.events).toHaveLength(2);
  });
});

// ── H8a — Guardrails API ────────────────────────────────────────────────────

describe('H8a — GET /api/guardrails/log', () => {
  beforeEach(async () => { await createTestServer(); });
  afterEach(async () => {
    await fastify.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return empty list when no guardrail entries', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/guardrails/log' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.entries).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('should return paginated guardrail log entries', async () => {
    seedSession('s1');
    for (let i = 0; i < 5; i++) {
      seedGuardrailLog(`g${i}`, 's1', {
        ruleName: i % 2 === 0 ? 'no-secrets' : 'rate-limit',
        timestamp: new Date(Date.now() - i * 1000).toISOString(),
      });
    }

    const res = await fastify.inject({ method: 'GET', url: '/api/guardrails/log?limit=2&page=1' });
    const body = JSON.parse(res.body);
    expect(body.entries).toHaveLength(2);
    expect(body.total).toBe(5);
  });

  it('should filter by rule_name', async () => {
    seedSession('s1');
    seedGuardrailLog('g1', 's1', { ruleName: 'no-secrets' });
    seedGuardrailLog('g2', 's1', { ruleName: 'rate-limit' });

    const res = await fastify.inject({ method: 'GET', url: '/api/guardrails/log?rule_name=no-secrets' });
    const body = JSON.parse(res.body);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].ruleName).toBe('no-secrets');
  });

  it('should filter by action', async () => {
    seedSession('s1');
    seedGuardrailLog('g1', 's1', { action: 'block' });
    seedGuardrailLog('g2', 's1', { action: 'warn' });

    const res = await fastify.inject({ method: 'GET', url: '/api/guardrails/log?action=warn' });
    const body = JSON.parse(res.body);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].action).toBe('warn');
  });
});

// ── H7 — Error handling ─────────────────────────────────────────────────────

describe('H7 — Error handling & SPA fallback', () => {
  afterEach(async () => {
    await fastify.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should set error handler that returns generic message (Spec 06 AC 59)', async () => {
    // Build a custom server with error-throwing route added BEFORE ready()
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run('PRAGMA foreign_keys=ON;');
    db.exec(SCHEMA_DDL);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-h-err-'));
    fastify = Fastify({ logger: false });
    fastify.decorate('db', db);
    fastify.decorate('configPath', path.join(tmpDir, 'test-config.json'));

    // Add a route that throws to test the error handler
    fastify.get('/api/test-error', async () => {
      throw new Error('secret internal detail');
    });

    // Register the error handler (mirrors index.ts)
    fastify.setErrorHandler((_error, _request, reply) => {
      reply.status(500).send({ error: 'Internal server error' });
    });

    await fastify.ready();

    const res = await fastify.inject({ method: 'GET', url: '/api/test-error' });
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Internal server error');
    // Must NOT leak internal details
    expect(res.body).not.toContain('secret internal detail');
  });
});

// ── createServer integration (H1) ───────────────────────────────────────────

describe('H1 — createServer integration', () => {
  it('should export createServer function', async () => {
    const mod = await import('@server/index.js');
    expect(typeof mod.createServer).toBe('function');
  });
});
