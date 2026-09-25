#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import './enable-compile-cache.ts';
import { APP_NAME } from './config.ts';
import { recordCrash } from './core/crash-log.ts';
import { configureHttpDispatcher } from './core/http-dispatcher.ts';
import { main } from './main.ts';

process.title = APP_NAME;
process.env.PI_CODING_AGENT = 'true';
process.emitWarning = (() => {}) as typeof process.emitWarning;

// Persist crashes (pi 0.86.0) so the next start can announce them and /bug
// can attach them to a report. Best-effort only.
process.on('uncaughtException', (error) => {
  recordCrash({ kind: 'uncaught', error, cwd: process.cwd() });
  // Re-throw to preserve default fatal behavior.
  throw error;
});
process.on('unhandledRejection', (reason) => {
  recordCrash({
    kind: 'unhandledRejection',
    error: reason instanceof Error ? reason : new Error(String(reason)),
    cwd: process.cwd(),
  });
});

// Configure undici's global dispatcher before provider SDKs issue requests.
// Runtime settings are applied once SettingsManager has loaded global/project settings.
configureHttpDispatcher();

main(process.argv.slice(2));
