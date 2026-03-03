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
    error_count INTEGER NOT NULL DEFAULT 0,
    agent_name TEXT
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
  const config = loadConfig(configPath);
  fastify.decorate('db', db);
  fastify.decorate('config', config);
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
    expect(body.data).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.page).toBe(1);
  });

  it('should return sessions with correct fields', async () => {
    seedSession('s1', { project: 'acme', model: 'claude-sonnet-4', status: 'running' });
    const res = await fastify.inject({ method: 'GET', url: '/api/sessions' });
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].sessionId).toBe('s1');
    expect(body.data[0].project).toBe('acme');
    expect(body.data[0].model).toBe('claude-sonnet-4');
    expect(body.data[0].status).toBe('running');
    expect(body.total).toBe(1);
  });

  it('should filter by status', async () => {
    seedSession('s1', { status: 'running' });
    seedSession('s2', { status: 'completed' });
    const res = await fastify.inject({ method: 'GET', url: '/api/sessions?status=completed' });
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].sessionId).toBe('s2');
  });

  it('should filter by project', async () => {
    seedSession('s1', { project: 'alpha' });
    seedSession('s2', { project: 'beta' });
    const res = await fastify.inject({ method: 'GET', url: '/api/sessions?project=alpha' });
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].project).toBe('alpha');
  });

  it('should paginate correctly', async () => {
    for (let i = 0; i < 5; i++) {
      seedSession(`s${i}`, { startTime: new Date(Date.now() - i * 1000).toISOString() });
    }
    const res = await fastify.inject({ method: 'GET', url: '/api/sessions?page=2&limit=2' });
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(2);
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
    expect(body.data[0].totalCost).toBe(5);
    expect(body.data[2].totalCost).toBe(20);
  });

  it('should filter by cost range', async () => {
    seedSession('s1', { totalCost: 5 });
    seedSession('s2', { totalCost: 15 });
    seedSession('s3', { totalCost: 25 });
    const res = await fastify.inject({ method: 'GET', url: '/api/sessions?minCost=10&maxCost=20' });
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].sessionId).toBe('s2');
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
    expect(body.data).toHaveLength(2);
    expect(body.total).toBe(5);
  });

  it('should return events in chronological order (ASC)', async () => {
    seedSession('s1');
    seedEvent('e1', 's1', { timestamp: '2025-01-01T10:00:00Z' });
    seedEvent('e2', 's1', { timestamp: '2025-01-01T09:00:00Z' });
    const res = await fastify.inject({ method: 'GET', url: '/api/sessions/s1/events' });
    const body = JSON.parse(res.body);
    expect(body.data[0].id).toBe('e2'); // Earlier timestamp first
    expect(body.data[1].id).toBe('e1');
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
    expect(body).toHaveProperty('totalSessions');
    expect(body).toHaveProperty('totalCost');
    expect(body).toHaveProperty('totalTokens');
    expect(body).toHaveProperty('totalErrors');
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
    expect(body.totalErrors).toBe(1);
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
    expect(body.data).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.data[0].category).toBe('tool_failure');
  });

  it('should filter errors by session', async () => {
    seedSession('s1');
    seedSession('s2');
    seedEvent('e1', 's1', { type: 'PostToolUseFailure' });
    seedEvent('e2', 's2', { type: 'PostToolUseFailure' });

    const res = await fastify.inject({ method: 'GET', url: '/api/analytics/errors?session=s1' });
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].sessionId).toBe('s1');
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

  it('PATCH /api/config should update and return config (client compatibility)', async () => {
    const res = await fastify.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: { 'Content-Type': 'application/json' },
      payload: { display: { theme: 'light' } },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.display.theme).toBe('light');

    // Verify persistence via GET
    const getRes = await fastify.inject({ method: 'GET', url: '/api/config' });
    const getBody = JSON.parse(getRes.body);
    expect(getBody.display.theme).toBe('light');
  });

  it('PATCH /api/config should reject non-object body', async () => {
    const res = await fastify.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: { 'Content-Type': 'application/json' },
      payload: 'not an object',
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/config should include default guardrail rules (Spec 14 AC 16-18)', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(body.guardrails).toBeDefined();
    expect(body.guardrails.dangerous_command_blocker).toBeDefined();
    expect(body.guardrails.dangerous_command_blocker.mode).toBe('block');
    expect(body.guardrails.sensitive_file_blocker).toBeDefined();
    expect(body.guardrails.sensitive_file_blocker.mode).toBe('block');
    expect(body.guardrails.cost_guardrail).toBeDefined();
    expect(body.guardrails.cost_guardrail.mode).toBe('warn');
    expect(body.guardrails.long_chain_detection.mode).toBe('warn');
    expect(body.guardrails.rate_limit_throttle.mode).toBe('warn');
    expect(body.guardrails.quality_gate.mode).toBe('warn');
  });

  it('PATCH /api/config should update guardrail modes', async () => {
    const res = await fastify.inject({
      method: 'PATCH',
      url: '/api/config',
      headers: { 'Content-Type': 'application/json' },
      payload: {
        guardrails: {
          dangerous_command_blocker: { mode: 'warn' },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.guardrails.dangerous_command_blocker.mode).toBe('warn');
  });
});

// ── Data Purge API ───────────────────────────────────────────────────────────

describe('S3 — POST /api/data/purge', () => {
  beforeEach(async () => { await createTestServer(); });
  afterEach(async () => {
    await fastify.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should purge data older than retention period (Spec 14 AC 36)', async () => {
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago
    const newDate = new Date().toISOString();

    // Seed old session + events
    seedSession('old-session', { startTime: oldDate, status: 'completed', endTime: oldDate });
    seedEvent('old-event', 'old-session', { timestamp: oldDate });

    // Seed new session + events
    seedSession('new-session', { startTime: newDate });
    seedEvent('new-event', 'new-session', { timestamp: newDate });

    const res = await fastify.inject({ method: 'POST', url: '/api/data/purge' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.retentionDays).toBe(30); // default

    // Old data should be purged
    const sessionsRes = await fastify.inject({ method: 'GET', url: '/api/sessions' });
    const sessionsBody = JSON.parse(sessionsRes.body);
    expect(sessionsBody.data).toHaveLength(1);
    expect(sessionsBody.data[0].sessionId).toBe('new-session');
  });

  it('should not purge data within retention period', async () => {
    const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days ago
    seedSession('recent-session', { startTime: recentDate });
    seedEvent('recent-event', 'recent-session', { timestamp: recentDate });

    const res = await fastify.inject({ method: 'POST', url: '/api/data/purge' });
    expect(res.statusCode).toBe(200);

    const sessionsRes = await fastify.inject({ method: 'GET', url: '/api/sessions' });
    const sessionsBody = JSON.parse(sessionsRes.body);
    expect(sessionsBody.data).toHaveLength(1);
  });

  it('should purge orphaned metrics when sessions are purged', async () => {
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    seedSession('old-session', { startTime: oldDate, status: 'completed', endTime: oldDate });
    seedMetrics('old-session');

    const res = await fastify.inject({ method: 'POST', url: '/api/data/purge' });
    expect(res.statusCode).toBe(200);

    // Verify metrics are also purged
    const metricsResult = db.exec("SELECT COUNT(*) as cnt FROM metrics");
    expect(metricsResult[0].values[0][0]).toBe(0);
  });

  it('should return cutoff date in response', async () => {
    const res = await fastify.inject({ method: 'POST', url: '/api/data/purge' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.cutoffDate).toBeDefined();
    expect(new Date(body.cutoffDate).getTime()).toBeLessThan(Date.now());
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

// ── S14 — Agent Name Column ──────────────────────────────────────────────────

describe('S14 — Agent name in sessions', () => {
  beforeEach(async () => { await createTestServer(); });
  afterEach(async () => {
    await fastify.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should include agentName field in session list response', async () => {
    db.run(`
      INSERT INTO sessions (session_id, project, workspace, model, status, start_time, last_seen, agent_name)
      VALUES ('s-agent', 'test-project', '/home/user/my-app', 'claude-sonnet-4', 'running', ?, ?, 'my-app');
    `, [new Date().toISOString(), new Date().toISOString()]);

    const res = await fastify.inject({ method: 'GET', url: '/api/sessions' });
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].agentName).toBe('my-app');
  });

  it('should include agentName in session detail response', async () => {
    db.run(`
      INSERT INTO sessions (session_id, project, workspace, model, status, start_time, last_seen, agent_name)
      VALUES ('s-agent-detail', 'test-project', '/work/cool-project', 'claude-sonnet-4', 'running', ?, ?, 'cool-project');
    `, [new Date().toISOString(), new Date().toISOString()]);

    const res = await fastify.inject({ method: 'GET', url: '/api/sessions/s-agent-detail' });
    const body = JSON.parse(res.body);
    expect(body.session.agentName).toBe('cool-project');
  });

  it('should handle null agentName gracefully', async () => {
    seedSession('s-no-agent');

    const res = await fastify.inject({ method: 'GET', url: '/api/sessions' });
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].agentName).toBeNull();
  });
});

// ── S8 — Full-Text Search on Sessions Page ───────────────────────────────────

describe('S8 — GET /api/sessions?search=', () => {
  beforeEach(async () => { await createTestServer(); });
  afterEach(async () => {
    await fastify.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should filter sessions by search term in event payloads (Spec 11 AC 21)', async () => {
    seedSession('s-search-1', { project: 'alpha' });
    seedSession('s-search-2', { project: 'beta' });
    seedEvent('e-s1-1', 's-search-1', { payload: { input: { command: 'npm test authentication' } } });
    seedEvent('e-s2-1', 's-search-2', { payload: { input: { command: 'npm run build' } } });

    const res = await fastify.inject({ method: 'GET', url: '/api/sessions?search=authentication' });
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].sessionId).toBe('s-search-1');
  });

  it('should combine search with other filters (Spec 11 AC 23)', async () => {
    seedSession('s-combo-1', { project: 'alpha', status: 'running' });
    seedSession('s-combo-2', { project: 'alpha', status: 'completed' });
    seedEvent('e-c1-1', 's-combo-1', { payload: { message: 'keyword found here' } });
    seedEvent('e-c2-1', 's-combo-2', { payload: { message: 'keyword found there' } });

    const res = await fastify.inject({
      method: 'GET',
      url: '/api/sessions?search=keyword&status=running',
    });
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].sessionId).toBe('s-combo-1');
  });

  it('should return empty list when search matches no events (Spec 11 AC 25)', async () => {
    seedSession('s-noresult');
    seedEvent('e-nr-1', 's-noresult', { payload: { message: 'hello world' } });

    const res = await fastify.inject({ method: 'GET', url: '/api/sessions?search=zyxnonexistent' });
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it('should return all sessions when search is empty (Spec 11 AC 25)', async () => {
    seedSession('s-all-1');
    seedSession('s-all-2');

    const res = await fastify.inject({ method: 'GET', url: '/api/sessions?search=' });
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(2);
  });
});

// ── S13 — Sessions Filters Endpoint ──────────────────────────────────────────

describe('S13 — GET /api/sessions/filters', () => {
  beforeEach(async () => { await createTestServer(); });
  afterEach(async () => {
    await fastify.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return distinct projects and models (Spec 11 AC 15)', async () => {
    seedSession('s-f1', { project: 'alpha', model: 'claude-sonnet-4' });
    seedSession('s-f2', { project: 'beta', model: 'claude-opus-4' });
    seedSession('s-f3', { project: 'alpha', model: 'claude-sonnet-4' });

    const res = await fastify.inject({ method: 'GET', url: '/api/sessions/filters' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.projects).toEqual(['alpha', 'beta']);
    expect(body.models).toEqual(['claude-opus-4', 'claude-sonnet-4']);
  });

  it('should return empty arrays when no sessions exist', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/sessions/filters' });
    const body = JSON.parse(res.body);
    expect(body.projects).toEqual([]);
    expect(body.models).toEqual([]);
  });

  it('should exclude null and empty models', async () => {
    // Seed a session with NULL model by inserting directly
    const now = new Date().toISOString();
    db.run(`
      INSERT INTO sessions (session_id, project, workspace, model, status, start_time, last_seen, error_count)
      VALUES ('s-nullmodel', 'test-project', '', NULL, 'running', ?, ?, 0);
    `, [now, now]);
    seedSession('s-realmodel', { model: 'claude-haiku-4' });

    const res = await fastify.inject({ method: 'GET', url: '/api/sessions/filters' });
    const body = JSON.parse(res.body);
    expect(body.models).toEqual(['claude-haiku-4']);
  });
});

// ── Model filter on sessions list ────────────────────────────────────────────

describe('S13 — Model filter on GET /api/sessions', () => {
  beforeEach(async () => { await createTestServer(); });
  afterEach(async () => {
    await fastify.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should filter sessions by model (Spec 11 AC 14)', async () => {
    seedSession('s-m1', { model: 'claude-sonnet-4' });
    seedSession('s-m2', { model: 'claude-opus-4' });
    seedSession('s-m3', { model: 'claude-sonnet-4' });

    const res = await fastify.inject({ method: 'GET', url: '/api/sessions?model=claude-opus-4' });
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].sessionId).toBe('s-m2');
  });
});

