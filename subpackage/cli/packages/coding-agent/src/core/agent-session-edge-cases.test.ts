// biome-ignore-all lint/complexity/useLiteralKeys: Bracket access exercises private lifecycle boundaries in tests.
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InteractiveMode } from '../modes/interactive/interactive-mode.ts';
import { createExtensionRuntime } from './extensions/loader.ts';
import { AgentSession } from './agent-session.ts';
import { AgentSessionRuntime } from './agent-session-runtime.ts';
import type { AgentSessionServices } from './agent-session-services.ts';
import { collectBugReportDiagnostics } from './bug-report.ts';
import { MissingSessionCwdError } from './session-cwd.ts';
import { SessionManager } from './session-manager.ts';
import { SettingsManager } from './settings-manager.ts';

// Run before workspace dist/ exists, as in both CI test jobs.
vi.mock(
  '@agentboster-cli/agent',
  () => import(new URL('../../../agent/src/uuid.ts', import.meta.url).href),
);
vi.mock(
  '@agentboster-cli/ai/compat',
  () => import(new URL('../../../ai/src/compat.ts', import.meta.url).href),
);
vi.mock(
  '@agentboster-cli/ai',
  () => import(new URL('../../../ai/src/index.ts', import.meta.url).href),
);
vi.mock(
  '@agentboster-cli/ai/utils/event-stream',
  () =>
    import(
      new URL('../../../ai/src/utils/event-stream.ts', import.meta.url).href
    ),
);
vi.mock(
  '@agentboster/adapter',
  () =>
    import(
      new URL('../../../agentboster-adapter/src/index.ts', import.meta.url).href
    ),
);

function sessionFixture() {
  const manager = SessionManager.inMemory();
  const agent = {
    state: {
      isStreaming: false,
      messages: manager.buildSessionContext().messages,
    },
    prompt: vi.fn(async () => {}),
    steer: vi.fn(),
    followUp: vi.fn(),
  };
  const runner = {
    emit: vi.fn(async (_event: { type: string }) => {}),
    emitError: vi.fn(),
    hasHandlers: vi.fn(() => true),
    emitInput: vi.fn(async () => ({
      action: 'transform',
      text: 'transformed',
    })),
  };
  // Exercise the lifecycle methods with controlled agent/extension boundaries.
  const session: AgentSession = Object.assign(
    Object.create(AgentSession.prototype),
    {
      agent,
      sessionManager: manager,
      _extensionRunner: runner,
      _eventListeners: [],
      _deferredSettledActions: [],
      _pendingBashMessages: [],
      _steeringMessages: [],
      _followUpMessages: [],
      _resourceLoader: { getPrompts: () => ({ prompts: [] }) },
    },
  );
  return { session, manager, agent, runner };
}

const customMessage = {
  customType: 'test',
  content: 'continue',
  display: false,
};

