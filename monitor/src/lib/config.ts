/**
 * Configuration loader and writer for Ralph Monitor.
 * Spec 14: 17 defaults, graceful fallbacks, atomic writes.
 *
 * - Missing config file → all defaults (no error).
 * - Invalid JSON → log warning, use all defaults.
 * - Invalid individual field → default for that field only.
 * - Config object returned is frozen (immutable).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_CONFIG } from '@shared/constants.js';
import type { Config, GuardrailAction, ModelPricing } from '@shared/types.js';

/** Resolve the config file path relative to the monitor root. */
export function resolveConfigPath(monitorRoot: string): string {
  return path.join(monitorRoot, 'ralph-monitor.config.json');
}

/** Validate a single field value against its expected type and constraints. */
function validateField(key: string, value: unknown, defaults: unknown): unknown {
  if (value === undefined || value === null) return defaults;

  switch (key) {
    case 'port': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 65535) return defaults;
      return n;
    }
    case 'staleTimeoutMinutes':
    case 'retentionDays':
    case 'batchSize': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) return defaults;
      return n;
    }
    case 'batchIntervalMs': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 100) return defaults;
      return n;
    }
    case 'mode':
      if (value !== 'auto' && value !== 'manual') return defaults;
      return value;
    case 'theme':
      if (value !== 'dark' && value !== 'light') return defaults;
      return value;
    case 'liveFeedVerbosity':
      if (value !== 'summary' && value !== 'granular') return defaults;
      return value;
    case 'defaultCostRange':
      if (value !== 'today' && value !== 'this week' && value !== 'this month') return defaults;
      return value;
    case 'captureFullResponses':
    case 'captureExtendedThinking':
      if (typeof value !== 'boolean') return defaults;
      return value;
    case 'dataDir':
    case 'claudeDir':
      if (typeof value !== 'string' || value.trim() === '') return defaults;
      return value;
    case 'perSessionCostLimit':
    case 'perDayCostLimit':
      if (value === null) return null;
      if (typeof value === 'number' && value > 0) return value;
      return defaults;
    default:
      return value;
  }
}

/** Validate a guardrail rule's mode field. */
function validateGuardrailMode(mode: unknown): GuardrailAction {
  if (mode === 'block' || mode === 'warn' || mode === 'off') return mode;
  return 'off';
}

/** Validate pricing entry. */
function validatePricing(pricing: unknown): ModelPricing | null {
  if (typeof pricing !== 'object' || pricing === null) return null;
  const p = pricing as Record<string, unknown>;
  const keys = ['inputPer1k', 'outputPer1k', 'cacheCreationPer1k', 'cacheReadPer1k'] as const;
  for (const k of keys) {
    if (typeof p[k] !== 'number' || p[k] < 0) return null;
  }
  return pricing as ModelPricing;
}

