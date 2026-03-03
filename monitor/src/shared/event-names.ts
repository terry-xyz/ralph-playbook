/**
 * Canonical mapping of Claude Code hook event names.
 *
 * IMPORTANT: These names must match Claude Code's actual hook system.
 * Common mistakes to avoid:
 * - PostToolUseFailure (NOT "ToolError")
 * - SubagentStart / SubagentStop (NOT "SubagentSpawn" / "SubagentComplete")
 * - PreCompact (NOT "ContextCompaction")
 * - PermissionRequest (NOT "PermissionDecision")
 */

import type { HookEventType } from './types.js';

/** Human-readable descriptions of each event type. */
export const EVENT_DESCRIPTIONS: Record<HookEventType, string> = {
  PreToolUse: 'Before a tool is executed',
  PostToolUse: 'After a tool completes successfully',
  PostToolUseFailure: 'After a tool call fails',
  UserPromptSubmit: 'When the user submits a prompt',
  Stop: 'When a session ends (normal or error)',
  SubagentStart: 'When a subagent is spawned',
  SubagentStop: 'When a subagent completes',
  PreCompact: 'Before context window compaction',
  Notification: 'System notification event',
  PermissionRequest: 'When a permission decision is requested',
  SessionStart: 'When a new session begins',
  SessionEnd: 'When a session ends',
  ScrapedError: 'Error extracted from post-session scraping',
};

/** Events that indicate session-level activity (used for summary verbosity mode). */
export const SESSION_LEVEL_EVENTS: readonly HookEventType[] = [
  'SessionStart',
  'SessionEnd',
  'Stop',
  'SubagentStart',
  'SubagentStop',
] as const;

/** Events that involve tool calls (have tool_name and tool_use_id). */
export const TOOL_EVENTS: readonly HookEventType[] = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
] as const;

/**
 * Mapping of commonly confused event names to the correct canonical names.
 * Used for validation and documentation clarity.
 */
export const EVENT_NAME_CORRECTIONS: Record<string, HookEventType> = {
  ToolError: 'PostToolUseFailure',
  SubagentSpawn: 'SubagentStart',
  SubagentComplete: 'SubagentStop',
  ContextCompaction: 'PreCompact',
  PermissionDecision: 'PermissionRequest',
};

/** Validate that a string is a valid hook event type. */
export function isValidEventType(type: string): type is HookEventType {
  return type in EVENT_DESCRIPTIONS;
}
