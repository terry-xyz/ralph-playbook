/**
 * Post-Session Scraper (Spec 03, Phase F).
 * Triggered when a Stop/SessionEnd event fires. Finds and parses Claude Code's
 * internal session JSONL files to extract metrics (cost, tokens, model, durations,
 * turn count, errors, extended thinking, full responses).
 *
 * Key constraints:
 * - NEVER throws — all errors caught and logged, returns partial results.
 * - Non-blocking: must never block the agent's exit.
 * - Defensive parsing: Claude's internal format is undocumented.
 * - Distinguishes "absent" (null) vs "zero" (0) for metric fields.
 * - Config is read fresh on each scrape invocation.
 */

import type { Database } from 'sql.js';
import type { Config, CostBreakdown, TokenCounts, ErrorCategory } from '@shared/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

// ── Internal Types ──────────────────────────────────────────────────────────

/** A single parsed conversation turn from a Claude session JSONL file. */
interface ParsedTurn {
  role?: string;
  model?: string;
  costUSD?: number;
  cost?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  durationMs?: number;
  duration_ms?: number;
  apiDurationMs?: number;
  api_duration_ms?: number;
  timestamp?: string;
  error?: string;
  isError?: boolean;
  is_error?: boolean;
  thinking?: string;
  extendedThinking?: string;
  extended_thinking?: string;
  content?: unknown;
  message?: unknown;
  type?: string;
  [key: string]: unknown;
}

/** Accumulated results from parsing a session file. */
interface ParsedSessionData {
  totalCost: number | null;
  tokenBreakdown: TokenCounts | null;
  model: string | null;
  wallClockDurationMs: number | null;
  apiDurationMs: number | null;
  turnCount: number;
  extendedThinking: string[];
  fullResponses: unknown[];
  errors: ClassifiedError[];
  turns: ParsedTurn[];
}

/** An error extracted from session data, classified by category. */
interface ClassifiedError {
  category: ErrorCategory;
  message: string;
  timestamp: string | null;
}

// ── File Discovery ──────────────────────────────────────────────────────────

/**
 * Resolve the Claude directory, expanding ~ to the user's home directory.
 */
function resolveClaudeDir(claudeDir: string): string {
  if (claudeDir.startsWith('~')) {
    return path.join(os.homedir(), claudeDir.slice(1));
  }
  return path.resolve(claudeDir);
}

/**
 * Find the Claude Code session JSONL file for a given session ID.
 * Searches recursively under `{claudeDir}/projects/` for files matching the
 * session ID (either as a filename or containing the ID in the file content).
 *
 * @returns Absolute file path, or null if not found.
 */
export function findSessionFile(claudeDir: string, sessionId: string): string | null {
  try {
    const resolved = resolveClaudeDir(claudeDir);
    const projectsDir = path.join(resolved, 'projects');

    if (!fs.existsSync(projectsDir)) {
      return null;
    }

    // Strategy 1: Search for a file named {sessionId}.jsonl
    const directMatch = searchForFile(projectsDir, `${sessionId}.jsonl`);
    if (directMatch) return directMatch;

    // Strategy 2: Search for files containing the session ID in their name
    const partialMatch = searchForFileContainingName(projectsDir, sessionId);
    if (partialMatch) return partialMatch;

    // Strategy 3: Search file contents for the session ID (more expensive)
    const contentMatch = searchFileContents(projectsDir, sessionId);
    if (contentMatch) return contentMatch;

    return null;
  } catch (err) {
    console.warn(`[ralph-monitor] Error finding session file for ${sessionId}:`, err);
    return null;
  }
}

/**
 * Recursively search for a file with an exact name under a directory.
 * Limits recursion depth to prevent runaway traversal.
 */
function searchForFile(dir: string, filename: string, depth = 0): string | null {
  if (depth > 10) return null;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === filename) {
        return fullPath;
      }
      if (entry.isDirectory()) {
        const result = searchForFile(fullPath, filename, depth + 1);
        if (result) return result;
      }
    }
  } catch {
    // Permission denied or other FS error — skip
  }

  return null;
}

