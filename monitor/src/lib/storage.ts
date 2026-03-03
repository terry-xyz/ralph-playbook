/**
 * SQLite storage layer using sql.js (WASM).
 * Spec 04: 4-table schema, periodic flush, atomic writes, retention/pruning.
 *
 * Key constraints:
 * - sql.js runs entirely in-memory; must explicitly flush to disk.
 * - Single-writer: only the ingester daemon writes; dashboard reads only.
 * - Zero native dependencies; cross-platform via WASM.
 */

import initSqlJs, { type Database } from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '@shared/types.js';

// ── Schema DDL ───────────────────────────────────────────────────────────────

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
    agent_name TEXT,
    subagent_count INTEGER NOT NULL DEFAULT 0,
    subagent_tasks TEXT NOT NULL DEFAULT '[]'
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

// ── Storage Class ────────────────────────────────────────────────────────────

export class Storage {
  private db: Database | null = null;
  private dbFilePath: string;
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private ftsAvailable = false;

  constructor(dbFilePath: string) {
    this.dbFilePath = dbFilePath;
  }

  /** Initialize the database. Loads existing file or creates fresh. */
  async init(): Promise<void> {
    const SQL = await initSqlJs();

    let existingData: Uint8Array | null = null;
    try {
      if (fs.existsSync(this.dbFilePath)) {
        existingData = new Uint8Array(fs.readFileSync(this.dbFilePath));
      }
    } catch {
      // If we can't read the file, start fresh
    }

    try {
      this.db = existingData ? new SQL.Database(existingData) : new SQL.Database();
      // Validate the database is usable by running a pragma.
      // sql.js may load corrupt data without throwing until a query is run.
      this.db.run('PRAGMA journal_mode=WAL;');
      this.db.run('PRAGMA foreign_keys=ON;');
      this.db.exec(SCHEMA_DDL);
    } catch {
      // Corrupt or unusable DB file — log warning and create fresh
      console.warn(`[ralph-monitor] Corrupt database file, creating fresh: ${this.dbFilePath}`);
      try { this.db?.close(); } catch { /* ignore */ }
      this.db = new SQL.Database();
      this.db.run('PRAGMA journal_mode=WAL;');
      this.db.run('PRAGMA foreign_keys=ON;');
      this.db.exec(SCHEMA_DDL);
    }

    // Schema migration: add agent_name column if missing (added in S14)
    this.migrateSchema();

    // Validate FTS5 availability
    this.ftsAvailable = this.checkFts5();
  }

  /** Apply schema migrations for columns added after initial release. */
  private migrateSchema(): void {
    const db = this.getDb();
    const result = db.exec("PRAGMA table_info(sessions);");
    if (result.length > 0) {
      const columns = result[0].values.map((row: unknown[]) => row[1] as string);
      if (!columns.includes('agent_name')) {
        db.run('ALTER TABLE sessions ADD COLUMN agent_name TEXT;');
      }
      if (!columns.includes('subagent_count')) {
        db.run('ALTER TABLE sessions ADD COLUMN subagent_count INTEGER NOT NULL DEFAULT 0;');
      }
      if (!columns.includes('subagent_tasks')) {
        db.run("ALTER TABLE sessions ADD COLUMN subagent_tasks TEXT NOT NULL DEFAULT '[]';");
      }
    }

    // Migrate model column from single string to JSON array format (S26)
    this.migrateModelToJsonArray();
  }

  /**
   * Migrate existing model column values from single strings to JSON arrays.
   * E.g., 'claude-sonnet-4' → '["claude-sonnet-4"]', NULL → '[]'
   * Idempotent: values already in JSON array format are not modified.
   */
  private migrateModelToJsonArray(): void {
    const db = this.getDb();

    // Sessions table: convert non-array model values
    const sessions = db.exec("SELECT session_id, model FROM sessions WHERE model IS NOT NULL AND model != '' AND model NOT LIKE '[%';");
    if (sessions.length > 0) {
      for (const row of sessions[0].values) {
        const sessionId = row[0] as string;
        const model = row[1] as string;
        db.run('UPDATE sessions SET model = ? WHERE session_id = ?;', [JSON.stringify([model]), sessionId]);
      }
    }
    // Set NULL/empty to empty JSON array
    db.run("UPDATE sessions SET model = '[]' WHERE model IS NULL OR model = '';");

    // Metrics table: convert non-array model values
    const metrics = db.exec("SELECT session_id, model FROM metrics WHERE model IS NOT NULL AND model != '' AND model NOT LIKE '[%';");
    if (metrics.length > 0) {
      for (const row of metrics[0].values) {
        const sessionId = row[0] as string;
        const model = row[1] as string;
        db.run('UPDATE metrics SET model = ? WHERE session_id = ?;', [JSON.stringify([model]), sessionId]);
      }
    }
    db.run("UPDATE metrics SET model = '[]' WHERE model IS NULL OR model = '';");
  }