// ── S9: Cost Trend Over Time (Spec 12 ACs 7-12) ────────────────────────────

describe('S9 — GET /api/analytics/costs/trend', () => {
  beforeEach(async () => { await createTestServer(); });
  afterEach(async () => {
    await fastify.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return trend data with current and previous arrays at daily granularity', async () => {
    const today = new Date();
    const todayStr = today.toISOString();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    seedSession('s-trend-1', { totalCost: 1.5, startTime: todayStr });
    seedSession('s-trend-2', { totalCost: 2.0, startTime: yesterday.toISOString() });

    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);

    const res = await fastify.inject({
      method: 'GET',
      url: `/api/analytics/costs/trend?granularity=daily&from=${weekStart.toISOString()}&to=${todayStr}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('current');
    expect(body).toHaveProperty('previous');
    expect(body).toHaveProperty('granularity', 'daily');
    expect(Array.isArray(body.current)).toBe(true);
    expect(Array.isArray(body.previous)).toBe(true);
  });

  it('should aggregate costs by day in daily granularity', async () => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const todayStr = today.toISOString();
    const todayStart = new Date(today);
    todayStart.setHours(0, 0, 0, 0);

    seedSession('s-d1', { totalCost: 1.0, startTime: todayStr });
    seedSession('s-d2', { totalCost: 2.0, startTime: todayStr });

    const res = await fastify.inject({
      method: 'GET',
      url: `/api/analytics/costs/trend?granularity=daily&from=${todayStart.toISOString()}&to=${new Date(today.getTime() + 86400000).toISOString()}`,
    });
    const body = JSON.parse(res.body);
    expect(body.current.length).toBeGreaterThanOrEqual(1);
    const todayBucket = body.current.find((p: { date: string }) => p.date === todayStr.slice(0, 10));
    expect(todayBucket).toBeDefined();
    expect(todayBucket.cost).toBeCloseTo(3.0);
  });

  it('should support weekly granularity', async () => {
    const today = new Date();
    seedSession('s-w1', { totalCost: 5.0, startTime: today.toISOString() });

    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const res = await fastify.inject({
      method: 'GET',
      url: `/api/analytics/costs/trend?granularity=weekly&from=${monthStart.toISOString()}&to=${today.toISOString()}`,
    });
    const body = JSON.parse(res.body);
    expect(body.granularity).toBe('weekly');
    expect(body.current.length).toBeGreaterThanOrEqual(1);
  });

  it('should support monthly granularity', async () => {
    const today = new Date();
    seedSession('s-m1', { totalCost: 10.0, startTime: today.toISOString() });

    const yearStart = new Date(today.getFullYear(), 0, 1);
    const res = await fastify.inject({
      method: 'GET',
      url: `/api/analytics/costs/trend?granularity=monthly&from=${yearStart.toISOString()}&to=${today.toISOString()}`,
    });
    const body = JSON.parse(res.body);
    expect(body.granularity).toBe('monthly');
    expect(body.current.length).toBeGreaterThanOrEqual(1);
  });

  it('should include previous period comparison data', async () => {
    const today = new Date();
    const sevenDaysAgo = new Date(today.getTime() - 7 * 86400000);
    const fourteenDaysAgo = new Date(today.getTime() - 14 * 86400000);

    // Session in "previous" period
    seedSession('s-prev', { totalCost: 3.0, startTime: fourteenDaysAgo.toISOString() });
    // Session in "current" period
    seedSession('s-cur', { totalCost: 5.0, startTime: today.toISOString() });

    const res = await fastify.inject({
      method: 'GET',
      url: `/api/analytics/costs/trend?granularity=daily&from=${sevenDaysAgo.toISOString()}&to=${today.toISOString()}`,
    });
    const body = JSON.parse(res.body);
    expect(body.current.length).toBeGreaterThanOrEqual(1);
    expect(body.previous.length).toBeGreaterThanOrEqual(1);
  });

  it('should return empty arrays when no data', async () => {
    const today = new Date();
    const weekAgo = new Date(today.getTime() - 7 * 86400000);

    const res = await fastify.inject({
      method: 'GET',
      url: `/api/analytics/costs/trend?granularity=daily&from=${weekAgo.toISOString()}&to=${today.toISOString()}`,
    });
    const body = JSON.parse(res.body);
    expect(body.current).toEqual([]);
    expect(body.previous).toEqual([]);
  });

  it('should default to daily granularity when not specified', async () => {
    const today = new Date();
    seedSession('s-def', { totalCost: 1.0, startTime: today.toISOString() });

    const weekAgo = new Date(today.getTime() - 7 * 86400000);
    const res = await fastify.inject({
      method: 'GET',
      url: `/api/analytics/costs/trend?from=${weekAgo.toISOString()}&to=${today.toISOString()}`,
    });
    const body = JSON.parse(res.body);
    expect(body.granularity).toBe('daily');
  });
});

// ── S10: Budget Threshold Alerts (Spec 12 ACs 25-30) ───────────────────────

/**
 * Budget alert tests need a mutable config, so we build a custom Fastify instance
 * with a plain (unfrozen) config object rather than using loadConfig's frozen result.
 */
describe('S10 — GET /api/analytics/budget-alerts', () => {
  let budgetDb: Database;
  let budgetFastify: FastifyInstance;
  let budgetTmpDir: string;
  let budgetConfig: Record<string, unknown>;

  async function createBudgetTestServer(alertOverrides: { perSessionCostLimit?: number | null; perDayCostLimit?: number | null } = {}) {
    const SQL = await initSqlJs();
    budgetDb = new SQL.Database();
    budgetDb.run('PRAGMA foreign_keys=ON;');
    budgetDb.exec(SCHEMA_DDL);

    budgetTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-budget-test-'));
    const configPath = path.join(budgetTmpDir, 'test-config.json');

    budgetConfig = {
      general: { port: 9100, dataDir: './data', staleTimeoutMinutes: 60, retentionDays: 30 },
      alerts: {
        perSessionCostLimit: alertOverrides.perSessionCostLimit ?? null,
        perDayCostLimit: alertOverrides.perDayCostLimit ?? null,
      },
    };

    budgetFastify = Fastify({ logger: false });
    budgetFastify.decorate('db', budgetDb);
    budgetFastify.decorate('config', budgetConfig);
    budgetFastify.decorate('configPath', configPath);

    registerAnalyticsRoutes(budgetFastify);
    await budgetFastify.ready();
  }

  function budgetSeedSession(id: string, opts: { totalCost?: number; startTime?: string } = {}) {
    const now = new Date().toISOString();
    budgetDb.run(`
      INSERT INTO sessions (session_id, project, workspace, model, status, start_time, total_cost, turn_count, last_seen, error_count)
      VALUES (?, 'test', '', 'claude-sonnet-4', 'running', ?, ?, 0, ?, 0);
    `, [id, opts.startTime ?? now, opts.totalCost ?? 0, now]);
  }

  afterEach(async () => {
    await budgetFastify?.close();
    budgetDb?.close();
    if (budgetTmpDir) fs.rmSync(budgetTmpDir, { recursive: true, force: true });
  });

  it('should return empty alerts when no limits configured', async () => {
    await createBudgetTestServer();
    const res = await budgetFastify.inject({ method: 'GET', url: '/api/analytics/budget-alerts' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('alerts');
    expect(body.alerts).toEqual([]);
  });

  it('should return daily alert when daily limit exceeded', async () => {
    await createBudgetTestServer({ perDayCostLimit: 5.0 });

    budgetSeedSession('s-budget-1', { totalCost: 6.0, startTime: new Date().toISOString() });

    const res = await budgetFastify.inject({ method: 'GET', url: '/api/analytics/budget-alerts' });
    const body = JSON.parse(res.body);
    expect(body.alerts.length).toBeGreaterThanOrEqual(1);
    const dailyAlert = body.alerts.find((a: { type: string }) => a.type === 'daily');
    expect(dailyAlert).toBeDefined();
    expect(dailyAlert.limit).toBe(5.0);
    expect(dailyAlert.actual).toBeGreaterThan(5.0);
  });

  it('should return session alert when per-session limit exceeded', async () => {
    await createBudgetTestServer({ perSessionCostLimit: 2.0 });

    budgetSeedSession('s-expensive', { totalCost: 3.5, startTime: new Date().toISOString() });
    budgetSeedSession('s-cheap', { totalCost: 1.0, startTime: new Date().toISOString() });

    const res = await budgetFastify.inject({ method: 'GET', url: '/api/analytics/budget-alerts' });
    const body = JSON.parse(res.body);
    const sessionAlerts = body.alerts.filter((a: { type: string }) => a.type === 'session');
    expect(sessionAlerts.length).toBe(1);
    expect(sessionAlerts[0].sessionId).toBe('s-expensive');
    expect(sessionAlerts[0].actual).toBe(3.5);
    expect(sessionAlerts[0].limit).toBe(2.0);
  });

  it('should return multiple alerts when both limits exceeded', async () => {
    await createBudgetTestServer({ perSessionCostLimit: 2.0, perDayCostLimit: 3.0 });

    budgetSeedSession('s-both-1', { totalCost: 2.5, startTime: new Date().toISOString() });
    budgetSeedSession('s-both-2', { totalCost: 1.0, startTime: new Date().toISOString() });

    const res = await budgetFastify.inject({ method: 'GET', url: '/api/analytics/budget-alerts' });
    const body = JSON.parse(res.body);
    expect(body.alerts.length).toBeGreaterThanOrEqual(2);
    expect(body.alerts.some((a: { type: string }) => a.type === 'daily')).toBe(true);
    expect(body.alerts.some((a: { type: string }) => a.type === 'session')).toBe(true);
  });

  it('should not return alerts when spending is below limits', async () => {
    await createBudgetTestServer({ perSessionCostLimit: 10.0, perDayCostLimit: 20.0 });

    budgetSeedSession('s-under', { totalCost: 1.0, startTime: new Date().toISOString() });

    const res = await budgetFastify.inject({ method: 'GET', url: '/api/analytics/budget-alerts' });
    const body = JSON.parse(res.body);
    expect(body.alerts).toEqual([]);
  });

  it('should return multiple session alerts when multiple sessions exceed limit', async () => {
    await createBudgetTestServer({ perSessionCostLimit: 1.0 });

    budgetSeedSession('s-over-1', { totalCost: 2.0, startTime: new Date().toISOString() });
    budgetSeedSession('s-over-2', { totalCost: 3.0, startTime: new Date().toISOString() });
    budgetSeedSession('s-under-1', { totalCost: 0.5, startTime: new Date().toISOString() });

    const res = await budgetFastify.inject({ method: 'GET', url: '/api/analytics/budget-alerts' });
    const body = JSON.parse(res.body);
    const sessionAlerts = body.alerts.filter((a: { type: string }) => a.type === 'session');
    expect(sessionAlerts.length).toBe(2);
  });
});

// ── S11: Error Rate Time-Series (Spec 13 ACs 18-21) ────────────────────────

describe('S11 — GET /api/analytics/errors/trend', () => {
  beforeEach(async () => { await createTestServer(); });
  afterEach(async () => {
    await fastify.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return trend data with buckets array', async () => {
    const now = new Date();
    seedSession('s-err-t1', { project: 'proj1', startTime: now.toISOString() });
    seedEvent('e-err-1', 's-err-t1', {
      type: 'PostToolUseFailure',
      timestamp: now.toISOString(),
      payload: { error: 'test error' },
    });

    const dayAgo = new Date(now.getTime() - 86400000);
    const res = await fastify.inject({
      method: 'GET',
      url: `/api/analytics/errors/trend?from=${dayAgo.toISOString()}&to=${now.toISOString()}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('buckets');
    expect(body).toHaveProperty('overlays');
    expect(body).toHaveProperty('bucketMs');
    expect(Array.isArray(body.buckets)).toBe(true);
  });

  it('should categorize errors in trend buckets', async () => {
    const now = new Date();
    seedSession('s-err-t2', { project: 'proj1', startTime: now.toISOString() });
    seedEvent('e-cat-1', 's-err-t2', {
      type: 'PostToolUseFailure',
      timestamp: now.toISOString(),
      payload: { error: 'tool failed' },
    });
    seedEvent('e-cat-2', 's-err-t2', {
      type: 'Stop',
      timestamp: now.toISOString(),
      payload: { error: 'rate limit hit', is_error: true },
    });

    const dayAgo = new Date(now.getTime() - 86400000);
    const res = await fastify.inject({
      method: 'GET',
      url: `/api/analytics/errors/trend?from=${dayAgo.toISOString()}&to=${now.toISOString()}`,
    });
    const body = JSON.parse(res.body);
    expect(body.buckets.length).toBeGreaterThanOrEqual(1);
    const bucket = body.buckets[0];
    expect(bucket.categories).toBeDefined();
    expect(bucket.count).toBeGreaterThanOrEqual(1);
  });

  it('should return empty buckets when no errors', async () => {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 86400000);
    const res = await fastify.inject({
      method: 'GET',
      url: `/api/analytics/errors/trend?from=${dayAgo.toISOString()}&to=${now.toISOString()}`,
    });
    const body = JSON.parse(res.body);
    expect(body.buckets).toEqual([]);
  });

  it('should include session start/stop overlays', async () => {
    const now = new Date();
    seedSession('s-overlay', { project: 'proj1', startTime: now.toISOString() });
    seedEvent('e-start', 's-overlay', {
      type: 'SessionStart',
      timestamp: now.toISOString(),
    });
    seedEvent('e-stop', 's-overlay', {
      type: 'Stop',
      timestamp: now.toISOString(),
      payload: {},
    });

    const dayAgo = new Date(now.getTime() - 86400000);
    const res = await fastify.inject({
      method: 'GET',
      url: `/api/analytics/errors/trend?from=${dayAgo.toISOString()}&to=${now.toISOString()}`,
    });
    const body = JSON.parse(res.body);
    expect(body.overlays.length).toBeGreaterThanOrEqual(1);
    expect(body.overlays[0]).toHaveProperty('date');
    expect(body.overlays[0]).toHaveProperty('type');
    expect(body.overlays[0]).toHaveProperty('label');
  });

  it('should filter by session when provided', async () => {
    const now = new Date();
    seedSession('s-filter-1', { project: 'proj1', startTime: now.toISOString() });
    seedSession('s-filter-2', { project: 'proj2', startTime: now.toISOString() });
    seedEvent('e-f1', 's-filter-1', {
      type: 'PostToolUseFailure',
      timestamp: now.toISOString(),
      payload: { error: 'err1' },
    });
    seedEvent('e-f2', 's-filter-2', {
      type: 'PostToolUseFailure',
      timestamp: now.toISOString(),
      payload: { error: 'err2' },
    });

    const dayAgo = new Date(now.getTime() - 86400000);
    const res = await fastify.inject({
      method: 'GET',
      url: `/api/analytics/errors/trend?from=${dayAgo.toISOString()}&to=${now.toISOString()}&session=s-filter-1`,
    });
    const body = JSON.parse(res.body);
    const totalCount = body.buckets.reduce((sum: number, b: { count: number }) => sum + b.count, 0);
    expect(totalCount).toBe(1);
  });
});

