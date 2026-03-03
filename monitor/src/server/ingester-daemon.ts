/**
 * Ingester Daemon Entry Point (Spec 02).
 *
 * Standalone process spawned by hook scripts (or manually) to continuously
 * ingest JSONL event files into the SQLite database. Only one instance runs
 * at a time, coordinated via a lock file.
 *
 * Lifecycle:
 * 1. Write PID to lock file (single-instance guarantee)
 * 2. Initialize sql.js storage
 * 3. Start the Ingester (file watcher + periodic processing)
 * 4. Periodically flush DB to disk (bounded data loss window)
 * 5. On SIGINT/SIGTERM: final flush, remove lock file, exit
 */

import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from '@lib/config.js';
import { Storage } from '@lib/storage.js';
import { Ingester } from './ingester.js';
import { writeLock, removeLock, isIngesterRunning } from './lock-file.js';

const monitorRoot = process.env.RALPH_MONITOR_ROOT ?? path.resolve(import.meta.dirname ?? '.', '..', '..');
const configPath = path.join(monitorRoot, 'ralph-monitor.config.json');
const config = loadConfig(configPath);

const dataDir = path.resolve(monitorRoot, config.general.dataDir);
const eventsDir = path.join(dataDir, 'events');
const lockPath = path.join(dataDir, 'ingester.lock');
const dbFilePath = path.join(dataDir, 'ralph-monitor.db');

// Ensure directories exist
fs.mkdirSync(eventsDir, { recursive: true });

// Single-instance check: if another daemon is alive, exit silently
if (isIngesterRunning(lockPath)) {
  process.exit(0);
}

// Write lock file with our PID
writeLock(lockPath);

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    await ingester.shutdown();
  } catch (err) {
    console.error('[ralph-monitor] Ingester shutdown error:', err);
  }

  try {
    await storage.shutdown();
  } catch (err) {
    console.error('[ralph-monitor] Storage shutdown error:', err);
  }

  removeLock(lockPath);
  process.exit(0);
}

// Initialize storage
const storage = new Storage(dbFilePath);
await storage.init();

// Start periodic DB flush (every 5 seconds — bounded data loss window)
storage.startPeriodicFlush(5000);

// Create and start the ingester
const ingester = new Ingester(storage.getDb(), eventsDir, {
  batchIntervalMs: config.ingestion.batchIntervalMs,
  batchSize: config.ingestion.batchSize,
  staleTimeoutMinutes: config.general.staleTimeoutMinutes,
  config,
});

await ingester.start();

// Signal handlers for clean shutdown
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Handle uncaught errors: flush and remove lock before dying
process.on('uncaughtException', async (err) => {
  console.error('[ralph-monitor] Uncaught exception in ingester daemon:', err);
  await shutdown();
});

process.on('unhandledRejection', (reason) => {
  console.error('[ralph-monitor] Unhandled rejection in ingester daemon:', reason);
});

console.log(`[ralph-monitor] Ingester daemon started (PID ${process.pid})`);
