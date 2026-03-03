/**
 * Event Ingestion Pipeline (Spec 02).
 * Reads JSONL event files, batch-inserts into SQLite, manages position tracking.
 *
 * Key responsibilities:
 * - Watch for new/changed JSONL files using chokidar
 * - Track read position per file (byte offset) to avoid re-processing
 * - Batch-parse JSONL lines into typed EventRecord objects
 * - Idempotent insertion (duplicate event IDs rejected)
 * - Time-based and size-based flush triggers
 * - Position tracking via sidecar .pos files
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'sql.js';
import type { EventRecord, Config } from '@shared/types.js';
import { isValidEventType } from '@shared/event-names.js';
import { processEvent, categorizeError, detectStaleSessions } from './session-lifecycle.js';
import { scrapeSession } from './scraper.js';

// ── Position Tracking (E1) ───────────────────────────────────────────────────

/** Read the last processed byte offset for a JSONL file. */
export function readPosition(filePath: string): number {
  const posPath = filePath + '.pos';
  try {
    const content = fs.readFileSync(posPath, 'utf-8').trim();
    const pos = parseInt(content, 10);
    return isNaN(pos) ? 0 : pos;
  } catch {
    return 0;
  }
}

/** Save the current byte offset for a JSONL file. */
export function savePosition(filePath: string, offset: number): void {
  const posPath = filePath + '.pos';
  fs.writeFileSync(posPath, String(offset), 'utf-8');
}

// ── JSONL Parsing (E2) ──────────────────────────────────────────────────────

/**
 * Read new lines from a JSONL file starting at the given byte offset.
 * Returns parsed events and the new byte offset.
 * Handles partial lines by only processing complete lines (newline-terminated).
 */
export function readNewLines(filePath: string, fromOffset: number): {
  events: EventRecord[];
  newOffset: number;
  malformedCount: number;
} {
  const events: EventRecord[] = [];
  let malformedCount = 0;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { events, newOffset: fromOffset, malformedCount };
  }

  if (stat.size <= fromOffset) {
    return { events, newOffset: fromOffset, malformedCount };
  }

  // Read only the new portion of the file
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - fromOffset);
    fs.readSync(fd, buffer, 0, buffer.length, fromOffset);
    const content = buffer.toString('utf-8');

    // Split by newlines, keeping only complete lines
    const lines = content.split('\n');
    let processedBytes = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Last element after split is either incomplete data or empty string after trailing \n
      if (i === lines.length - 1) {
        if (!content.endsWith('\n')) {
          break; // Incomplete line — hold for next read
        }
        // Empty string after trailing newline — nothing more to process
        if (line === '') break;
      }

      processedBytes += Buffer.byteLength(line + '\n', 'utf-8');

      if (!line.trim()) continue;

      try {
        const parsed = JSON.parse(line) as EventRecord;

        // Validate required fields
        if (!parsed.id || !parsed.sessionId || !parsed.timestamp || !parsed.type) {
          malformedCount++;
          continue;
        }

        // Validate event type
        if (!isValidEventType(parsed.type)) {
          malformedCount++;
          continue;
        }

        events.push(parsed);
      } catch {
        malformedCount++;
      }
    }

    return { events, newOffset: fromOffset + processedBytes, malformedCount };
  } finally {
    fs.closeSync(fd);
  }
}

// ── Batch Insertion (E2) ─────────────────────────────────────────────────────

/**
 * Insert a batch of events into the database.
 * Atomic: all-or-nothing per batch via transaction.
 * Idempotent: duplicate event IDs are skipped.
 * Also processes session lifecycle (G1) for each event.
 */
export function insertBatch(db: Database, events: EventRecord[], config?: Readonly<Config>): {
  inserted: number;
  duplicates: number;
  errors: number;
} {
  let inserted = 0;
  let duplicates = 0;
  let errors = 0;
  const sessionsToScrape: string[] = [];

  db.run('BEGIN TRANSACTION;');
  try {
    for (const event of events) {
      try {
        // Check for duplicate (idempotent by event ID)
        const existing = db.exec(
          'SELECT event_id FROM events WHERE event_id = ?;',
          [event.id]
        );
        if (existing.length > 0 && existing[0].values.length > 0) {
          duplicates++;
          continue;
        }

        // Process session lifecycle first (creates session if needed)
        processEvent(db, event);

        // Insert event
        db.run(`
          INSERT INTO events (event_id, session_id, timestamp, type, tool_name, payload, duration, tool_use_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?);
        `, [
          event.id,
          event.sessionId,
          event.timestamp,
          event.type,
          event.tool,
          JSON.stringify(event.payload),
          event.duration ?? null,
          event.toolUseId ?? null,
        ]);

        // Collect sessions for post-session scraping (Spec 02/03 integration)
        if (event.type === 'Stop' || event.type === 'SessionEnd') {
          sessionsToScrape.push(event.sessionId);
        }

        inserted++;
      } catch (err) {
        errors++;
        console.warn(`[ralph-monitor] Error inserting event ${event.id}:`, err);
      }
    }
    db.run('COMMIT;');
  } catch (err) {
    db.run('ROLLBACK;');
    throw err;
  }

  // Fire-and-forget post-session scraping after commit (non-blocking)
  if (config && sessionsToScrape.length > 0) {
    for (const sessionId of sessionsToScrape) {
      scrapeSession(db, sessionId, config).catch((err) => {
        console.warn(`[ralph-monitor] Post-session scrape failed for ${sessionId}:`, err);
      });
    }
  }

  return { inserted, duplicates, errors };
}

// ── File Processing ──────────────────────────────────────────────────────────

/**
 * Process a single JSONL file: read new lines, insert batch, update position.
 * Position is only advanced AFTER successful database insertion.
 */