// ── S12: Rate Limit Sub-View (Spec 13 ACs 22-26) ───────────────────────────

describe('S12 — GET /api/analytics/errors/rate-limits', () => {
  beforeEach(async () => { await createTestServer(); });
  afterEach(async () => {
    await fastify.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return rate limit tracking data structure', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/analytics/errors/rate-limits' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('frequency');
    expect(body).toHaveProperty('byModel');
    expect(body).toHaveProperty('cooldowns');
    expect(Array.isArray(body.frequency)).toBe(true);
    expect(Array.isArray(body.byModel)).toBe(true);
    expect(Array.isArray(body.cooldowns)).toBe(true);
  });

  it('should return empty arrays when no rate limit events', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/analytics/errors/rate-limits' });
    const body = JSON.parse(res.body);
    expect(body.frequency).toEqual([]);
    expect(body.byModel).toEqual([]);
    expect(body.cooldowns).toEqual([]);
  });

  it('should count rate limit events by hour', async () => {
    const now = new Date();
    seedSession('s-rl1', { model: 'claude-sonnet-4', startTime: now.toISOString() });
    seedEvent('e-rl1', 's-rl1', {
      type: 'PostToolUseFailure',
      timestamp: now.toISOString(),
      payload: { error: 'rate_limit exceeded' },
    });
    seedEvent('e-rl2', 's-rl1', {
      type: 'PostToolUseFailure',
      timestamp: new Date(now.getTime() - 60000).toISOString(),
      payload: { error: 'rate_limit hit 429' },
    });

    const dayAgo = new Date(now.getTime() - 86400000);
    const res = await fastify.inject({
      method: 'GET',
      url: `/api/analytics/errors/rate-limits?from=${dayAgo.toISOString()}&to=${now.toISOString()}`,
    });
    const body = JSON.parse(res.body);
    expect(body.frequency.length).toBeGreaterThanOrEqual(1);
    const totalCount = body.frequency.reduce((s: number, f: { count: number }) => s + f.count, 0);
    expect(totalCount).toBe(2);
  });

  it('should attribute rate limits to models', async () => {
    const now = new Date();
    seedSession('s-rl-m1', { model: 'claude-sonnet-4', startTime: now.toISOString() });
    seedSession('s-rl-m2', { model: 'claude-opus-4', startTime: now.toISOString() });
    seedEvent('e-rl-m1', 's-rl-m1', {
      type: 'PostToolUseFailure',
      timestamp: now.toISOString(),
      payload: { error: '429 rate_limit' },
    });
    seedEvent('e-rl-m2', 's-rl-m2', {
      type: 'PostToolUseFailure',
      timestamp: now.toISOString(),
      payload: { error: '429 rate_limit' },
    });

    const dayAgo = new Date(now.getTime() - 86400000);
    const res = await fastify.inject({
      method: 'GET',
      url: `/api/analytics/errors/rate-limits?from=${dayAgo.toISOString()}&to=${now.toISOString()}`,
    });
    const body = JSON.parse(res.body);
    expect(body.byModel.length).toBe(2);
    expect(body.byModel.some((m: { model: string }) => m.model === 'claude-sonnet-4')).toBe(true);
    expect(body.byModel.some((m: { model: string }) => m.model === 'claude-opus-4')).toBe(true);
  });

  it('should detect cooldown patterns between rate limit events', async () => {
    const now = new Date();
    seedSession('s-cd', { model: 'claude-sonnet-4', startTime: now.toISOString() });

    // Two rate limit events 30 seconds apart (within cooldown detection range 5s-5min)
    seedEvent('e-cd1', 's-cd', {
      type: 'PostToolUseFailure',
      timestamp: new Date(now.getTime() - 30000).toISOString(),
      payload: { error: 'rate_limit' },
    });
    seedEvent('e-cd2', 's-cd', {
      type: 'PostToolUseFailure',
      timestamp: now.toISOString(),
      payload: { error: 'rate_limit' },
    });

    const dayAgo = new Date(now.getTime() - 86400000);
    const res = await fastify.inject({
      method: 'GET',
      url: `/api/analytics/errors/rate-limits?from=${dayAgo.toISOString()}&to=${now.toISOString()}`,
    });
    const body = JSON.parse(res.body);
    expect(body.cooldowns.length).toBeGreaterThanOrEqual(1);
    expect(body.cooldowns[0]).toHaveProperty('durationMs');
    expect(body.cooldowns[0]).toHaveProperty('model');
    expect(body.cooldowns[0].durationMs).toBeGreaterThanOrEqual(5000);
  });
});

