/**
 * Ralph Monitor setup wizard.
 *
 * 7-step interactive flow:
 *   1. Claude Code detection (check for ~/.claude/settings.json)
 *   2. Hook scope selection (global vs project)
 *   3. Monitoring hook injection (all 12 async hook types)
 *   4. Existing hook preservation (merge, skip duplicates)
 *   5. Optional guardrail hooks (sync blocking hooks)
 *   6. Config file generation (ralph-monitor.config.json)
 *   7. Verification (write test event, confirm success)
 *
 * Uses only Node built-ins: readline, fs, path, os.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { HOOK_EVENT_TYPES, DEFAULT_CONFIG, CONFIG_FILENAME } from '../shared/constants.js';
import type { HookEventType, Config } from '../shared/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a readline interface for interactive prompts. */
function createRl(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

/** Prompt the user and return their answer. */
function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

/** Prompt the user with a yes/no question. Returns true for yes. */
async function confirm(rl: readline.Interface, question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = await ask(rl, `${question} ${hint} `);
  if (answer === '') return defaultYes;
  return answer.toLowerCase().startsWith('y');
}

/** Print a section header. */
function header(step: number, title: string): void {
  console.log(`\n--- Step ${step}/7: ${title} ---\n`);
}

/** Print a success line. */
function success(msg: string): void {
  console.log(`  [OK] ${msg}`);
}

/** Print a warning line. */
function warn(msg: string): void {
  console.log(`  [WARN] ${msg}`);
}

/** Print an info line. */
function info(msg: string): void {
  console.log(`  ${msg}`);
}

// ── Hook Event Type to Script Filename Mapping ──────────────────────────────

/**
 * Convert a HookEventType like "PreToolUse" to the corresponding
 * script filename like "pre-tool-use".
 */
function hookTypeToFilename(hookType: HookEventType): string {
  const map: Record<HookEventType, string> = {
    PreToolUse: 'pre-tool-use',
    PostToolUse: 'post-tool-use',
    PostToolUseFailure: 'post-tool-use-failure',
    UserPromptSubmit: 'user-prompt-submit',
    Stop: 'stop',
    SubagentStart: 'subagent-start',
    SubagentStop: 'subagent-stop',
    PreCompact: 'pre-compact',
    Notification: 'notification',
    PermissionRequest: 'permission-request',
    SessionStart: 'session-start',
    SessionEnd: 'session-end',
    ScrapedError: 'scraped-error',
  };
  return map[hookType];
}

// ── Hook Entry Types ────────────────────────────────────────────────────────

interface HookEntry {
  type: 'command';
  command: string;
}

interface SettingsJson {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

// ── Main Wizard ─────────────────────────────────────────────────────────────

export async function runSetupWizard(): Promise<void> {
  console.log('\nRalph Monitor Setup Wizard');
  console.log('=========================\n');
  console.log('This wizard will configure Claude Code hooks to stream events');
  console.log('into Ralph Monitor for real-time session monitoring.\n');

  const rl = createRl();

  try {
    // ── Step 1: Claude Code Detection ──────────────────────────────────────
    const globalSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const claudeDetected = await stepDetectClaude(globalSettingsPath);
    if (!claudeDetected) {
      rl.close();
      return;
    }

    // ── Step 2: Hook Scope Selection ───────────────────────────────────────
    const settingsPath = await stepSelectScope(rl, globalSettingsPath);

    // ── Step 3 & 4: Monitoring Hook Injection + Preservation ───────────────
    const monitorRoot = resolveMonitorRoot();
    const hooksAdded = await stepInjectHooks(rl, settingsPath, monitorRoot, false);

    // ── Step 5: Optional Guardrail Hooks ───────────────────────────────────
    const guardrailsAdded = await stepGuardrailHooks(rl, settingsPath, monitorRoot);

    // ── Step 6: Config File Generation ─────────────────────────────────────
    await stepGenerateConfig(rl, monitorRoot);

    // ── Step 7: Verification ───────────────────────────────────────────────
    await stepVerify(monitorRoot);

    // ── Summary ────────────────────────────────────────────────────────────
    console.log('\n=========================');
    console.log('Setup complete!\n');
    console.log(`  Settings file : ${settingsPath}`);
    console.log(`  Hooks injected: ${hooksAdded} monitoring hooks`);
    if (guardrailsAdded > 0) {
      console.log(`  Guardrail hooks: ${guardrailsAdded} sync hooks`);
    }
    console.log(`  Config file   : ${path.join(monitorRoot, CONFIG_FILENAME)}`);
    console.log('\nNext steps:');
    console.log('  1. Start the dashboard:  npx ralph-monitor start');
    console.log('  2. Open in browser:      http://localhost:9100');
    console.log('  3. Use Claude Code as normal — events will stream in automatically.\n');
  } catch (err) {
    if (err instanceof Error && err.message === 'WIZARD_ABORT') {
      console.log('\nSetup cancelled.\n');
    } else {
      console.error('\nSetup failed:', err instanceof Error ? err.message : err);
    }
    process.exit(1);
  } finally {
    rl.close();
  }
}

// ── Step Implementations ────────────────────────────────────────────────────

/**
 * Step 1: Check if Claude Code is installed by looking for ~/.claude/settings.json
 * or the ~/.claude directory.
 */
async function stepDetectClaude(globalSettingsPath: string): Promise<boolean> {
  header(1, 'Claude Code Detection');

  const claudeDir = path.dirname(globalSettingsPath);

  if (fs.existsSync(claudeDir)) {
    success('Claude Code directory found: ' + claudeDir);

    if (fs.existsSync(globalSettingsPath)) {
      success('Global settings file found: ' + globalSettingsPath);
    } else {
      info('Global settings file not found — it will be created during hook injection.');
    }

    return true;
  }

  console.log('  Claude Code does not appear to be installed.');
  console.log(`  Expected directory: ${claudeDir}`);
  console.log('');
  console.log('  Please install Claude Code first:');
  console.log('    https://docs.anthropic.com/en/docs/claude-code');
  console.log('');
  console.log('  After installing, run this wizard again:');
  console.log('    npx ralph-monitor init');
  console.log('');

  return false;
}

/**
 * Step 2: Ask the user whether to install hooks globally or for the current project.
 */
async function stepSelectScope(
  rl: readline.Interface,
  globalSettingsPath: string,
): Promise<string> {
  header(2, 'Hook Scope Selection');

  info('Where should monitoring hooks be installed?\n');
  info('  1) Global  — All Claude Code sessions (~/.claude/settings.json)');
  info('  2) Project — Only this project (.claude/settings.json in CWD)\n');

  let choice = '';
  while (choice !== '1' && choice !== '2') {
    choice = await ask(rl, 'Select scope [1/2] (default: 1): ');
    if (choice === '') choice = '1';
    if (choice !== '1' && choice !== '2') {
      info('Please enter 1 or 2.');
    }
  }

  if (choice === '1') {
    success('Using global scope: ' + globalSettingsPath);
    return globalSettingsPath;
  }

  const projectSettingsPath = path.join(process.cwd(), '.claude', 'settings.json');
  success('Using project scope: ' + projectSettingsPath);
  return projectSettingsPath;
}

/**
 * Resolve the ralph-monitor package root directory.
 * Works from both src/cli/ (development) and dist/server/cli/ (production).
 */
function resolveMonitorRoot(): string {
  const thisDir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
  // Walk up until we find package.json with name "ralph-monitor"
  let dir = path.resolve(thisDir);
  for (let i = 0; i < 10; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === 'ralph-monitor') return dir;
      } catch {
        // Continue searching
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  // Fallback: assume 2 levels up from this file
  return path.resolve(thisDir, '..', '..');
}

/**
 * Steps 3 & 4: Inject monitoring hooks into the settings file.
 * Merges with existing hooks — never overwrites.
 * Detects duplicates from previous runs and skips them.
 *
 * Returns the number of hooks added.
 */
async function stepInjectHooks(
  _rl: readline.Interface,
  settingsPath: string,
  monitorRoot: string,
  _isGuardrail: boolean,
): Promise<number> {
  header(3, 'Monitoring Hook Injection');

  // Read existing settings or start fresh
  let settings: SettingsJson = {};
  const settingsDir = path.dirname(settingsPath);

  if (fs.existsSync(settingsPath)) {
    try {
      const raw = fs.readFileSync(settingsPath, 'utf-8');
      settings = JSON.parse(raw);
      success('Loaded existing settings file.');
    } catch (err) {
      warn(`Failed to parse ${settingsPath}: ${err instanceof Error ? err.message : err}`);
      warn('Starting with empty settings object.');
    }
  } else {
    info('Settings file does not exist — will create it.');
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  header(4, 'Existing Hook Preservation');

  // Count existing hooks for reporting
  let existingHookCount = 0;
  for (const hookType of Object.keys(settings.hooks)) {
    existingHookCount += settings.hooks[hookType]?.length ?? 0;
  }
  if (existingHookCount > 0) {
    info(`Found ${existingHookCount} existing hook(s) — these will be preserved.`);
  } else {
    info('No existing hooks found.');
  }

  // Build the hook commands for all 12 event types
  // Use the dist path for compiled JS hooks
  const hooksDir = path.join(monitorRoot, 'dist', 'server', 'hooks');
  let addedCount = 0;
  let skippedCount = 0;

  // Marker to identify ralph-monitor hook commands
  const RALPH_MARKER = 'ralph-monitor';

  for (const hookType of HOOK_EVENT_TYPES) {
    const scriptName = hookTypeToFilename(hookType);
    const scriptPath = path.join(hooksDir, `${scriptName}.js`);
    // Normalize path separators to forward slashes for cross-platform compatibility
    const normalizedPath = scriptPath.replace(/\\/g, '/');
    const command = `node "${normalizedPath}"`;

    if (!settings.hooks[hookType]) {
      settings.hooks[hookType] = [];
    }

    // Check for duplicates: skip if a ralph-monitor hook already exists for this type
    const isDuplicate = settings.hooks[hookType].some(
      (entry: HookEntry) =>
        entry.type === 'command' && entry.command.includes(RALPH_MARKER),
    );

    if (isDuplicate) {
      skippedCount++;
      continue;
    }

    // Add the async monitoring hook
    settings.hooks[hookType].push({
      type: 'command',
      command,
    });

    addedCount++;
  }

  if (skippedCount > 0) {
    info(`Skipped ${skippedCount} hook(s) — already installed from a previous run.`);
  }

  // Write the settings file
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');

  if (addedCount > 0) {
    success(`Injected ${addedCount} async monitoring hook(s) into ${settingsPath}`);
  } else {
    info('All monitoring hooks were already installed.');
  }

  return addedCount;
}

/**
 * Step 5: Optionally add sync guardrail hooks alongside monitoring hooks.
 * Guardrail hooks are synchronous (blocking) — they can prevent tool use.
 *
 * Returns the number of guardrail hooks added.
 */
async function stepGuardrailHooks(
  rl: readline.Interface,
  settingsPath: string,
  monitorRoot: string,
): Promise<number> {
  header(5, 'Optional Guardrail Hooks');

  info('Guardrail hooks add real-time protection against dangerous operations.');
  info('They run synchronously and can block tool calls before execution.');
  info('(e.g., prevent writes to sensitive files, limit cost per session)\n');

  const wantGuardrails = await confirm(rl, 'Enable guardrail hooks?', false);

  if (!wantGuardrails) {
    info('Skipping guardrail hooks. You can add them later by re-running init.');
    return 0;
  }

  // Read the settings file we just wrote
  let settings: SettingsJson = {};
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    settings = JSON.parse(raw);
  } catch {
    warn('Could not read settings file. Skipping guardrail injection.');
    return 0;
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  // Guardrail hooks are sync variants that run before tool execution.
  // They're only relevant for PreToolUse (the main blocking point).
  const guardrailTypes: HookEventType[] = ['PreToolUse'];
  const hooksDir = path.join(monitorRoot, 'dist', 'server', 'hooks');
  const GUARDRAIL_MARKER = 'ralph-monitor/guardrail';
  let addedCount = 0;

  for (const hookType of guardrailTypes) {
    const scriptPath = path.join(hooksDir, 'guardrail-pre-tool-use.js');
    const normalizedPath = scriptPath.replace(/\\/g, '/');
    const command = `node "${normalizedPath}" # ${GUARDRAIL_MARKER}`;

    if (!settings.hooks[hookType]) {
      settings.hooks[hookType] = [];
    }

    // Check for existing guardrail
    const isDuplicate = settings.hooks[hookType].some(
      (entry: HookEntry) =>
        entry.type === 'command' && entry.command.includes(GUARDRAIL_MARKER),
    );

    if (isDuplicate) {
      info('Guardrail hook already installed for ' + hookType + ' — skipping.');
      continue;
    }

    // Insert guardrail BEFORE monitoring hooks (it needs to run first)
    settings.hooks[hookType].unshift({
      type: 'command',
      command,
    });

    addedCount++;
  }

  // Write updated settings
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');

  if (addedCount > 0) {
    success(`Added ${addedCount} sync guardrail hook(s).`);
  } else {
    info('All guardrail hooks were already installed.');
  }

  return addedCount;
}

/**
 * Step 6: Generate ralph-monitor.config.json with sensible defaults.
 * If the file already exists, ask before overwriting.
 */
async function stepGenerateConfig(
  rl: readline.Interface,
  monitorRoot: string,
): Promise<void> {
  header(6, 'Config File Generation');

  const configPath = path.join(monitorRoot, CONFIG_FILENAME);

  if (fs.existsSync(configPath)) {
    info(`Config file already exists: ${configPath}`);

    const overwrite = await confirm(rl, 'Overwrite with defaults?', false);
    if (!overwrite) {
      info('Keeping existing config file.');
      return;
    }
  }

  // Deep-clone the default config to avoid mutating the import
  const config: Config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  // Update dataDir to be relative to the monitor root
  config.general.dataDir = './data';

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  success(`Generated config: ${configPath}`);
}

/**
 * Step 7: Write a test event to the events directory to verify the pipeline.
 */
async function stepVerify(monitorRoot: string): Promise<void> {
  header(7, 'Verification');

  const dataDir = path.join(monitorRoot, 'data');
  const eventsDir = path.join(dataDir, 'events');

  // Ensure events directory exists
  try {
    fs.mkdirSync(eventsDir, { recursive: true });
    success('Events directory ready: ' + eventsDir);
  } catch (err) {
    warn(`Failed to create events directory: ${err instanceof Error ? err.message : err}`);
    return;
  }

  // Write a test event
  const testEvent = {
    id: randomUUID(),
    sessionId: 'wizard-verification-test',
    timestamp: new Date().toISOString(),
    type: 'Notification' as const,
    tool: null,
    payload: {
      message: 'Ralph Monitor setup wizard verification event',
      wizard_run: true,
    },
    project: 'ralph-monitor-setup',
    workspace: process.cwd(),
  };

  const date = new Date().toISOString().split('T')[0];
  const eventFilePath = path.join(eventsDir, `events-${date}.jsonl`);
  const line = JSON.stringify(testEvent) + '\n';

  try {
    fs.appendFileSync(eventFilePath, line, 'utf-8');
    success('Test event written to: ' + eventFilePath);
  } catch (err) {
    warn(`Failed to write test event: ${err instanceof Error ? err.message : err}`);
    warn('The dashboard may not receive events. Check directory permissions.');
    return;
  }

  // Verify the event was written
  try {
    const contents = fs.readFileSync(eventFilePath, 'utf-8');
    const lines = contents.trim().split('\n');
    const lastLine = JSON.parse(lines[lines.length - 1]);
    if (lastLine.id === testEvent.id) {
      success('Verification passed — event pipeline is working.');
    } else {
      warn('Verification could not confirm the test event.');
    }
  } catch {
    warn('Could not verify test event, but file was written.');
  }
}
