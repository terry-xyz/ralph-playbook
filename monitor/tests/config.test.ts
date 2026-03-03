/**
 * Tests for Phase B: Configuration system (Spec 14 — backend).
 * B1: Config loader with 17 defaults, graceful fallbacks.
 * B2: Config writer with atomic writes and partial updates.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, writeConfig } from '@lib/config.js';
import { DEFAULT_CONFIG } from '@shared/constants.js';

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-config-test-'));
  configPath = path.join(tmpDir, 'ralph-monitor.config.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('B1 — Config file loader', () => {
  it('should return all defaults when config file is missing (AC 2)', () => {
    const config = loadConfig(configPath);
    expect(config.general.port).toBe(9100);
    expect(config.general.dataDir).toBe('./data');
    expect(config.general.staleTimeoutMinutes).toBe(60);
    expect(config.general.retentionDays).toBe(30);
    expect(config.ingestion.batchIntervalMs).toBe(1000);
    expect(config.ingestion.batchSize).toBe(100);
    expect(config.ingestion.mode).toBe('auto');
    expect(config.scrape.claudeDir).toBe('~/.claude');
    expect(config.scrape.captureFullResponses).toBe(false);
    expect(config.scrape.captureExtendedThinking).toBe(true);
    expect(config.display.theme).toBe('dark');
    expect(config.display.liveFeedVerbosity).toBe('summary');
    expect(config.display.defaultCostRange).toBe('today');
    expect(config.alerts.perSessionCostLimit).toBeNull();
    expect(config.alerts.perDayCostLimit).toBeNull();
  });

  it('should not throw when config file is missing (AC 2)', () => {
    expect(() => loadConfig(configPath)).not.toThrow();
  });

  it('should warn and return defaults for malformed JSON (AC 4)', () => {
    fs.writeFileSync(configPath, '{ this is not valid json!!!', 'utf-8');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const config = loadConfig(configPath);

    expect(warnSpy).toHaveBeenCalled();
    expect(config.general.port).toBe(9100);
    expect(config.general.retentionDays).toBe(30);
    warnSpy.mockRestore();
  });

  it('should merge partial config — provided fields override, missing get defaults (AC 3)', () => {
    const partial = {
      general: { port: 8080 },
      display: { theme: 'light' },
    };
    fs.writeFileSync(configPath, JSON.stringify(partial), 'utf-8');

    const config = loadConfig(configPath);
    // Overridden values
    expect(config.general.port).toBe(8080);
    expect(config.display.theme).toBe('light');
    // Defaults for missing fields
    expect(config.general.staleTimeoutMinutes).toBe(60);
    expect(config.general.retentionDays).toBe(30);
    expect(config.ingestion.batchIntervalMs).toBe(1000);
    expect(config.scrape.captureFullResponses).toBe(false);
    expect(config.display.liveFeedVerbosity).toBe('summary');
  });

  it('should fall back to default for invalid field values only (AC 5)', () => {
    const partial = {
      general: {
        port: 8080,        // valid
        retentionDays: -5, // invalid — must be positive
        staleTimeoutMinutes: 'not a number', // invalid
      },
      display: {
        theme: 'neon', // invalid — must be dark or light
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(partial), 'utf-8');

    const config = loadConfig(configPath);
    expect(config.general.port).toBe(8080); // valid, kept
    expect(config.general.retentionDays).toBe(30); // invalid, fell back
    expect(config.general.staleTimeoutMinutes).toBe(60); // invalid, fell back
    expect(config.display.theme).toBe('dark'); // invalid, fell back
  });

  it('should validate port range', () => {
    const cases = [
      { port: 0, expected: 9100 },
      { port: -1, expected: 9100 },
      { port: 65536, expected: 9100 },
      { port: 3000, expected: 3000 },
      { port: 65535, expected: 65535 },
      { port: 1, expected: 1 },
    ];
    for (const { port, expected } of cases) {
      fs.writeFileSync(configPath, JSON.stringify({ general: { port } }), 'utf-8');
      const config = loadConfig(configPath);
      expect(config.general.port).toBe(expected);
    }
  });

  it('should validate ingestion mode', () => {
    fs.writeFileSync(configPath, JSON.stringify({ ingestion: { mode: 'turbo' } }), 'utf-8');
    const config = loadConfig(configPath);
    expect(config.ingestion.mode).toBe('auto'); // invalid → default
  });

  it('should validate verbosity', () => {
    fs.writeFileSync(configPath, JSON.stringify({ display: { liveFeedVerbosity: 'verbose' } }), 'utf-8');
    const config = loadConfig(configPath);
    expect(config.display.liveFeedVerbosity).toBe('summary'); // invalid → default
  });

  it('should validate guardrail rules with proper mode', () => {
    const partial = {
      guardrails: {
        'no-secrets': { mode: 'block', patterns: ['*.env', 'credentials.*'] },
        'bad-rule': { mode: 'invalid' },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(partial), 'utf-8');
    const config = loadConfig(configPath);
    expect(config.guardrails['no-secrets'].mode).toBe('block');
    expect(config.guardrails['no-secrets'].patterns).toEqual(['*.env', 'credentials.*']);
    expect(config.guardrails['bad-rule'].mode).toBe('off'); // invalid mode → off
  });

  it('should validate pricing entries', () => {
    const partial = {
      pricing: {
        'custom-model': {
          inputPer1k: 0.01,
          outputPer1k: 0.05,
          cacheCreationPer1k: 0.02,
          cacheReadPer1k: 0.001,
        },
        'invalid-model': { inputPer1k: 'not a number' }, // invalid
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(partial), 'utf-8');
    const config = loadConfig(configPath);
    expect(config.pricing['custom-model']).toBeDefined();
    expect(config.pricing['custom-model'].inputPer1k).toBe(0.01);
    // Invalid pricing entry should not be added
    expect(config.pricing['invalid-model']).toBeUndefined();
  });

  it('should return a frozen config object (AC frozen)', () => {
    const config = loadConfig(configPath);
    expect(() => {
      (config as any).general.port = 1234;
    }).toThrow();
    expect(() => {
      (config as any).newField = 'test';
    }).toThrow();
  });

  it('should handle all 17 default values being correct (Spec 14 AC 6-22)', () => {
    const config = loadConfig(configPath);
    // General (4)
    expect(config.general.port).toBe(9100);
    expect(config.general.dataDir).toBe('./data');
    expect(config.general.staleTimeoutMinutes).toBe(60);
    expect(config.general.retentionDays).toBe(30);
    // Ingestion (3)
    expect(config.ingestion.batchIntervalMs).toBe(1000);
    expect(config.ingestion.batchSize).toBe(100);
    expect(config.ingestion.mode).toBe('auto');
    // Scrape (3)
    expect(config.scrape.claudeDir).toBe('~/.claude');
    expect(config.scrape.captureFullResponses).toBe(false);
    expect(config.scrape.captureExtendedThinking).toBe(true);
    // Display (3)
    expect(config.display.theme).toBe('dark');
    expect(config.display.liveFeedVerbosity).toBe('summary');
    expect(config.display.defaultCostRange).toBe('today');
    // Pricing (per-model entries exist)
    expect(Object.keys(config.pricing).length).toBeGreaterThan(0);
    // Alerts (2)
    expect(config.alerts.perSessionCostLimit).toBeNull();
    expect(config.alerts.perDayCostLimit).toBeNull();
  });
});

describe('B2 — Config writer', () => {
  it('should write a partial config preserving existing fields (AC 39)', () => {
    // Write initial config
    const initial = { general: { port: 8080 }, display: { theme: 'light' as const } };
    fs.writeFileSync(configPath, JSON.stringify(initial), 'utf-8');

    // Write partial update
    writeConfig(configPath, { general: { retentionDays: 14 } });

    // Read back
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(raw.general.port).toBe(8080); // preserved
    expect(raw.general.retentionDays).toBe(14); // updated
    expect(raw.display.theme).toBe('light'); // preserved
  });

  it('should write valid JSON (AC 40)', () => {
    writeConfig(configPath, { general: { port: 3000 } });
    const raw = fs.readFileSync(configPath, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('should be re-loadable after writing (AC 41)', () => {
    writeConfig(configPath, { general: { port: 7777 }, display: { theme: 'light' } });
    const config = loadConfig(configPath);
    expect(config.general.port).toBe(7777);
    expect(config.display.theme).toBe('light');
  });

  it('should create parent directories if needed', () => {
    const nestedPath = path.join(tmpDir, 'sub', 'dir', 'ralph-monitor.config.json');
    writeConfig(nestedPath, { general: { port: 5555 } });
    expect(fs.existsSync(nestedPath)).toBe(true);
  });

  it('should use atomic write (tmp + rename pattern)', () => {
    // Verify that no .tmp files are left after a successful write
    writeConfig(configPath, { general: { port: 4444 } });
    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter(f => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('should handle writing to non-existent config file (creates new)', () => {
    writeConfig(configPath, { display: { theme: 'light' } });
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(raw.display.theme).toBe('light');
  });

  it('should handle writing to corrupted config file (starts fresh)', () => {
    fs.writeFileSync(configPath, 'not json!!!', 'utf-8');
    writeConfig(configPath, { general: { port: 9999 } });
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(raw.general.port).toBe(9999);
  });

  it('should deep merge nested objects', () => {
    writeConfig(configPath, { general: { port: 8080 } });
    writeConfig(configPath, { general: { retentionDays: 7 } });
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(raw.general.port).toBe(8080); // preserved from first write
    expect(raw.general.retentionDays).toBe(7); // added from second write
  });
});