  /** Check if FTS5 is available in this sql.js build. */
  private checkFts5(): boolean {
    try {
      this.getDb().exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_test USING fts5(content);
      `);
      this.getDb().exec('DROP TABLE IF EXISTS _fts5_test;');
      return true;
    } catch {
      console.warn('[ralph-monitor] FTS5 not available in sql.js build, falling back to LIKE queries.');
      return false;
    }
  }

  /** Create FTS index on events payload if FTS5 is available. */
  setupFtsIndex(): boolean {
    if (!this.ftsAvailable) return false;

    try {
      this.getDb().exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
          event_id,
          payload,
          content=events,
          content_rowid=rowid
        );
      `);
      return true;
    } catch {
      this.ftsAvailable = false;
      return false;
    }
  }

  /** Whether FTS5 is available for full-text search. */
  isFtsAvailable(): boolean {
    return this.ftsAvailable;
  }

  /** Get the underlying database instance. Throws if not initialized. */
  getDb(): Database {
    if (!this.db) {
      throw new Error('Database not initialized. Call init() first.');
    }
    return this.db;
  }

  /**
   * Flush database to disk using atomic write (tmp + rename).
   * Spec 04: crash during write must not corrupt existing file.
   */
  flushToDisk(): void {
    const db = this.getDb();
    const data = db.export();
    const buffer = Buffer.from(data);

    const dir = path.dirname(this.dbFilePath);
    fs.mkdirSync(dir, { recursive: true });

    const tmpPath = `${this.dbFilePath}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, buffer);
      fs.renameSync(tmpPath, this.dbFilePath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
      throw err;
    }
  }

  /**
   * Start periodic flush interval.
   * @param intervalMs Flush interval in milliseconds.
   */
  startPeriodicFlush(intervalMs: number): void {
    this.stopPeriodicFlush();
    this.flushInterval = setInterval(() => {
      try {
        this.flushToDisk();
      } catch (err) {
        console.error('[ralph-monitor] Periodic flush failed:', err);
      }
    }, intervalMs);
  }

  /** Stop periodic flush interval. */
  stopPeriodicFlush(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
  }

  /**
   * Prune old data from all 4 tables based on retention period.
   * Spec 04 AC 12: applies uniformly to ALL tables.
   * Spec 04 AC 14: full hard delete — no summary preserved.
   * Spec 04 AC 16, 23: VACUUM after purge to reclaim space.
   */
  prune(retentionDays: number): void {
    const db = this.getDb();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffISO = cutoff.toISOString();

    db.run('BEGIN TRANSACTION;');
    try {
      // Delete old guardrail log entries
      db.run('DELETE FROM guardrail_log WHERE timestamp < ?;', [cutoffISO]);

      // Delete old events
      db.run('DELETE FROM events WHERE timestamp < ?;', [cutoffISO]);

      // Delete old metrics (via session start time)
      db.run(`
        DELETE FROM metrics WHERE session_id IN (
          SELECT session_id FROM sessions WHERE start_time < ?
        );
      `, [cutoffISO]);

      // Delete old sessions
      db.run('DELETE FROM sessions WHERE start_time < ?;', [cutoffISO]);

      db.run('COMMIT;');
    } catch (err) {
      db.run('ROLLBACK;');
      throw err;
    }

    // VACUUM to reclaim space (must be outside transaction)
    db.run('VACUUM;');
  }

  /**
   * Graceful shutdown: stop periodic flush, final flush, close database.
   */
  async shutdown(): Promise<void> {
    this.stopPeriodicFlush();
    if (this.db) {
      try {
        this.flushToDisk();
      } catch (err) {
        console.error('[ralph-monitor] Final flush on shutdown failed:', err);
      }
      this.db.close();
      this.db = null;
    }
  }

  /** Check if a table exists. */
  tableExists(tableName: string): boolean {
    const db = this.getDb();
    const result = db.exec(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?;`,
      [tableName] as unknown[]
    );
    return result.length > 0 && result[0].values.length > 0;
  }

  /** Check if an index exists. */
  indexExists(indexName: string): boolean {
    const db = this.getDb();
    const result = db.exec(
      `SELECT name FROM sqlite_master WHERE type='index' AND name=?;`,
      [indexName] as unknown[]
    );
    return result.length > 0 && result[0].values.length > 0;
  }

  /** Get the database file path. */
  getDbFilePath(): string {
    return this.dbFilePath;
  }
}