/**
 * Recursively search for a file whose name contains the given substring.
 * Only considers .jsonl files.
 */
function searchForFileContainingName(dir: string, substring: string, depth = 0): string | null {
  if (depth > 10) return null;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(substring)) {
        return fullPath;
      }
      if (entry.isDirectory()) {
        const result = searchForFileContainingName(fullPath, substring, depth + 1);
        if (result) return result;
      }
    }
  } catch {
    // Permission denied or other FS error — skip
  }

  return null;
}

/**
 * Recursively search .jsonl file contents for a session ID string.
 * This is the most expensive strategy — only used as a last resort.
 * Reads only the first 4KB of each file to check for the session ID.
 */
function searchFileContents(dir: string, sessionId: string, depth = 0): string | null {
  if (depth > 10) return null;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const fd = fs.openSync(fullPath, 'r');
          try {
            const buf = Buffer.alloc(4096);
            const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
            const header = buf.toString('utf-8', 0, bytesRead);
            if (header.includes(sessionId)) {
              return fullPath;
            }
          } finally {
            fs.closeSync(fd);
          }
        } catch {
          // Can't read this file — skip
        }
      }
      if (entry.isDirectory()) {
        const result = searchFileContents(fullPath, sessionId, depth + 1);
        if (result) return result;
      }
    }
  } catch {
    // Permission denied or other FS error — skip
  }

  return null;
}

// ── JSONL Parsing ───────────────────────────────────────────────────────────

/**
 * Parse a Claude Code session JSONL file and extract metrics.
 * Each line is a JSON object representing a conversation turn or system event.
 *
 * Never throws — returns partial results on any error.
 * Silently skips unrecognized fields.
 */
export function parseSessionData(filePath: string, config: Readonly<Config>): ParsedSessionData {
  const result: ParsedSessionData = {
    totalCost: null,
    tokenBreakdown: null,
    model: null,
    wallClockDurationMs: null,
    apiDurationMs: null,
    turnCount: 0,
    extendedThinking: [],
    fullResponses: [],
    errors: [],
    turns: [],
  };

  let fileContent: string;
  try {
    fileContent = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.warn(`[ralph-monitor] Could not read session file ${filePath}:`, err);
    return result;
  }

  const lines = fileContent.split('\n');

  // Accumulators for aggregation
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCost = 0;
  let totalApiDurationMs = 0;
  let hasAnyCost = false;
  let hasAnyTokens = false;
  let hasAnyApiDuration = false;
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  let turnCount = 0;
  let detectedModel: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: ParsedTurn;
    try {
      parsed = JSON.parse(trimmed) as ParsedTurn;
    } catch {
      // Skip unparseable lines
      continue;
    }

    if (typeof parsed !== 'object' || parsed === null) continue;

    result.turns.push(parsed);

    // Track timestamps for wall-clock duration
    const ts = extractTimestamp(parsed);
    if (ts) {
      if (!firstTimestamp) firstTimestamp = ts;
      lastTimestamp = ts;
    }

    // Count turns — assistant messages or responses
    if (isAssistantTurn(parsed)) {
      turnCount++;
    }

    // Extract model
    if (parsed.model && typeof parsed.model === 'string') {
      detectedModel = parsed.model;
    }

    // Extract cost
    const lineCost = extractCost(parsed);
    if (lineCost !== null) {
      totalCost += lineCost;
      hasAnyCost = true;
    }

    // Extract token usage
    const usage = extractUsage(parsed);
    if (usage) {
      totalInputTokens += usage.input;
      totalOutputTokens += usage.output;
      totalCacheCreationTokens += usage.cacheCreation;
      totalCacheReadTokens += usage.cacheRead;
      hasAnyTokens = true;
    }

    // Extract API duration
    const apiDur = extractApiDuration(parsed);
    if (apiDur !== null) {
      totalApiDurationMs += apiDur;
      hasAnyApiDuration = true;
    }

    // Extract extended thinking (opt-in via config, default ON)
    if (config.scrape.captureExtendedThinking) {
      const thinking = extractThinking(parsed);
      if (thinking) {
        result.extendedThinking.push(thinking);
      }
    }

    // Extract full responses (opt-in via config, default OFF)
    if (config.scrape.captureFullResponses) {
      const response = extractFullResponse(parsed);
      if (response !== null) {
        result.fullResponses.push(response);
      }
    }

    // Extract errors
    const error = extractError(parsed);
    if (error) {
      result.errors.push(error);
    }
  }

  // Assemble final metrics — distinguish "absent" (null) vs "zero" (0)
  result.totalCost = hasAnyCost ? totalCost : null;

  result.tokenBreakdown = hasAnyTokens
    ? {
        input: totalInputTokens,
        output: totalOutputTokens,
        cacheCreation: totalCacheCreationTokens,
        cacheRead: totalCacheReadTokens,
      }
    : null;

  result.model = detectedModel;
  result.turnCount = turnCount;

  // Wall-clock duration from first to last timestamp
  if (firstTimestamp && lastTimestamp) {
    const startMs = new Date(firstTimestamp).getTime();
    const endMs = new Date(lastTimestamp).getTime();
    if (!isNaN(startMs) && !isNaN(endMs) && endMs >= startMs) {
      result.wallClockDurationMs = endMs - startMs;
    }
  }

  result.apiDurationMs = hasAnyApiDuration ? totalApiDurationMs : null;

  return result;
}

