/**
 * Tests for Phase A4: Shared types, constants, event-name mapping.
 * Validates that all 12 event types, 4 session statuses, 8 phases,
 * and default config values are correct per specifications.
 */

import { describe, it, expect } from 'vitest';
import {
  HOOK_EVENT_TYPES,
  SESSION_STATUSES,
  SESSION_PHASES,
  DEFAULT_CONFIG,
  DEFAULT_PORT,
} from '@shared/constants.js';
import {
  EVENT_DESCRIPTIONS,
  SESSION_LEVEL_EVENTS,
  TOOL_EVENTS,
  EVENT_NAME_CORRECTIONS,
  isValidEventType,
} from '@shared/event-names.js';
import type {
  HookEventType,
  SessionStatus,
  SessionPhase,
  Config,
} from '@shared/types.js';

describe('A4 — Shared types and constants', () => {
  describe('Event types', () => {
    it('should define exactly 12 hook event types', () => {
      expect(HOOK_EVENT_TYPES).toHaveLength(12);
    });

    it('should include all 12 required event types', () => {
      const required: HookEventType[] = [
        'PreToolUse',
        'PostToolUse',
        'PostToolUseFailure',
        'UserPromptSubmit',
        'Stop',
        'SubagentStart',
        'SubagentStop',
        'PreCompact',
        'Notification',
        'PermissionRequest',
        'SessionStart',
        'SessionEnd',
      ];
      for (const type of required) {
        expect(HOOK_EVENT_TYPES).toContain(type);
      }
    });

    it('should have descriptions for all 12 event types', () => {
      expect(Object.keys(EVENT_DESCRIPTIONS)).toHaveLength(12);
      for (const type of HOOK_EVENT_TYPES) {
        expect(EVENT_DESCRIPTIONS[type]).toBeDefined();
        expect(typeof EVENT_DESCRIPTIONS[type]).toBe('string');
      }
    });

    it('should use correct event names (not common mistakes)', () => {
      // These are the CORRECT names per Claude Code's hook system
      expect(HOOK_EVENT_TYPES).toContain('PostToolUseFailure');
      expect(HOOK_EVENT_TYPES).not.toContain('ToolError');

      expect(HOOK_EVENT_TYPES).toContain('SubagentStart');
      expect(HOOK_EVENT_TYPES).toContain('SubagentStop');
      expect(HOOK_EVENT_TYPES).not.toContain('SubagentSpawn');
      expect(HOOK_EVENT_TYPES).not.toContain('SubagentComplete');

      expect(HOOK_EVENT_TYPES).toContain('PreCompact');
      expect(HOOK_EVENT_TYPES).not.toContain('ContextCompaction');

      expect(HOOK_EVENT_TYPES).toContain('PermissionRequest');
      expect(HOOK_EVENT_TYPES).not.toContain('PermissionDecision');
    });

    it('should map common incorrect names to correct ones', () => {
      expect(EVENT_NAME_CORRECTIONS['ToolError']).toBe('PostToolUseFailure');
      expect(EVENT_NAME_CORRECTIONS['SubagentSpawn']).toBe('SubagentStart');
      expect(EVENT_NAME_CORRECTIONS['SubagentComplete']).toBe('SubagentStop');
      expect(EVENT_NAME_CORRECTIONS['ContextCompaction']).toBe('PreCompact');
      expect(EVENT_NAME_CORRECTIONS['PermissionDecision']).toBe('PermissionRequest');
    });

    it('should validate event types correctly', () => {
      expect(isValidEventType('PreToolUse')).toBe(true);
      expect(isValidEventType('PostToolUse')).toBe(true);
      expect(isValidEventType('InvalidType')).toBe(false);
      expect(isValidEventType('ToolError')).toBe(false);
    });

    it('should categorize session-level events', () => {
      expect(SESSION_LEVEL_EVENTS).toContain('SessionStart');
      expect(SESSION_LEVEL_EVENTS).toContain('SessionEnd');
      expect(SESSION_LEVEL_EVENTS).toContain('Stop');
      expect(SESSION_LEVEL_EVENTS).toContain('SubagentStart');
      expect(SESSION_LEVEL_EVENTS).toContain('SubagentStop');
      // Tool events are NOT session-level
      expect(SESSION_LEVEL_EVENTS).not.toContain('PreToolUse');
      expect(SESSION_LEVEL_EVENTS).not.toContain('PostToolUse');
    });

    it('should categorize tool events', () => {
      expect(TOOL_EVENTS).toContain('PreToolUse');
      expect(TOOL_EVENTS).toContain('PostToolUse');
      expect(TOOL_EVENTS).toContain('PostToolUseFailure');
      expect(TOOL_EVENTS).toHaveLength(3);
    });
  });

  describe('Session statuses', () => {
    it('should define exactly 4 session statuses', () => {
      expect(SESSION_STATUSES).toHaveLength(4);
    });

    it('should contain running, completed, errored, stale', () => {
      expect(SESSION_STATUSES).toContain('running');
      expect(SESSION_STATUSES).toContain('completed');
      expect(SESSION_STATUSES).toContain('errored');
      expect(SESSION_STATUSES).toContain('stale');
    });

    // Type-level test: verify the SessionStatus type only allows 4 values.
    // This is a compile-time check — if these assignments compile, the type is correct.
    it('should have type-safe session status values', () => {
      const running: SessionStatus = 'running';
      const completed: SessionStatus = 'completed';
      const errored: SessionStatus = 'errored';
      const stale: SessionStatus = 'stale';
      expect([running, completed, errored, stale]).toHaveLength(4);
    });
  });

  describe('Session phases', () => {
    it('should define exactly 8 inferred agent phases', () => {
      expect(SESSION_PHASES).toHaveLength(8);
    });

    it('should contain all 8 phases', () => {
      const expected: SessionPhase[] = [
        'Reading the plan',
        'Orienting',
        'Investigating code',
        'Implementing',
        'Validating',
        'Committing',
        'Updating the plan',
        'Delegating',
      ];
      for (const phase of expected) {
        expect(SESSION_PHASES).toContain(phase);
      }
    });
  });

  describe('Default configuration (Spec 14)', () => {
    it('should have all 7 config sections', () => {
      expect(DEFAULT_CONFIG).toHaveProperty('general');
      expect(DEFAULT_CONFIG).toHaveProperty('ingestion');
      expect(DEFAULT_CONFIG).toHaveProperty('scrape');
      expect(DEFAULT_CONFIG).toHaveProperty('guardrails');
      expect(DEFAULT_CONFIG).toHaveProperty('display');
      expect(DEFAULT_CONFIG).toHaveProperty('pricing');
      expect(DEFAULT_CONFIG).toHaveProperty('alerts');
    });

    it('should have correct general defaults (Spec 14 AC 6-9)', () => {
      expect(DEFAULT_CONFIG.general.port).toBe(9100);
      expect(DEFAULT_CONFIG.general.dataDir).toBe('./data');
      expect(DEFAULT_CONFIG.general.staleTimeoutMinutes).toBe(60);
      expect(DEFAULT_CONFIG.general.retentionDays).toBe(30);
    });

    it('should have correct ingestion defaults (Spec 14 AC 10-12)', () => {
      expect(DEFAULT_CONFIG.ingestion.batchIntervalMs).toBe(1000);
      expect(DEFAULT_CONFIG.ingestion.batchSize).toBe(100);
      expect(DEFAULT_CONFIG.ingestion.mode).toBe('auto');
    });

    it('should have correct scrape defaults (Spec 14 AC 13-15)', () => {
      expect(DEFAULT_CONFIG.scrape.claudeDir).toBe('~/.claude');
      expect(DEFAULT_CONFIG.scrape.captureFullResponses).toBe(false);
      expect(DEFAULT_CONFIG.scrape.captureExtendedThinking).toBe(true);
    });

    it('should have correct display defaults (Spec 14 AC 16-18)', () => {
      expect(DEFAULT_CONFIG.display.theme).toBe('dark');
      expect(DEFAULT_CONFIG.display.liveFeedVerbosity).toBe('summary');
      expect(DEFAULT_CONFIG.display.defaultCostRange).toBe('today');
    });

    it('should have per-model pricing entries', () => {
      expect(Object.keys(DEFAULT_CONFIG.pricing).length).toBeGreaterThan(0);
      for (const modelPricing of Object.values(DEFAULT_CONFIG.pricing)) {
        expect(modelPricing).toHaveProperty('inputPer1k');
        expect(modelPricing).toHaveProperty('outputPer1k');
        expect(modelPricing).toHaveProperty('cacheCreationPer1k');
        expect(modelPricing).toHaveProperty('cacheReadPer1k');
      }
    });

    it('should have null alert thresholds by default', () => {
      expect(DEFAULT_CONFIG.alerts.perSessionCostLimit).toBeNull();
      expect(DEFAULT_CONFIG.alerts.perDayCostLimit).toBeNull();
    });

    it('should use the correct default port constant', () => {
      expect(DEFAULT_PORT).toBe(9100);
      expect(DEFAULT_CONFIG.general.port).toBe(DEFAULT_PORT);
    });
  });
});
