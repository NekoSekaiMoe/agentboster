import { describe, expect, it } from 'vitest';
import type { ToolExecutionOptions } from 'ai';
import heartbeatDecisionTool, {
  HEARTBEAT_DECISION_TOOL_NAME,
} from './decision';
import type { BuildInToolFactoryContext } from '../define';

function factoryContext(heartbeat?: boolean): BuildInToolFactoryContext {
  return {
    sessionId: 's1',
    runId: 'r1',
    agentName: 'main',
    allowDelegation: true,
    ...(heartbeat !== undefined ? { heartbeat } : {}),
  } as unknown as BuildInToolFactoryContext;
}

async function buildExecute(heartbeat?: boolean) {
  const tools = await heartbeatDecisionTool.factory(
    {},
    factoryContext(heartbeat),
  );
  if (!tools) throw new Error('factory returned no tools');
  const entry = tools[HEARTBEAT_DECISION_TOOL_NAME];
  if (!entry?.execute) throw new Error('heartbeat_decision has no execute');
  return entry.execute as (
    input: { reply: boolean; reason?: string },
    options: ToolExecutionOptions,
  ) => Promise<Record<string, unknown>>;
}

const execOpts = {
  toolCallId: 'call-1',
  messages: [],
} as ToolExecutionOptions;

describe('heartbeat_decision', () => {
  it('acknowledges the decision inside heartbeat runs', async () => {
    const execute = await buildExecute(true);
    await expect(
      execute({ reply: true, reason: 'user asked for a reminder' }, execOpts),
    ).resolves.toEqual({
      ok: true,
      reply: true,
      reason: 'user asked for a reminder',
    });
  });

  it('returns reply=false verbatim (silence is a valid outcome)', async () => {
    const execute = await buildExecute(true);
    const result = (await execute({ reply: false }, execOpts)) as {
      ok: boolean;
      reply: boolean;
      reason: unknown;
    };
    expect(result.ok).toBe(true);
    expect(result.reply).toBe(false);
    expect(result.reason).toBeNull();
  });

  it('fails closed outside heartbeat runs', async () => {
    const execute = await buildExecute(false);
    const result = (await execute({ reply: true }, execOpts)) as {
      ok: boolean;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('only available in heartbeat runs');
  });

  it('defaults to the closed guard when the flag is absent', async () => {
    const execute = await buildExecute(undefined);
    const result = (await execute({ reply: true }, execOpts)) as {
      ok: boolean;
    };
    expect(result.ok).toBe(false);
  });
});