// ── Field Extractors ────────────────────────────────────────────────────────

/** Extract a timestamp string from a parsed turn object. */
function extractTimestamp(turn: ParsedTurn): string | null {
  // Try common timestamp field names
  const candidates = [turn.timestamp, turn['ts'] as string, turn['time'] as string, turn['created_at'] as string];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) {
      // Validate it parses as a date
      const d = new Date(c);
      if (!isNaN(d.getTime())) return c;
    }
  }
  // Also check numeric timestamps (epoch ms)
  const numericCandidates = [turn['timestamp_ms'] as number, turn['created'] as number];
  for (const n of numericCandidates) {
    if (typeof n === 'number' && n > 0) {
      return new Date(n).toISOString();
    }
  }
  return null;
}

/** Determine if a turn represents an assistant response. */
function isAssistantTurn(turn: ParsedTurn): boolean {
  if (turn.role === 'assistant') return true;
  if (turn.type === 'assistant') return true;
  // If it has usage data, it's likely an assistant turn from the API
  if (turn.usage && typeof turn.usage === 'object') return true;
  return false;
}

/** Extract cost (USD) from a turn. Returns null if absent. */
function extractCost(turn: ParsedTurn): number | null {
  // Direct cost fields
  if (typeof turn.costUSD === 'number') return turn.costUSD;
  if (typeof turn.cost === 'number') return turn.cost;

  // Nested cost fields
  const nested = turn['usage'] as Record<string, unknown> | undefined;
  if (nested) {
    if (typeof nested['costUSD'] === 'number') return nested['costUSD'] as number;
    if (typeof nested['cost'] === 'number') return nested['cost'] as number;
  }

  // Check message-level cost
  const message = turn['message'] as Record<string, unknown> | undefined;
  if (message) {
    if (typeof message['costUSD'] === 'number') return message['costUSD'] as number;
    if (typeof message['cost'] === 'number') return message['cost'] as number;
  }

  return null;
}

