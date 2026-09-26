import * as os from 'node:os';
import type {
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from '@agentboster-cli/ai';
import type { AgentMessage, StreamFn } from '@agentboster-cli/agent';
import { uuidv7 } from '@agentboster-cli/agent';
import { getAgentDir, VERSION } from '../config.ts';
import { writeZipArchive } from '../utils/zip.ts';
import {
  completeSummarization,
  estimateTokens,
} from './compaction/compaction.ts';
import { serializeConversation } from './compaction/utils.ts';
import type { SessionManager } from './session-manager.ts';
import { convertToLlm } from './messages.ts';

export const BUG_REPORT_CUSTOM_ENTRY_TYPE = 'agentboster.bug-report';

const BUG_REPORT_SCHEMA_VERSION = 1;
const REDACTED = '<redacted>';
const SENSITIVE_KEY =
  /(?:^|[-_])(api[-_]?key|secret|token|password|passwd|credential|authorization|cookie)(?:$|[-_])/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key.replace(/([a-z0-9])([A-Z])/g, '$1_$2'));
}

/**
 * Strip URL credentials and redact query values whose keys look sensitive.
 * Unparseable URLs and URLs without sensitive fields are unchanged;
 * URL paths, fragments, and secrets embedded in prose are not redacted.
 */
export function redactUrl(value: string): string {
  const nested = /^([a-z][a-z0-9+.-]*:)([a-z][a-z0-9+.-]*:\/\/.*)$/i.exec(
    value,
  );
  if (nested) return `${nested[1]}${redactUrl(nested[2])}`;
  try {
    const url = new URL(value);
    let changed = false;
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      changed = true;
    }
    for (const key of url.searchParams.keys()) {
      if (isSensitiveKey(key)) {
        url.searchParams.set(key, REDACTED);
        changed = true;
      }
    }
    return changed ? url.toString() : value;
  } catch {
    return value;
  }
}

/**
 * Copy a JSON value, redacting non-null values under sensitive keys and
 * sensitive URL fields in strings. Other string content and undefined are
 * preserved. JSON serialization and parsing errors propagate to the caller.
 */
export function redactJsonValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(
    JSON.stringify(value, (_key, child: unknown) => {
      if (child !== null && child !== undefined && isSensitiveKey(_key)) {
        return REDACTED;
      }
      return typeof child === 'string' ? redactUrl(child) : child;
    }),
  );
}

function collectEnvironment() {
  const env = (name: string) => process.env[name] || null;
  return {
    version: VERSION,
    runtime: process.versions.bun
      ? `bun/${process.versions.bun}`
      : `node/${process.version}`,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    osVersion: os.version(),
    shell: process.env.SHELL?.split(/[\\/]/).pop() || null,
    terminal: {
      term: env('TERM'),
      program: env('TERM_PROGRAM'),
      programVersion: env('TERM_PROGRAM_VERSION'),
      colorterm: env('COLORTERM'),
      tmux: Boolean(process.env.TMUX),
      ssh: Boolean(
        process.env.SSH_CONNECTION ||
          process.env.SSH_CLIENT ||
          process.env.SSH_TTY,
      ),
      ci: Boolean(process.env.CI),
    },
    // Names help diagnose configuration; values never leave the machine.
    environmentVariables: Object.keys(process.env)
      .filter(
        (name) => name.startsWith('AGENTBOSTER_') || name.startsWith('PI_'),
      )
      .sort(),
  };
}

