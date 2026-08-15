import { APP_NAME } from '../config.ts';
import type { SourceInfo } from './source-info.ts';

export type SlashCommandSource = 'extension' | 'prompt' | 'skill';

export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: SlashCommandSource;
  sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
  name: string;
  description: string;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
  { name: 'settings', description: 'Open settings menu' },
  { name: 'model', description: 'Select model (opens selector UI)' },
  {
    name: 'scoped-models',
    description: 'Enable/disable models for Ctrl+P cycling',
  },
  {
    name: 'export',
    description: 'Export session (HTML default, or specify path: .html/.jsonl)',
  },
  {
    name: 'import',
    description: 'Import and resume a session from a JSONL file',
  },
  { name: 'copy', description: 'Copy last agent message to clipboard' },
  { name: 'name', description: 'Set session display name' },
  { name: 'session', description: 'Show session info and stats' },
  { name: 'hotkeys', description: 'Show all keyboard shortcuts' },
  {
    name: 'fork',
    description: 'Create a new fork from a previous user message',
  },
  {
    name: 'clone',
    description: 'Duplicate the current session at the current position',
  },
  { name: 'tree', description: 'Navigate session tree (switch branches)' },
  {
    name: 'trust',
    description: 'Save project trust decision for future sessions',
  },
  { name: 'login', description: 'Configure provider authentication' },
  { name: 'logout', description: 'Remove provider authentication' },
  { name: 'new', description: 'Start a new session' },
  { name: 'compact', description: 'Manually compact the session context' },
  {
    name: 'init',
    description: 'Generate an AGENTS.md contributor guide for this repository',
  },
  {
    name: 'context',
    description: 'Show context window usage and per-category composition',
  },
  {
    name: 'plan',
    description:
      'Toggle plan mode (read-only: investigate, propose plan, then re-enable actions on approval)',
  },
  {
    name: 'effort',
    description:
      'Set thinking/effort level (off/minimal/low/medium/high/xhigh)',
  },
  { name: 'resume', description: 'Resume a different session' },
  {
    name: 'switch',
    description:
      'Switch local_* tool execution between this machine and a remote Agent Daemon node',
  },
  {
    name: 'orchestration',
    description:
      'Author and submit a multi-agent orchestration plan (Team Mode II)',
  },
  {
    name: 'reload',
    description: 'Reload keybindings, extensions, skills, prompts, and themes',
  },
  { name: 'exit', description: `Exit ${APP_NAME}` },
  { name: 'quit', description: `Alias of /exit` },
];