/** Extract token usage from a turn. Returns null if absent. */
function extractUsage(turn: ParsedTurn): TokenCounts | null {
  // Direct usage field
  let usage = turn.usage;

  // Try nested locations
  if (!usage || typeof usage !== 'object') {
    const message = turn['message'] as Record<string, unknown> | undefined;
    if (message?.['usage'] && typeof message['usage'] === 'object') {
      usage = message['usage'] as ParsedTurn['usage'];
    }
  }

  if (!usage || typeof usage !== 'object') return null;

  const input = safeNonNegativeInt(usage.input_tokens) ?? safeNonNegativeInt((usage as Record<string, unknown>)['inputTokens']);
  const output = safeNonNegativeInt(usage.output_tokens) ?? safeNonNegativeInt((usage as Record<string, unknown>)['outputTokens']);
  const cacheCreation = safeNonNegativeInt(usage.cache_creation_input_tokens)
    ?? safeNonNegativeInt((usage as Record<string, unknown>)['cacheCreationInputTokens']);
  const cacheRead = safeNonNegativeInt(usage.cache_read_input_tokens)
    ?? safeNonNegativeInt((usage as Record<string, unknown>)['cacheReadInputTokens']);

  // If no recognized token fields at all, return null (absent)
  if (input === null && output === null && cacheCreation === null && cacheRead === null) {
    return null;
  }

  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheCreation: cacheCreation ?? 0,
    cacheRead: cacheRead ?? 0,
  };
}

/** Safely extract a non-negative integer, or null if not valid. */
function safeNonNegativeInt(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/** Extract API call duration in milliseconds from a turn. Returns null if absent. */
function extractApiDuration(turn: ParsedTurn): number | null {
  const candidates = [
    turn.apiDurationMs,
    turn.api_duration_ms,
    turn.durationMs,
    turn.duration_ms,
    (turn as Record<string, unknown>)['api_duration'],
    (turn as Record<string, unknown>)['duration'],
  ];

  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c >= 0) {
      return c;
    }
  }

  // Check nested message
  const message = turn['message'] as Record<string, unknown> | undefined;
  if (message) {
    const msgCandidates = [
      message['durationMs'],
      message['duration_ms'],
      message['apiDurationMs'],
      message['api_duration_ms'],
    ];
    for (const c of msgCandidates) {
      if (typeof c === 'number' && Number.isFinite(c) && c >= 0) {
        return c;
      }
    }
  }

  return null;
}

/** Extract extended thinking text from a turn. */
function extractThinking(turn: ParsedTurn): string | null {
  const candidates = [
    turn.thinking,
    turn.extendedThinking,
    turn.extended_thinking,
    (turn as Record<string, unknown>)['thinking_content'],
  ];

  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) {
      return c;
    }
  }

  // Check content blocks for thinking type
  const content = turn.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        typeof block === 'object' &&
        block !== null &&
        (block as Record<string, unknown>)['type'] === 'thinking' &&
        typeof (block as Record<string, unknown>)['thinking'] === 'string'
      ) {
        return (block as Record<string, unknown>)['thinking'] as string;
      }
    }
  }

  return null;
}

/** Extract the full response content from a turn. Returns null if not an assistant turn. */
function extractFullResponse(turn: ParsedTurn): unknown | null {
  if (!isAssistantTurn(turn)) return null;

  // Prefer content field
  if (turn.content !== undefined) return turn.content;

  // Try message.content
  const message = turn['message'] as Record<string, unknown> | undefined;
  if (message?.['content'] !== undefined) return message['content'];

  return null;
}

/** Extract and classify an error from a turn. */
function extractError(turn: ParsedTurn): ClassifiedError | null {
  const hasError =
    turn.error ||
    turn.isError === true ||
    turn.is_error === true ||
    (turn as Record<string, unknown>)['is_error'] === true;

  if (!hasError) return null;

  const message = typeof turn.error === 'string'
    ? turn.error
    : typeof (turn as Record<string, unknown>)['error_message'] === 'string'
      ? (turn as Record<string, unknown>)['error_message'] as string
      : 'Unknown error';

  const category = classifyErrorMessage(message);
  const timestamp = extractTimestamp(turn);

  return { category, message, timestamp };
}