// ── S27: ScrapedError events in error queries ────────────────────────────────

describe('S27 — ScrapedError events in error analytics', () => {
  beforeEach(async () => {
    await createTestServer();
    seedSession('scrape-err-sess', { project: 'proj-x', errorCount: 2 });
  });

  afterEach(async () => {
    await fastify.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/analytics/errors should include ScrapedError events', async () => {
    const now = new Date().toISOString();
    seedEvent('scraped-err-1', 'scrape-err-sess', {
      type: 'ScrapedError',
      timestamp: now,
      payload: { error: 'Rate limit exceeded', category: 'rate_limit', source: 'scraper' },
    });
    seedEvent('scraped-err-2', 'scrape-err-sess', {
      type: 'ScrapedError',
      timestamp: now,
      payload: { error: 'Authentication failure', category: 'auth_error', source: 'scraper' },
    });

    const res = await fastify.inject({ method: 'GET', url: '/api/analytics/errors' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(2);
    expect(body.data).toHaveLength(2);

    const categories = body.data.map((e: any) => e.category);
    expect(categories).toContain('rate_limit');
    expect(categories).toContain('auth_error');
  });

  it('ScrapedError events should use pre-classified category from payload', async () => {
    seedEvent('scraped-err-3', 'scrape-err-sess', {
      type: 'ScrapedError',
      timestamp: new Date().toISOString(),
      payload: { error: 'Billing quota reached', category: 'billing_error', source: 'scraper' },
    });

    const res = await fastify.inject({ method: 'GET', url: '/api/analytics/errors' });
    const body = JSON.parse(res.body);
    expect(body.data[0].category).toBe('billing_error');
    expect(body.data[0].message).toBe('Billing quota reached');
  });

  it('GET /api/analytics/errors/trend should count ScrapedError events in buckets', async () => {
    const base = new Date();
    for (let i = 0; i < 3; i++) {
      const ts = new Date(base.getTime() - i * 60000).toISOString();
      seedEvent(`scraped-trend-${i}`, 'scrape-err-sess', {
        type: 'ScrapedError',
        timestamp: ts,
        payload: { error: `Error ${i}`, category: 'server_error', source: 'scraper' },
      });
    }

    const from = new Date(base.getTime() - 3600000).toISOString();
    const to = new Date(base.getTime() + 60000).toISOString();
    const res = await fastify.inject({
      method: 'GET',
      url: `/api/analytics/errors/trend?from=${from}&to=${to}`,
    });
    const body = JSON.parse(res.body);
    const totalCount = body.buckets.reduce((sum: number, b: any) => sum + b.count, 0);
    expect(totalCount).toBe(3);
  });

  it('ScrapedError rate limit events should appear in rate-limits endpoint', async () => {
    const now = new Date();
    seedEvent('scraped-rl-1', 'scrape-err-sess', {
      type: 'ScrapedError',
      timestamp: new Date(now.getTime() - 10000).toISOString(),
      payload: { error: 'Rate limit exceeded', category: 'rate_limit', source: 'scraper' },
    });
    seedEvent('scraped-rl-2', 'scrape-err-sess', {
      type: 'ScrapedError',
      timestamp: now.toISOString(),
      payload: { error: 'Too many requests 429', category: 'rate_limit', source: 'scraper' },
    });

    const from = new Date(now.getTime() - 3600000).toISOString();
    const to = new Date(now.getTime() + 60000).toISOString();
    const res = await fastify.inject({
      method: 'GET',
      url: `/api/analytics/errors/rate-limits?from=${from}&to=${to}`,
    });
    const body = JSON.parse(res.body);
    expect(body.frequency.length).toBeGreaterThan(0);
  });
});

// ── createServer integration (H1) ───────────────────────────────────────────

describe('H1 — createServer integration', () => {
  it('should export createServer function', async () => {
    const mod = await import('@server/index.js');
    expect(typeof mod.createServer).toBe('function');
  });
});