/** Deep-merge user config into defaults, validating each field. */
function mergeConfig(userConfig: Record<string, unknown>): Config {
  const result: Config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  // General section
  if (typeof userConfig.general === 'object' && userConfig.general !== null) {
    const g = userConfig.general as Record<string, unknown>;
    result.general.port = validateField('port', g.port, DEFAULT_CONFIG.general.port) as number;
    result.general.dataDir = validateField('dataDir', g.dataDir, DEFAULT_CONFIG.general.dataDir) as string;
    result.general.staleTimeoutMinutes = validateField('staleTimeoutMinutes', g.staleTimeoutMinutes, DEFAULT_CONFIG.general.staleTimeoutMinutes) as number;
    result.general.retentionDays = validateField('retentionDays', g.retentionDays, DEFAULT_CONFIG.general.retentionDays) as number;
  }

  // Ingestion section
  if (typeof userConfig.ingestion === 'object' && userConfig.ingestion !== null) {
    const i = userConfig.ingestion as Record<string, unknown>;
    result.ingestion.batchIntervalMs = validateField('batchIntervalMs', i.batchIntervalMs, DEFAULT_CONFIG.ingestion.batchIntervalMs) as number;
    result.ingestion.batchSize = validateField('batchSize', i.batchSize, DEFAULT_CONFIG.ingestion.batchSize) as number;
    result.ingestion.mode = validateField('mode', i.mode, DEFAULT_CONFIG.ingestion.mode) as 'auto' | 'manual';
  }

  // Scrape section
  if (typeof userConfig.scrape === 'object' && userConfig.scrape !== null) {
    const s = userConfig.scrape as Record<string, unknown>;
    result.scrape.claudeDir = validateField('claudeDir', s.claudeDir, DEFAULT_CONFIG.scrape.claudeDir) as string;
    result.scrape.captureFullResponses = validateField('captureFullResponses', s.captureFullResponses, DEFAULT_CONFIG.scrape.captureFullResponses) as boolean;
    result.scrape.captureExtendedThinking = validateField('captureExtendedThinking', s.captureExtendedThinking, DEFAULT_CONFIG.scrape.captureExtendedThinking) as boolean;
  }

  // Guardrails section — each key is a rule name with mode + params
  if (typeof userConfig.guardrails === 'object' && userConfig.guardrails !== null) {
    const gr = userConfig.guardrails as Record<string, unknown>;
    for (const [ruleName, ruleValue] of Object.entries(gr)) {
      if (typeof ruleValue === 'object' && ruleValue !== null) {
        const rule = ruleValue as Record<string, unknown>;
        result.guardrails[ruleName] = {
          mode: validateGuardrailMode(rule.mode),
          ...(Array.isArray(rule.patterns) ? { patterns: rule.patterns.filter((p: unknown) => typeof p === 'string') } : {}),
          ...(Array.isArray(rule.paths) ? { paths: rule.paths.filter((p: unknown) => typeof p === 'string') } : {}),
          ...(typeof rule.costLimit === 'number' && rule.costLimit > 0 ? { costLimit: rule.costLimit } : {}),
          ...(typeof rule.chainLimit === 'number' && rule.chainLimit > 0 ? { chainLimit: rule.chainLimit } : {}),
          ...(typeof rule.delayMs === 'number' && rule.delayMs >= 0 ? { delayMs: rule.delayMs } : {}),
        };
      }
    }
  }

  // Display section
  if (typeof userConfig.display === 'object' && userConfig.display !== null) {
    const d = userConfig.display as Record<string, unknown>;
    result.display.theme = validateField('theme', d.theme, DEFAULT_CONFIG.display.theme) as 'dark' | 'light';
    result.display.liveFeedVerbosity = validateField('liveFeedVerbosity', d.liveFeedVerbosity, DEFAULT_CONFIG.display.liveFeedVerbosity) as 'summary' | 'granular';
    result.display.defaultCostRange = validateField('defaultCostRange', d.defaultCostRange, DEFAULT_CONFIG.display.defaultCostRange) as 'today' | 'this week' | 'this month';
  }

  // Pricing section — per-model pricing
  if (typeof userConfig.pricing === 'object' && userConfig.pricing !== null) {
    const p = userConfig.pricing as Record<string, unknown>;
    for (const [model, pricing] of Object.entries(p)) {
      const validated = validatePricing(pricing);
      if (validated) {
        result.pricing[model] = validated;
      }
    }
  }

  // Alerts section
  if (typeof userConfig.alerts === 'object' && userConfig.alerts !== null) {
    const a = userConfig.alerts as Record<string, unknown>;
    result.alerts.perSessionCostLimit = validateField('perSessionCostLimit', a.perSessionCostLimit, DEFAULT_CONFIG.alerts.perSessionCostLimit) as number | null;
    result.alerts.perDayCostLimit = validateField('perDayCostLimit', a.perDayCostLimit, DEFAULT_CONFIG.alerts.perDayCostLimit) as number | null;
  }

  return result;
}

/** Deep-freeze an object recursively. */
function deepFreeze<T extends object>(obj: T): Readonly<T> {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
      deepFreeze(value as object);
    }
  }
  return obj;
}

/**
 * Load configuration from disk, merging with defaults.
 * - Missing file → all defaults (silent).
 * - Malformed JSON → warn + all defaults.
 * - Invalid field values → default for that field only.
 * Returns a frozen config object.
 */
export function loadConfig(configPath: string): Readonly<Config> {
  let userConfig: Record<string, unknown> = {};

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        userConfig = parsed;
      } else {
        console.warn(`[ralph-monitor] Config file is not a JSON object, using defaults: ${configPath}`);
      }
    } catch {
      console.warn(`[ralph-monitor] Malformed JSON in config file, using defaults: ${configPath}`);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[ralph-monitor] Could not read config file, using defaults: ${configPath}`);
    }
    // Missing file is silent — use all defaults
  }

  const merged = mergeConfig(userConfig);
  return deepFreeze(merged);
}

/**
 * Write a partial config update to disk.
 * Merges the partial update into the existing file, preserving unmodified fields.
 * Uses atomic write (write to tmp then rename) to prevent corruption.
 */
export function writeConfig(configPath: string, partial: Record<string, unknown>): void {
  // Read existing file content (or empty object if missing/invalid)
  let existing: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      existing = parsed;
    }
  } catch {
    // Start from empty if file doesn't exist or is invalid
  }

  // Deep merge partial into existing
  const merged = deepMerge(existing, partial);

  // Atomic write: write to temp file, then rename
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.ralph-monitor.config.${Date.now()}.tmp`);

  try {
    const json = JSON.stringify(merged, null, 2) + '\n';
    fs.writeFileSync(tmpPath, json, 'utf-8');
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
    throw err;
  }
}

/** Deep merge source into target, returning a new object. */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}
