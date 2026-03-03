/**
 * Shared hook handler logic for all 12 event types.
 * Spec 01: lightweight, async, fire-and-forget, cross-platform.
 *
 * Each hook script calls handleHookEvent() which:
 * 1. Reads JSON from stdin
 * 2. Constructs a normalized event record
 * 3. Appends a JSONL line to the daily rotating file
 * 4. Checks ingester lock file and spawns ingester if needed
 * 5. Exits 0 immediately — errors are swallowed
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { HookEventType, EventRecord } from '@shared/types.js';

/** Resolve the monitor root directory (2 levels up from src/hooks/). */
function getMonitorRoot(): string {
  // In development: __dirname is src/hooks/ → go up to monitor/
  // In production: same logic applies
  return path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..', '..');
}

/** Get today's JSONL event file path. */
export function getEventFilePath(dataDir: string): string {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return path.join(dataDir, 'events', `events-${date}.jsonl`);
}

/** Derive project name from the working directory. */
function deriveProject(cwd: string): string {
  try {
    // Try git remote first
    const { execSync } = require('node:child_process');
    const remote = execSync('git remote get-url origin', {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // Parse org/repo from URL
    const match = remote.match(/[/:]([^/]+\/[^/.]+?)(?:\.git)?$/);
    if (match) return match[1];
  } catch {
    // No git remote — fall back to directory name
  }

  return path.basename(cwd);
}

/** Read all stdin as a string. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
    // Safety timeout — if stdin doesn't close within 5s, proceed
    setTimeout(() => resolve(data), 5000);
  });
}

/** Check if a process with the given PID is alive. Cross-platform. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Check if ingester daemon is running via lock file. */
function isIngesterRunning(lockPath: string): boolean {
  try {
    const content = fs.readFileSync(lockPath, 'utf-8').trim();
    const pid = parseInt(content, 10);
    if (isNaN(pid)) return false;
    return isPidAlive(pid);
  } catch {
    return false;
  }
}

/** Spawn ingester daemon if not already running. */
function ensureIngester(monitorRoot: string, lockPath: string): void {
  if (isIngesterRunning(lockPath)) return;

  try {
    const ingesterScript = path.join(monitorRoot, 'src', 'server', 'ingester-daemon.ts');
    // Use tsx to run TypeScript, or node for compiled JS
    const runner = process.execPath; // node
    const child = spawn(runner, ['--import', 'tsx', ingesterScript], {
      cwd: monitorRoot,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, RALPH_MONITOR_ROOT: monitorRoot },
    });
    child.unref();
  } catch {
    // Swallow — ingester spawn failure should never affect hooks
  }
}

/**
 * Main hook handler. Called by each event-type-specific hook script.
 * Reads stdin, writes JSONL, optionally spawns ingester.
 * NEVER throws — always exits 0.
 */
export async function handleHookEvent(eventType: HookEventType): Promise<void> {
  try {
    const rawInput = await readStdin();

    let payload: Record<string, unknown> = {};
    try {
      if (rawInput.trim()) {
        payload = JSON.parse(rawInput);
      }
    } catch {
      // Malformed JSON from stdin — proceed with empty payload (Spec 01 AC 42)
    }

    const sessionId = payload.session_id as string
      ?? process.env.CLAUDE_SESSION_ID
      ?? `unknown-${Date.now()}`;

    const cwd = process.cwd();

    const eventRecord: EventRecord = {
      id: randomUUID(),
      sessionId,
      timestamp: new Date().toISOString(),
      type: eventType,
      tool: (payload.tool_name as string) ?? null,
      payload,
      project: deriveProject(cwd),
      workspace: cwd,
      ...(payload.tool_use_id ? { toolUseId: payload.tool_use_id as string } : {}),
    };

    // Resolve data directory
    const monitorRoot = getMonitorRoot();
    const dataDir = path.join(monitorRoot, 'data');
    const eventsDir = path.join(dataDir, 'events');

    // Auto-create events directory (Spec 01 AC 40)
    fs.mkdirSync(eventsDir, { recursive: true });

    // Write JSONL line — append mode for concurrent safety
    const eventFilePath = getEventFilePath(dataDir);
    const line = JSON.stringify(eventRecord) + '\n';
    fs.appendFileSync(eventFilePath, line, 'utf-8');

    // Check and optionally spawn ingester
    const lockPath = path.join(dataDir, 'ingester.lock');
    ensureIngester(monitorRoot, lockPath);
  } catch {
    // Swallow ALL errors — hooks must never fail (Spec 01 AC 1-4)
  }
}