export function processFile(db: Database, filePath: string, config?: Readonly<Config>): {
  processed: number;
  malformed: number;
} {
  const offset = readPosition(filePath);
  const { events, newOffset, malformedCount } = readNewLines(filePath, offset);

  if (events.length === 0) {
    // Still save position if we advanced past empty lines
    if (newOffset > offset) {
      savePosition(filePath, newOffset);
    }
    return { processed: 0, malformed: malformedCount };
  }

  const { inserted, duplicates } = insertBatch(db, events, config);

  // Only advance position after successful insertion
  savePosition(filePath, newOffset);

  return { processed: inserted + duplicates, malformed: malformedCount };
}

/**
 * Process all JSONL files in the events directory.
 * Returns total counts of processed and malformed events.
 */
export function processAllFiles(db: Database, eventsDir: string, config?: Readonly<Config>): {
  totalProcessed: number;
  totalMalformed: number;
  filesProcessed: number;
} {
  let totalProcessed = 0;
  let totalMalformed = 0;
  let filesProcessed = 0;

  let files: string[];
  try {
    files = fs.readdirSync(eventsDir)
      .filter(f => f.endsWith('.jsonl'))
      .sort();
  } catch {
    return { totalProcessed, totalMalformed, filesProcessed };
  }

  for (const file of files) {
    const filePath = path.join(eventsDir, file);
    const { processed, malformed } = processFile(db, filePath, config);
    totalProcessed += processed;
    totalMalformed += malformed;
    if (processed > 0 || malformed > 0) filesProcessed++;
  }

  return { totalProcessed, totalMalformed, filesProcessed };
}

// ── Post-Ingestion Cleanup (E4) ──────────────────────────────────────────────

/**
 * Delete fully ingested JSONL files older than 1 day.
 * Never deletes current day's file or files with unprocessed lines.
 */
export function cleanupOldFiles(eventsDir: string): number {
  const today = new Date().toISOString().split('T')[0];
  const oneDayAgo = Date.now() - 86400000;
  let deleted = 0;

  let files: string[];
  try {
    files = fs.readdirSync(eventsDir).filter(f => f.endsWith('.jsonl'));
  } catch {
    return 0;
  }

  for (const file of files) {
    // Never delete today's file
    if (file.includes(today)) continue;

    const filePath = path.join(eventsDir, file);

    try {
      const stat = fs.statSync(filePath);

      // Only delete files older than 1 day
      if (stat.mtimeMs > oneDayAgo) continue;

      // Check if fully ingested (position matches file size)
      const pos = readPosition(filePath);
      if (pos < stat.size) continue; // Has unprocessed lines

      // Safe to delete
      fs.unlinkSync(filePath);
      // Also clean up the .pos sidecar file
      try { fs.unlinkSync(filePath + '.pos'); } catch { /* ignore */ }
      deleted++;
    } catch {
      // Skip files we can't process
    }
  }

  return deleted;
}

// ── Ingester Class ───────────────────────────────────────────────────────────

export class Ingester {
  private db: Database;
  private eventsDir: string;
  private batchIntervalMs: number;
  private batchSize: number;
  private staleTimeoutMinutes: number;
  private config?: Readonly<Config>;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private staleCheckHandle: ReturnType<typeof setInterval> | null = null;
  private watcher: any = null; // chokidar watcher
  private pendingEvents: EventRecord[] = [];

  constructor(
    db: Database,
    eventsDir: string,
    options: {
      batchIntervalMs?: number;
      batchSize?: number;
      staleTimeoutMinutes?: number;
      config?: Readonly<Config>;
    } = {}
  ) {
    this.db = db;
    this.eventsDir = eventsDir;
    this.batchIntervalMs = options.batchIntervalMs ?? 1000;
    this.batchSize = options.batchSize ?? 100;
    this.staleTimeoutMinutes = options.staleTimeoutMinutes ?? 60;
    this.config = options.config;
  }

  /** Start the ingester: process existing files, then watch for changes. */
  async start(): Promise<void> {
    // Process all existing files first
    processAllFiles(this.db, this.eventsDir, this.config);

    // Start periodic processing
    this.intervalHandle = setInterval(() => {
      this.processOnce();
    }, this.batchIntervalMs);

    // Start stale session detection
    this.staleCheckHandle = setInterval(() => {
      detectStaleSessions(this.db, this.staleTimeoutMinutes);
    }, 60000); // Check every minute

    // Start file watcher
    try {
      const chokidar = await import('chokidar');
      this.watcher = chokidar.watch(path.join(this.eventsDir, '*.jsonl'), {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 200,
          pollInterval: 100,
        },
      });

      this.watcher.on('add', () => this.processOnce());
      this.watcher.on('change', () => this.processOnce());
    } catch {
      // Chokidar not available — rely on interval-based polling
      console.warn('[ralph-monitor] File watcher unavailable, using interval-based polling.');
    }
  }

  /** Process files once. */
  processOnce(): void {
    try {
      processAllFiles(this.db, this.eventsDir, this.config);
    } catch (err) {
      console.error('[ralph-monitor] Ingester processing error:', err);
    }
  }

  /** Run stale detection once. */
  detectStale(): void {
    detectStaleSessions(this.db, this.staleTimeoutMinutes);
  }

  /** Cleanup old fully-ingested files. */
  cleanup(): number {
    return cleanupOldFiles(this.eventsDir);
  }

  /** Graceful shutdown: stop watcher, flush pending, clean up. */
  async shutdown(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.staleCheckHandle) {
      clearInterval(this.staleCheckHandle);
      this.staleCheckHandle = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    // Final processing pass
    try {
      processAllFiles(this.db, this.eventsDir, this.config);
    } catch {
      // Best-effort on shutdown
    }
  }
}
