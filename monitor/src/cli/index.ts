#!/usr/bin/env node
/**
 * Ralph Monitor CLI entry point.
 *
 * Commands:
 *   npx ralph-monitor init    — Run the interactive setup wizard
 *   npx ralph-monitor start   — Start the dashboard server
 *   npx ralph-monitor --help  — Show usage info
 *
 * Uses process.argv parsing only (no external CLI framework).
 */

import path from 'node:path';

const USAGE = `
Ralph Monitor — Real-time monitoring dashboard for Claude Code sessions

Usage:
  ralph-monitor init          Run the setup wizard (inject hooks, generate config)
  ralph-monitor start         Start the dashboard server
  ralph-monitor --help, -h    Show this help message
  ralph-monitor --version     Show version

Examples:
  npx ralph-monitor init      # First-time setup
  npx ralph-monitor start     # Launch the dashboard
`.trim();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0]?.toLowerCase();

  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  if (command === '--version') {
    try {
      const pkgPath = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..', '..', 'package.json');
      const { default: pkg } = await import(pkgPath, { assert: { type: 'json' } });
      console.log(`ralph-monitor v${pkg.version ?? '0.1.0'}`);
    } catch {
      console.log('ralph-monitor v0.1.0');
    }
    process.exit(0);
  }

  if (command === 'init') {
    const { runSetupWizard } = await import('./init.js');
    await runSetupWizard();
    return;
  }

  if (command === 'start') {
    await startServer();
    return;
  }

  console.error(`Unknown command: "${command}"\n`);
  console.log(USAGE);
  process.exit(1);
}

async function startServer(): Promise<void> {
  try {
    const serverPath = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..', 'server', 'index.js',
    );
    await import(serverPath);
  } catch (err) {
    console.error('Failed to start the dashboard server.');
    console.error(
      'Make sure you have built the project first: npm run build',
    );
    if (err instanceof Error) {
      console.error(`\nDetails: ${err.message}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