describe('settled run ordering and context edits', () => {
  it('defers a custom trigger until all settled handlers finish, without deadlocking an awaiting handler', async () => {
    const { session, agent, runner } = sessionFixture();
    const order: string[] = [];
    runner.emit.mockImplementationOnce(async () => {
      order.push('handler 1');
      await session.sendCustomMessage(customMessage, { triggerTurn: true });
      order.push('handler 2');
    });
    agent.prompt.mockImplementation(async () => {
      order.push('prompt');
    });
    await session['_emitAgentSettled']();
    expect(order).toEqual(['handler 1', 'handler 2', 'prompt']);
    expect(agent.prompt).toHaveBeenCalledTimes(1);
    expect(runner.emitError).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'refreshes streaming edits before settled handlers (failed run: %s)',
    async (fail) => {
      const { session, manager, agent, runner } = sessionFixture();
      const target = manager.appendMessage({
        role: 'user',
        content: 'original',
        timestamp: 1,
      });
      session.refreshContext();
      const refresh = vi.spyOn(session, 'refreshContext');
      agent.prompt.mockImplementation(async () => {
        agent.state.isStreaming = true;
        session.appendContextEdit(target, 'first edit');
        session.appendContextEdit(target, 'replacement');
        expect(agent.state.messages[0]).toMatchObject({ content: 'original' });
        expect(refresh).not.toHaveBeenCalled();
        agent.state.isStreaming = false;
        if (fail) throw new Error('provider failure');
      });
      runner.emit.mockImplementation(async () => {
        expect(agent.state.messages[0]).toMatchObject({
          content: 'replacement',
        });
        expect(refresh).toHaveBeenCalledTimes(1);
      });
      const run = session.sendCustomMessage(customMessage, {
        triggerTurn: true,
      });
      if (fail) await expect(run).rejects.toThrow('provider failure');
      else await run;
      expect(runner.emit).toHaveBeenCalledWith({ type: 'agent_settled' });
      expect(session['_pendingContextRefresh']).toBe(false);
    },
  );

  it('refreshes idle edits immediately and leaves raw history intact', () => {
    const { session, manager, agent } = sessionFixture();
    const target = manager.appendMessage({
      role: 'user',
      content: 'original',
      timestamp: 1,
    });
    session.refreshContext();
    session.appendContextEdit(target, null);
    expect(agent.state.messages).toEqual([]);
    expect(manager.getEntry(target)).toMatchObject({
      message: { content: 'original' },
    });
  });
});

describe('queued input interception', () => {
  for (const method of ['steer', 'followUp'] as const) {
    it.each(['rpc', 'interactive'] as const)(
      `${method} intercepts %s input exactly once`,
      async (source) => {
        const { session, agent, runner } = sessionFixture();
        agent.state.isStreaming = true;
        if (source === 'rpc') await session[method]('input');
        else await session[method]('input', undefined, source);
        expect(runner.emitInput).toHaveBeenCalledExactlyOnceWith(
          'input',
          undefined,
          source,
          method,
        );
        expect(agent[method]).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            content: [{ type: 'text', text: 'transformed' }],
          }),
        );
      },
    );
  }
});

describe('session import retry', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const dir of directories.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  it.each(['unused', 'collision', 'in-place'])(
    'reuses the chosen target after a missing cwd (%s)',
    async (scenario) => {
      const collision = scenario === 'collision';
      const inPlace = scenario === 'in-place';
      const dir = mkdtempSync(join(tmpdir(), 'session-import-'));
      directories.push(dir);
      const sessionDir = join(dir, 'sessions');
      mkdirSync(sessionDir);
      const source = join(inPlace ? sessionDir : dir, 'imported.jsonl');
      const content = `${JSON.stringify({ type: 'session', version: 3, id: 'import-test', timestamp: new Date().toISOString(), cwd: join(dir, 'missing') })}\n`;
      writeFileSync(source, content);
      if (collision)
        writeFileSync(join(sessionDir, 'imported.jsonl'), 'existing session');
      const manager = SessionManager.open(source, sessionDir, dir);
      const runner = { hasHandlers: () => false };
      const oldSession = {
        sessionManager: manager,
        extensionRunner: runner,
        dispose: vi.fn(),
      } as unknown as AgentSession;
      const services = { cwd: dir, agentDir: dir } as AgentSessionServices;
      const createRuntime = vi.fn(
        async (options: { sessionManager: SessionManager }) => ({
          session: { sessionManager: options.sessionManager } as AgentSession,
          services,
          diagnostics: [],
          extensionsResult: {
            extensions: [],
            errors: [],
            runtime: createExtensionRuntime(),
          },
        }),
      );
      const runtime = new AgentSessionRuntime(
        oldSession,
        services,
        createRuntime,
      );
      await expect(runtime.importFromJsonl(source)).rejects.toBeInstanceOf(
        MissingSessionCwdError,
      );
      expect(readdirSync(sessionDir)).toEqual(
        collision || inPlace ? ['imported.jsonl'] : [],
      );
      expect(oldSession.dispose).not.toHaveBeenCalled();
      await expect(runtime.importFromJsonl(source, dir)).resolves.toEqual({
        cancelled: false,
      });
      const target = join(
        sessionDir,
        collision ? 'imported-import1.jsonl' : 'imported.jsonl',
      );
      expect(
        createRuntime.mock.calls[0][0].sessionManager.getSessionFile(),
      ).toBe(target);
      expect(readFileSync(source, 'utf8')).toBe(content);
      expect(readFileSync(target, 'utf8')).toBe(content);
      if (collision)
        expect(readFileSync(join(sessionDir, 'imported.jsonl'), 'utf8')).toBe(
          'existing session',
        );
    },
  );
});

