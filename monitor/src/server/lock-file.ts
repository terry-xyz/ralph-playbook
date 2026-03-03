/**
 * Lock file utilities for the ingester daemon (Spec 02).
 * Shared by hook-handler (reads lock) and ingester-daemon (writes lock).
 *
 * The lock file contains the PID of the running ingester process.
 * - Written on daemon startup
 * - Removed on clean shutdown
 * - Stale locks (dead PID) are treated as absent
 */

import fs from 'node:fs';

/** Check if a process with the given PID is alive. Cross-platform. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read the PID from a lock file. Returns null if absent or unparseable. */
export function readLockPid(lockPath: string): number | null {
  try {
    const content = fs.readFileSync(lockPath, 'utf-8').trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Check if the ingester daemon is running via lock file.
 * Returns true only if the lock file exists AND the PID is alive.
 */
export function isIngesterRunning(lockPath: string): boolean {
  const pid = readLockPid(lockPath);
  if (pid === null) return false;
  return isPidAlive(pid);
}

/**
 * Write the current process PID to the lock file.
 * Used by the daemon on startup to advertise itself.
 */
export function writeLock(lockPath: string): void {
  fs.writeFileSync(lockPath, String(process.pid), 'utf-8');
}

/**
 * Remove the lock file. Called on clean shutdown.
 * Silently ignores errors (file may already be gone).
 */
export function removeLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Ignore — file may not exist
  }
}