/** Classify an error message into a category. */
function classifyErrorMessage(message: string): ErrorCategory {
  const lower = message.toLowerCase();

  if (lower.includes('rate limit') || lower.includes('429') || lower.includes('too many requests')) {
    return 'rate_limit';
  }
  if (lower.includes('auth') || lower.includes('401') || lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('403')) {
    return 'auth_error';
  }
  if (lower.includes('billing') || lower.includes('payment') || lower.includes('quota') || lower.includes('credit')) {
    return 'billing_error';
  }
  if (lower.includes('500') || lower.includes('502') || lower.includes('503') || lower.includes('internal server error') || lower.includes('service unavailable')) {
    return 'server_error';
  }

  return 'tool_failure';
}

// ── Cost Calculation ────────────────────────────────────────────────────────

/**
 * Compute a cost breakdown from token counts using configured pricing.
 * Falls back to zero costs if no pricing is configured for the model.
 */
function computeCostBreakdown(
  tokens: TokenCounts,
  model: string | null,
  config: Readonly<Config>,
): CostBreakdown {
  const pricing = model ? config.pricing[model] : null;

  if (!pricing) {
    return {
      inputCost: 0,
      outputCost: 0,
      cacheCreationCost: 0,
      cacheReadCost: 0,
    };
  }

  return {
    inputCost: (tokens.input / 1000) * pricing.inputPer1k,
    outputCost: (tokens.output / 1000) * pricing.outputPer1k,
    cacheCreationCost: (tokens.cacheCreation / 1000) * pricing.cacheCreationPer1k,
    cacheReadCost: (tokens.cacheRead / 1000) * pricing.cacheReadPer1k,
  };
}

// ── Database Operations ─────────────────────────────────────────────────────

/**
 * UPSERT metrics into the metrics table (INSERT OR REPLACE).
 */
function upsertMetrics(
  db: Database,
  sessionId: string,
  costBreakdown: CostBreakdown,
  tokenBreakdown: TokenCounts,
  model: string | null,
  wallClockDuration: number | null,
  apiDuration: number | null,
  turnCount: number,
): void {
  db.run(`
    INSERT OR REPLACE INTO metrics (
      session_id, cost_breakdown, token_breakdown, model,
      wall_clock_duration, api_duration, turn_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?);
  `, [
    sessionId,
    JSON.stringify(costBreakdown),
    JSON.stringify(tokenBreakdown),
    model,
    wallClockDuration,
    apiDuration,
    turnCount,
  ]);
}

/**
 * Insert scraped errors as ScrapedError events and update session error_count.
 */
function persistScrapedErrors(
  db: Database,
  sessionId: string,
  errors: ClassifiedError[],
): void {
  if (errors.length === 0) return;

  for (const error of errors) {
    const eventId = `scraped-${randomUUID()}`;
    const timestamp = error.timestamp ?? new Date().toISOString();
    const payload = JSON.stringify({
      error: error.message,
      category: error.category,
      source: 'scraper',
    });

    db.run(`
      INSERT OR IGNORE INTO events (event_id, session_id, timestamp, type, tool_name, payload, duration, tool_use_id)
      VALUES (?, ?, ?, 'ScrapedError', NULL, ?, NULL, NULL);
    `, [eventId, sessionId, timestamp, payload]);
  }

  // Increment session error_count by the number of scraped errors
  db.run(`
    UPDATE sessions SET error_count = COALESCE(error_count, 0) + ? WHERE session_id = ?;
  `, [errors.length, sessionId]);
}

/**
 * Update the sessions table with extracted totals.
 */
function updateSessionTotals(
  db: Database,
  sessionId: string,
  totalCost: number,
  tokenCounts: TokenCounts,
  model: string | null,
  turnCount: number,
): void {
  // Only update fields that have actual values — don't overwrite with defaults
  // if the session already has better data.
  db.run(`
    UPDATE sessions SET
      total_cost = MAX(total_cost, ?),
      token_counts = ?,
      turn_count = MAX(turn_count, ?),
      model = COALESCE(?, model)
    WHERE session_id = ?;
  `, [
    totalCost,
    JSON.stringify(tokenCounts),
    turnCount,
    model,
    sessionId,
  ]);
}

// ── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Scrape metrics for a completed session.
 * This is the main entry point, triggered when a Stop or SessionEnd event fires.
 *
 * Finds the Claude Code session file, parses it for metrics, and writes
 * the results to the database. Never throws — all errors are caught and logged.
 *
 * @param db - sql.js Database instance
 * @param sessionId - The session ID from the hook payload
 * @param config - Current configuration (read fresh each time)
 */
export async function scrapeSession(
  db: Database,
  sessionId: string,
  config: Readonly<Config>,
): Promise<void> {
  try {
    // Find the session file
    const filePath = findSessionFile(config.scrape.claudeDir, sessionId);

    if (!filePath) {
      console.warn(`[ralph-monitor] No session file found for ${sessionId}, skipping scrape.`);
      return;
    }

    // Parse the session data
    const data = parseSessionData(filePath, config);

    // Build token breakdown — use parsed data or default to zeros
    const tokenBreakdown: TokenCounts = data.tokenBreakdown ?? {
      input: 0,
      output: 0,
      cacheCreation: 0,
      cacheRead: 0,
    };

    // Build cost breakdown
    let costBreakdown: CostBreakdown;
    if (data.totalCost !== null && data.tokenBreakdown) {
      // We have both direct cost and tokens — compute detailed breakdown
      costBreakdown = computeCostBreakdown(data.tokenBreakdown, data.model, config);

      // If the computed total differs significantly from the reported total,
      // prefer the reported total and distribute proportionally
      const computedTotal =
        costBreakdown.inputCost +
        costBreakdown.outputCost +
        costBreakdown.cacheCreationCost +
        costBreakdown.cacheReadCost;

      if (computedTotal > 0 && Math.abs(computedTotal - data.totalCost) / computedTotal > 0.01) {
        const scale = data.totalCost / computedTotal;
        costBreakdown.inputCost *= scale;
        costBreakdown.outputCost *= scale;
        costBreakdown.cacheCreationCost *= scale;
        costBreakdown.cacheReadCost *= scale;
      }
    } else if (data.tokenBreakdown) {
      // Only tokens — compute cost from pricing config
      costBreakdown = computeCostBreakdown(data.tokenBreakdown, data.model, config);
    } else {
      // No token data — put total cost into inputCost as a catch-all
      costBreakdown = {
        inputCost: data.totalCost ?? 0,
        outputCost: 0,
        cacheCreationCost: 0,
        cacheReadCost: 0,
      };
    }

    // Convert durations from ms to seconds for storage
    const wallClockDuration = data.wallClockDurationMs !== null
      ? data.wallClockDurationMs / 1000
      : null;
    const apiDuration = data.apiDurationMs !== null
      ? data.apiDurationMs / 1000
      : null;

    // Compute total cost for session update
    const totalCost = data.totalCost
      ?? (costBreakdown.inputCost + costBreakdown.outputCost + costBreakdown.cacheCreationCost + costBreakdown.cacheReadCost);

    // Write to database — wrap in try/catch to never block
    try {
      upsertMetrics(
        db,
        sessionId,
        costBreakdown,
        tokenBreakdown,
        data.model,
        wallClockDuration,
        apiDuration,
        data.turnCount,
      );

      updateSessionTotals(
        db,
        sessionId,
        totalCost,
        tokenBreakdown,
        data.model,
        data.turnCount,
      );

      // Persist scraped errors as ScrapedError events (Spec 03 AC 6)
      persistScrapedErrors(db, sessionId, data.errors);
    } catch (dbErr) {
      console.error(`[ralph-monitor] Database error during scrape for session ${sessionId}:`, dbErr);
    }
  } catch (err) {
    console.error(`[ralph-monitor] Unexpected error scraping session ${sessionId}:`, err);
  }
}
