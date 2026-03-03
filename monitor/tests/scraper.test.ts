/**
 * Phase F — Post-Session Scraper tests (Spec 03).
 * Tests session file discovery, JSONL parsing, metric extraction,
 * defensive handling, and database operations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findSessionFile, parseSessionData, scrapeSession } from '@server/scraper.js';
import { DEFAULT_CONFIG } from '@shared/constants.js';
import type { Config } from '@shared/types.js';

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
`;

// ── Helpers ──────────────────────────────────────────────────────────────────

let db: Database;
let tmpDir: string;
let claudeDir: string;
let config: Config;

async function setup() {
  const SQL = await initSqlJs();
  db = new SQL.Database();
  db.run('PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA_DDL);

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-scraper-test-'));
  claudeDir = path.join(tmpDir, '.claude');
  const projectsDir = path.join(claudeDir, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });

  // Create a test config pointing to our temp claude dir
  config = { ...structuredClone(DEFAULT_CONFIG), scrape: { ...DEFAULT_CONFIG.scrape, claudeDir } };
}

function seedSession(id: string) {
  const now = new Date().toISOString();
  db.run(`
    INSERT INTO sessions (session_id, project, workspace, model, status, start_time, total_cost, turn_count, last_seen, error_count)
    VALUES (?, 'test', '', NULL, 'completed', ?, 0, 0, ?, 0);
  `, [id, now, now]);
}

function writeSessionFile(sessionId: string, turns: object[], subDir?: string): string {
  const projectsDir = path.join(claudeDir, 'projects');
  const dir = subDir ? path.join(projectsDir, subDir) : projectsDir;
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  const content = turns.map(t => JSON.stringify(t)).join('\n') + '\n';
  fs.writeFileSync(filePath, content);
  return filePath;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('F1 — Session file discovery', () => {
  beforeEach(async () => { await setup(); });
  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should find session file by exact filename match', () => {
    writeSessionFile('session-abc', [{ role: 'assistant', content: 'hello' }]);
    const result = findSessionFile(claudeDir, 'session-abc');
    expect(result).not.toBeNull();
    expect(result!).toContain('session-abc.jsonl');
  });

  it('should find session file in nested subdirectory', () => {
    writeSessionFile('session-deep', [{ role: 'assistant' }], 'some/nested/path');
    const result = findSessionFile(claudeDir, 'session-deep');
    expect(result).not.toBeNull();
    expect(result!).toContain('session-deep.jsonl');
  });

  it('should return null when no session file exists', () => {
    const result = findSessionFile(claudeDir, 'nonexistent-session');
    expect(result).toBeNull();
  });

  it('should return null when projects directory does not exist', () => {
    const result = findSessionFile('/tmp/no-such-dir-12345', 'session-abc');
    expect(result).toBeNull();
  });

  it('should find file by partial name match', () => {
    const projectsDir = path.join(claudeDir, 'projects', 'myproj');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectsDir, 'data-session-xyz-extra.jsonl'),
      '{"role":"assistant"}\n'
    );
    const result = findSessionFile(claudeDir, 'session-xyz');
    expect(result).not.toBeNull();
  });

  it('should find file by content search when filename does not match', () => {
    const projectsDir = path.join(claudeDir, 'projects', 'proj1');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectsDir, 'some-file.jsonl'),
      '{"session_id":"target-session-id","role":"user"}\n'
    );
    const result = findSessionFile(claudeDir, 'target-session-id');
    expect(result).not.toBeNull();
  });
});

describe('F1 — Metric extraction (all 8 categories)', () => {
  beforeEach(async () => { await setup(); });
  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should extract total cost from costUSD field', () => {
    const filePath = writeSessionFile('s1', [
      { role: 'assistant', costUSD: 0.05, timestamp: '2025-01-01T10:00:00Z' },
      { role: 'assistant', costUSD: 0.10, timestamp: '2025-01-01T10:01:00Z' },
    ]);
    const data = parseSessionData(filePath, config);
    expect(data.totalCost).toBeCloseTo(0.15, 4);
  });

  it('should extract token breakdown', () => {
    const filePath = writeSessionFile('s1', [
      {
        role: 'assistant',
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 30 },
        timestamp: '2025-01-01T10:00:00Z',
      },
    ]);
    const data = parseSessionData(filePath, config);
    expect(data.tokenBreakdown).not.toBeNull();
    expect(data.tokenBreakdown!.input).toBe(100);
    expect(data.tokenBreakdown!.output).toBe(50);
    expect(data.tokenBreakdown!.cacheCreation).toBe(10);
    expect(data.tokenBreakdown!.cacheRead).toBe(30);
  });

  it('should extract model name', () => {
    const filePath = writeSessionFile('s1', [
      { role: 'assistant', model: 'claude-sonnet-4', timestamp: '2025-01-01T10:00:00Z' },
    ]);
    const data = parseSessionData(filePath, config);
    expect(data.model).toBe('claude-sonnet-4');
  });

  it('should use last model when multiple models present (mid-session change)', () => {
    const filePath = writeSessionFile('s1', [
      { role: 'assistant', model: 'claude-haiku-4', timestamp: '2025-01-01T10:00:00Z' },
      { role: 'assistant', model: 'claude-sonnet-4', timestamp: '2025-01-01T10:01:00Z' },
    ]);
    const data = parseSessionData(filePath, config);
    expect(data.model).toBe('claude-sonnet-4');
  });

  it('should compute wall-clock duration from timestamps', () => {
    const filePath = writeSessionFile('s1', [
      { role: 'user', timestamp: '2025-01-01T10:00:00Z' },
      { role: 'assistant', timestamp: '2025-01-01T10:05:00Z' },
    ]);
    const data = parseSessionData(filePath, config);
    expect(data.wallClockDurationMs).toBe(5 * 60 * 1000); // 5 minutes in ms
  });

  it('should compute API duration from apiDurationMs fields', () => {
    const filePath = writeSessionFile('s1', [
      { role: 'assistant', apiDurationMs: 1500, timestamp: '2025-01-01T10:00:00Z' },
      { role: 'assistant', apiDurationMs: 2500, timestamp: '2025-01-01T10:01:00Z' },
    ]);
    const data = parseSessionData(filePath, config);
    expect(data.apiDurationMs).toBe(4000);
  });

  it('should count assistant turns', () => {
    const filePath = writeSessionFile('s1', [
      { role: 'user', timestamp: '2025-01-01T10:00:00Z' },
      { role: 'assistant', timestamp: '2025-01-01T10:00:01Z' },
      { role: 'user', timestamp: '2025-01-01T10:00:02Z' },
      { role: 'assistant', timestamp: '2025-01-01T10:00:03Z' },
      { role: 'assistant', timestamp: '2025-01-01T10:00:04Z' },
    ]);
    const data = parseSessionData(filePath, config);
    expect(data.turnCount).toBe(3);
  });

  it('should capture extended thinking by default (config ON)', () => {
    const filePath = writeSessionFile('s1', [
      { role: 'assistant', thinking: 'I need to analyze...', timestamp: '2025-01-01T10:00:00Z' },
    ]);
    const data = parseSessionData(filePath, config);
    expect(data.extendedThinking).toHaveLength(1);
    expect(data.extendedThinking[0]).toBe('I need to analyze...');
  });

  it('should NOT capture extended thinking when config is OFF', () => {
    const noThinkConfig = structuredClone(config);
    noThinkConfig.scrape.captureExtendedThinking = false;
    const filePath = writeSessionFile('s1', [
      { role: 'assistant', thinking: 'I need to analyze...', timestamp: '2025-01-01T10:00:00Z' },
    ]);
    const data = parseSessionData(filePath, noThinkConfig);
    expect(data.extendedThinking).toHaveLength(0);
  });

  it('should NOT capture full responses by default (config OFF)', () => {
    const filePath = writeSessionFile('s1', [
      { role: 'assistant', content: 'Here is the answer', timestamp: '2025-01-01T10:00:00Z' },
    ]);
    const data = parseSessionData(filePath, config);
    expect(data.fullResponses).toHaveLength(0);
  });

  it('should capture full responses when config is ON', () => {
    const fullResConfig = structuredClone(config);
    fullResConfig.scrape.captureFullResponses = true;
    const filePath = writeSessionFile('s1', [
      { role: 'assistant', content: 'Here is the answer', timestamp: '2025-01-01T10:00:00Z' },
    ]);
    const data = parseSessionData(filePath, fullResConfig);
    expect(data.fullResponses).toHaveLength(1);
    expect(data.fullResponses[0]).toBe('Here is the answer');
  });

  it('should classify rate limit errors', () => {
    const filePath = writeSessionFile('s1', [
      { error: 'Rate limit exceeded: 429 Too Many Requests', isError: true, timestamp: '2025-01-01T10:00:00Z' },
    ]);
    const data = parseSessionData(filePath, config);
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0].category).toBe('rate_limit');
  });

  it('should classify auth errors', () => {
    const filePath = writeSessionFile('s1', [
      { error: '401 Unauthorized: invalid API key', isError: true, timestamp: '2025-01-01T10:00:00Z' },
    ]);
    const data = parseSessionData(filePath, config);
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0].category).toBe('auth_error');
  });

  it('should classify billing errors', () => {
    const filePath = writeSessionFile('s1', [
      { error: 'Billing quota exceeded, payment required', isError: true, timestamp: '2025-01-01T10:00:00Z' },
    ]);
    const data = parseSessionData(filePath, config);
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0].category).toBe('billing_error');
  });

  it('should classify server errors', () => {
    const filePath = writeSessionFile('s1', [
      { error: '500 Internal Server Error', isError: true, timestamp: '2025-01-01T10:00:00Z' },
    ]);
    const data = parseSessionData(filePath, config);
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0].category).toBe('server_error');
  });

  it('should default to tool_failure for unrecognized errors', () => {
    const filePath = writeSessionFile('s1', [
      { error: 'Something went wrong with file operation', isError: true, timestamp: '2025-01-01T10:00:00Z' },
    ]);
    const data = parseSessionData(filePath, config);
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0].category).toBe('tool_failure');
  });
});

describe('F1 — Defensive parsing', () => {
  beforeEach(async () => { await setup(); });
  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should never crash on unexpected content', () => {
    const filePath = writeSessionFile('s1', []);
    // Write some garbage content
    fs.writeFileSync(filePath, 'not json at all\n{invalid json}\n{"valid": true}\n');
    expect(() => parseSessionData(filePath, config)).not.toThrow();
    const data = parseSessionData(filePath, config);
    expect(data.turns).toHaveLength(1); // Only the valid line
  });

  it('should handle missing session file gracefully', () => {
    const data = parseSessionData('/tmp/nonexistent-file-12345.jsonl', config);
    expect(data.totalCost).toBeNull();
    expect(data.tokenBreakdown).toBeNull();
    expect(data.turnCount).toBe(0);
  });

  it('should distinguish absent vs zero values', () => {
    // File with NO cost fields → totalCost should be null (absent)
    const filePath1 = writeSessionFile('s1', [
      { role: 'assistant', timestamp: '2025-01-01T10:00:00Z' },
    ]);
    const data1 = parseSessionData(filePath1, config);
    expect(data1.totalCost).toBeNull();

    // File WITH cost field set to 0 → totalCost should be 0 (present)
    const filePath2 = writeSessionFile('s2', [
      { role: 'assistant', costUSD: 0, timestamp: '2025-01-01T10:00:00Z' },
    ]);
    const data2 = parseSessionData(filePath2, config);
    expect(data2.totalCost).toBe(0);
  });

  it('should skip unrecognized fields silently', () => {
    const filePath = writeSessionFile('s1', [
      {
        role: 'assistant',
        costUSD: 0.05,
        unknownField1: 'foo',
        nested_unknown: { a: 1 },
        timestamp: '2025-01-01T10:00:00Z',
      },
    ]);
    const data = parseSessionData(filePath, config);
    expect(data.totalCost).toBeCloseTo(0.05);
  });

  it('should handle empty file gracefully', () => {
    const filePath = writeSessionFile('s1', []);
    fs.writeFileSync(filePath, '');
    const data = parseSessionData(filePath, config);
    expect(data.totalCost).toBeNull();
    expect(data.turnCount).toBe(0);
  });
});

describe('F2 — Database operations', () => {
  beforeEach(async () => { await setup(); });
  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should upsert metrics into metrics table', async () => {
    seedSession('s1');
    const filePath = writeSessionFile('s1', [
      {
        role: 'assistant',
        model: 'claude-sonnet-4',
        costUSD: 0.05,
        usage: { input_tokens: 100, output_tokens: 50 },
        apiDurationMs: 2000,
        timestamp: '2025-01-01T10:00:00Z',
      },
      {
        role: 'assistant',
        model: 'claude-sonnet-4',
        costUSD: 0.10,
        usage: { input_tokens: 200, output_tokens: 100 },
        apiDurationMs: 3000,
        timestamp: '2025-01-01T10:05:00Z',
      },
    ]);

    await scrapeSession(db, 's1', config);

    // Check metrics table
    const metricsResult = db.exec('SELECT * FROM metrics WHERE session_id = ?;', ['s1']);
    expect(metricsResult).toHaveLength(1);
    expect(metricsResult[0].values).toHaveLength(1);

    const row = metricsResult[0].values[0];
    const tokenBreakdown = JSON.parse(row[2] as string);
    expect(tokenBreakdown.input).toBe(300);
    expect(tokenBreakdown.output).toBe(150);
    expect(row[3]).toBe('claude-sonnet-4'); // model
    expect(row[5]).toBeCloseTo(5, 1); // api_duration in seconds (5000ms → 5s)
    expect(row[6]).toBe(2); // turn_count
  });

  it('should update sessions table with totals', async () => {
    seedSession('s1');
    writeSessionFile('s1', [
      {
        role: 'assistant',
        model: 'claude-sonnet-4',
        costUSD: 0.25,
        usage: { input_tokens: 500, output_tokens: 200 },
        timestamp: '2025-01-01T10:00:00Z',
      },
    ]);

    await scrapeSession(db, 's1', config);

    const sessionResult = db.exec('SELECT total_cost, model, turn_count, token_counts FROM sessions WHERE session_id = ?;', ['s1']);
    expect(sessionResult).toHaveLength(1);
    const row = sessionResult[0].values[0];
    expect(row[0]).toBeGreaterThanOrEqual(0.25); // total_cost (MAX of old and new)
    expect(row[1]).toBe('claude-sonnet-4'); // model
    expect(row[2]).toBeGreaterThanOrEqual(1); // turn_count
  });

  it('should handle re-scraping without duplicates (upsert)', async () => {
    seedSession('s1');
    writeSessionFile('s1', [
      { role: 'assistant', costUSD: 0.05, timestamp: '2025-01-01T10:00:00Z' },
    ]);

    await scrapeSession(db, 's1', config);
    await scrapeSession(db, 's1', config); // Re-scrape

    const metricsResult = db.exec('SELECT COUNT(*) FROM metrics WHERE session_id = ?;', ['s1']);
    expect(metricsResult[0].values[0][0]).toBe(1); // Only one row
  });

  it('should never throw on scrape failure (non-blocking)', async () => {
    seedSession('s1');
    // Don't create a session file — should gracefully skip
    await expect(scrapeSession(db, 's1', config)).resolves.toBeUndefined();
  });

  it('should handle config changes between scrapes', async () => {
    seedSession('s1');
    const filePath = writeSessionFile('s1', [
      { role: 'assistant', thinking: 'deep thought', content: 'answer', timestamp: '2025-01-01T10:00:00Z' },
    ]);

    // First scrape with thinking ON (default)
    const data1 = parseSessionData(filePath, config);
    expect(data1.extendedThinking).toHaveLength(1);

    // Second scrape with thinking OFF
    const newConfig = structuredClone(config);
    newConfig.scrape.captureExtendedThinking = false;
    const data2 = parseSessionData(filePath, newConfig);
    expect(data2.extendedThinking).toHaveLength(0);
  });
});