function describeModel(model: Model<any> | undefined) {
  if (!model) return null;
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl ? redactUrl(model.baseUrl) : null,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

export interface BugReportMetadataOptions {
  id?: string;
  hint?: string;
  model: Model<any> | undefined;
  sessionId: string;
  cwd: string;
  extensions: ReadonlyArray<{
    path: string;
    sourceInfo: { source: string; scope?: string; origin?: string };
    hidden?: boolean;
  }>;
  extensionErrors: ReadonlyArray<{ path: string; error: string }>;
  globalSettings: unknown;
  projectSettings: unknown;
  includeSession: boolean;
  includeSummary: boolean;
  messageCount: number;
  thinkingLevel: string | undefined;
}

/**
 * Collect environment, model, extension, and redacted settings metadata.
 * Includes cwd only when includeSession is true; hint and extension errors
 * are retained as text. Settings serialization errors propagate.
 */
export function collectBugReportMetadata(
  options: BugReportMetadataOptions,
): Record<string, unknown> {
  return {
    schemaVersion: BUG_REPORT_SCHEMA_VERSION,
    id: options.id ?? uuidv7(),
    createdAt: new Date().toISOString(),
    hint: options.hint?.trim() || null,
    environment: collectEnvironment(),
    session: {
      id: options.sessionId,
      included: options.includeSession,
      summaryIncluded: options.includeSummary,
      messageCount: options.messageCount,
      ...(options.includeSession ? { cwd: options.cwd } : {}),
    },
    model: describeModel(options.model),
    thinkingLevel: options.thinkingLevel,
    extensions: options.extensions.map((extension) => ({
      path: extension.path,
      source: redactUrl(extension.sourceInfo.source),
      scope: extension.sourceInfo.scope,
      origin: extension.sourceInfo.origin,
      hidden: extension.hidden === true,
    })),
    extensionErrors: options.extensionErrors.map(({ path, error }) => ({
      path,
      error,
    })),
    settings: {
      global: redactJsonValue(options.globalSettings),
      project: redactJsonValue(options.projectSettings),
    },
  };
}

/**
 * Collect assistant diagnostics, errors, and aborted turns across all session
 * branches, excluding message content. Crash records use JSON/URL redaction;
 * cwd and sessionFile are included only with session data. Assistant error text
 * is retained, along with counts of all entries and assistant turns.
 */
export function collectBugReportDiagnostics(
  sessionManager: SessionManager,
  crashes: ReadonlyArray<object> = [],
  includeSession = false,
): Record<string, unknown> {
  const entries = sessionManager.getEntries();
  const assistant: Array<Record<string, unknown>> = [];
  let assistantMessageCount = 0;
  for (const entry of entries) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant')
      continue;
    assistantMessageCount++;
    const message = entry.message;
    const diagnostics = (message as AssistantMessage).diagnostics ?? [];
    if (
      diagnostics.length === 0 &&
      message.stopReason !== 'error' &&
      message.stopReason !== 'aborted' &&
      !message.errorMessage
    ) {
      continue;
    }
    assistant.push({
      entryId: entry.id,
      timestamp: entry.timestamp,
      provider: message.provider,
      model: message.model,
      api: message.api,
      stopReason: message.stopReason,
      ...(message.errorMessage === undefined
        ? {}
        : { errorMessage: message.errorMessage }),
      diagnostics,
    });
  }
  return {
    schemaVersion: BUG_REPORT_SCHEMA_VERSION,
    sessionId: sessionManager.getSessionId(),
    entryCount: entries.length,
    assistantMessageCount,
    assistant,
    crashes: crashes.map((record) => {
      const crash = { ...(record as Record<string, unknown>) };
      if (!includeSession) {
        delete crash.cwd;
        delete crash.sessionFile;
      }
      return redactJsonValue(crash);
    }),
  };
}

export interface BugReportBundle {
  metadata: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
  sessionJsonl?: string;
  summary?: string;
}

/**
 * Serialize report and diagnostics JSON with optional transcript and summary
 * files. Performs no redaction; JSON serialization errors propagate.
 */
export function bugReportFiles(bundle: BugReportBundle): Array<{
  name: string;
  data: string;
}> {
  const files = [
    {
      name: 'report.json',
      data: `${JSON.stringify(bundle.metadata, null, 2)}\n`,
    },
    {
      name: 'diagnostics.json',
      data: `${JSON.stringify(bundle.diagnostics, null, 2)}\n`,
    },
  ];
  if (bundle.sessionJsonl !== undefined) {
    files.push({ name: 'session.jsonl', data: bundle.sessionJsonl });
  }
  if (bundle.summary !== undefined) {
    files.push({
      name: 'summary.md',
      data: bundle.summary.endsWith('\n')
        ? bundle.summary
        : `${bundle.summary}\n`,
    });
  }
  return files;
}

/**
 * Write the supplied report bundle to a ZIP file, overwriting an existing file.
 * The parent directory must exist. Serialization and ZIP errors throw
 * synchronously; filesystem write failures reject the returned promise.
 */