describe('diagnostic crash privacy', () => {
  it.each([false, true])(
    'redacts crashes and includes session paths only on opt-in (%s)',
    (includeSession) => {
      const crash = {
        message: 'https://user:secret@example.com/?token=message-secret',
        stack: 'https://example.com/?api_key=stack-secret',
        cwd: '/private/project',
        sessionFile: '/private/session.jsonl',
        token: 'record-secret',
      };
      const result = collectBugReportDiagnostics(
        SessionManager.inMemory(),
        [crash],
        includeSession,
      );
      const [record] = result.crashes as Record<string, unknown>[];
      expect(JSON.stringify(record)).not.toMatch(
        /message-secret|stack-secret|record-secret|user:secret/,
      );
      expect(record.token).toBe('<redacted>');
      if (includeSession)
        expect(record).toMatchObject({
          cwd: crash.cwd,
          sessionFile: crash.sessionFile,
        });
      else {
        expect(record).not.toHaveProperty('cwd');
        expect(record).not.toHaveProperty('sessionFile');
      }
      expect(crash.token).toBe('record-secret');
    },
  );
});

describe('retry delay cap', () => {
  it.each([undefined, null, -1, NaN, Infinity, -Infinity, '500', false])(
    'defaults for invalid value %s',
    (value) => {
      const settings = SettingsManager.inMemory();
      // Include non-finite in-memory values, which JSON would otherwise convert to null.
      settings['settings'].retry = { maxAgentDelayMs: value as number };
      expect(settings.getRetrySettings().maxAgentDelayMs).toBe(60_000);
    },
  );
  it.each([0, 0.5, 500, 60_000])(
    'preserves finite nonnegative value %s',
    (value) => {
      expect(
        SettingsManager.inMemory({
          retry: { maxAgentDelayMs: value },
        }).getRetrySettings().maxAgentDelayMs,
      ).toBe(value);
    },
  );
});

describe('interactive compaction replay', () => {
  it.each([false, true])(
    'preserves interactive source when willRetry is %s',
    async (willRetry) => {
      const { session, agent, runner } = sessionFixture();
      const prompt = vi
        .spyOn(session, 'prompt')
        .mockImplementation(async () => {
          agent.state.isStreaming = true;
        });
      const ui: InteractiveMode = Object.assign(
        Object.create(InteractiveMode.prototype),
        {
          runtimeHost: { session },
          compactionQueuedMessages: [
            ...(!willRetry ? [{ text: 'first', mode: 'steer' }] : []),
            { text: 'steering', mode: 'steer' },
            { text: 'follow-up', mode: 'followUp' },
          ],
          updatePendingMessagesDisplay: vi.fn(),
          showError: vi.fn(),
        },
      );
      await ui['flushCompactionQueue']({ willRetry });
      expect(prompt).toHaveBeenCalledTimes(willRetry ? 0 : 1);
      expect(runner.emitInput).toHaveBeenCalledTimes(2);
      expect(runner.emitInput.mock.calls).toEqual([
        ['steering', undefined, 'interactive', willRetry ? undefined : 'steer'],
        [
          'follow-up',
          undefined,
          'interactive',
          willRetry ? undefined : 'followUp',
        ],
      ]);
      expect(agent.steer).toHaveBeenCalledTimes(1);
      expect(agent.followUp).toHaveBeenCalledTimes(1);
      expect(ui['showError']).not.toHaveBeenCalled();
    },
  );
});