export function writeBugReportArchive(
  bundle: BugReportBundle,
  filePath: string,
): Promise<void> {
  return writeZipArchive(filePath, bugReportFiles(bundle));
}

export function bugReportArchiveFileName(id: string): string {
  return `agentboster-bug-report-${id}.zip`;
}

/** Default export directory for bug report archives. */
export function bugReportExportDir(): string {
  return getAgentDir();
}

const BUG_SUMMARY_SYSTEM_PROMPT = `You are helping a user file a bug report about agentboster-cli, the coding agent they are talking to. You will be shown the conversation transcript. Write a report for the developers describing what the user was doing and what went wrong.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the report.`;

const BUG_SUMMARY_INSTRUCTIONS = `Write the bug report in Markdown with these sections:

## What the user was doing
One short paragraph.

## What went wrong
Concrete description of the failure: wrong output, errors, hangs, tool failures, unexpected behavior. Quote error messages and tool output verbatim where they exist.

## Steps to reproduce
Numbered list, as specific as the transcript allows.

## Relevant details
Tool calls involved, files touched, model behavior, anything else that helps a developer reproduce or locate the problem.

Do not include file contents, secrets, or credentials from the transcript; refer to files by path only. Keep the report factual and concise.`;

/**
 * Select a contiguous suffix within an estimated token budget, in original
 * order. Always keeps the newest message, even when it alone exceeds the budget.
 */
function selectMessages(
  messages: AgentMessage[],
  tokenBudget: number,
): AgentMessage[] {
  const selected: AgentMessage[] = [];
  let tokens = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const next = estimateTokens(message as never);
    if (selected.length > 0 && tokens + next > tokenBudget) break;
    selected.push(message);
    tokens += next;
  }
  return selected.reverse();
}

/**
 * Send recent conversation text and an optional hint to the session model and
 * return a trimmed report. The selected transcript is sent without redaction;
 * the prompt asks the model to omit secrets from its report.
 * @throws If the response is aborted, reports an error, calls a tool, or has no
 * text. Request failures also propagate, including a missing streamFn because
 * the default completion provider is unavailable in this fork.
 */
export async function generateBugReportSummary(options: {
  model: Model<any>;
  messages: AgentMessage[];
  hint?: string;
  signal?: AbortSignal;
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  streamFn?: StreamFn;
}): Promise<string> {
  const { model } = options;
  const contextWindow = model.contextWindow > 0 ? model.contextWindow : 128_000;
  const messages = selectMessages(
    options.messages,
    Math.floor(contextWindow * 0.6),
  );
  const hint = options.hint?.trim();
  const prompt = [
    messages.length < options.messages.length
      ? `Note: only the last ${messages.length} of ${options.messages.length} messages are shown.`
      : undefined,
    `<conversation>\n${serializeConversation(convertToLlm(messages))}\n</conversation>`,
    hint ? `<user-report>\n${hint}\n</user-report>` : undefined,
    BUG_SUMMARY_INSTRUCTIONS,
  ]
    .filter((part) => part !== undefined)
    .join('\n\n');
  const requestOptions: SimpleStreamOptions = {
    maxTokens: Math.min(
      4096,
      model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
    ),
    signal: options.signal,
    apiKey: options.apiKey,
    headers: options.headers,
    env: options.env,
  };
  const context: Context = {
    systemPrompt: BUG_SUMMARY_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: prompt }],
        timestamp: Date.now(),
      },
    ],
  };
  const response = await completeSummarization(
    model,
    context,
    requestOptions,
    options.streamFn,
  );
  if (response.stopReason === 'aborted') {
    throw new Error('Bug report summary was cancelled');
  }
  if (response.stopReason === 'error') {
    throw new Error(
      `Bug report summary failed: ${response.errorMessage || 'Unknown error'}`,
    );
  }
  if (response.content.some((block) => block.type === 'toolCall')) {
    throw new Error('Bug report summary attempted to call a tool');
  }
  const text = response.content
    .filter(
      (block): block is { type: 'text'; text: string } => block.type === 'text',
    )
    .map((block) => block.text)
    .join('')
    .trim();
  if (!text) throw new Error('Bug report summary was empty');
  return text;
}
