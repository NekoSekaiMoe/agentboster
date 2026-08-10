/**
 * Tests for workspace resolution during first-message session creation in
 * chatMain → ensureMessageSession.
 *
 * Regression focus: new sessions used to always land in the user's DEFAULT
 * workspace (resolveDefaultWorkspace), swallowing lookup failures to a NULL
 * (legacy global) scope. After the fix, the caller-requested active
 * workspace is validated server-side (ownership + active status) and any
 * resolution/validation failure aborts session creation with an error —
 * authenticated users never silently fall back to the global scope.
 *
 * All DB / workflow / KV boundaries are mocked; the tests assert on the
 * workspaceId passed to createSession and on error propagation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  resolveWorkspaceAccess: vi.fn(),
  getOrCreateDefaultWorkspace: vi.fn(),
  startWorkflow: vi.fn(),
}));

vi.mock('@/lib/bot/reply', () => ({
  sendAdapterSourceReply: vi.fn(),
}));

vi.mock('@/lib/core/db/chat', () => ({
  createSession: mocks.createSession,
  deleteMessagesAfterUiMessageId: vi.fn(async () => []),
  getFirstVisibleSessionMessage: vi.fn(async () => null),
  getMessageByUiMessageId: vi.fn(async () => null),
  getSession: vi.fn(async () => null),
  getSessionByExternalThreadId: vi.fn(async () => null),
  listSessions: vi.fn(async () => []),
  listSessionsByExternalThreadIds: vi.fn(async () => []),
  updateSession: vi.fn(async () => null),
  upsertUserMessage: vi.fn(async () => undefined),
}));

vi.mock('@/lib/core/db/agentd', () => ({
  resolveWorkspaceAccess: mocks.resolveWorkspaceAccess,
  getOrCreateDefaultWorkspace: mocks.getOrCreateDefaultWorkspace,
}));

vi.mock('@/lib/core/db/im-accounts', () => ({
  resolveClawLessUserId: vi.fn(async () => null),
}));

vi.mock('@/lib/core/db/users', () => ({
  getUserById: vi.fn(async () => null),
}));

vi.mock('@/lib/core/kv/config', () => ({
  getConfig: vi.fn(async () => ({})),
}));

vi.mock('@/lib/core/sandbox/session-runtime', () => ({
  getSessionRuntime: vi.fn(),
}));

vi.mock('@/lib/memory', () => ({
  invalidateCurrentSessionSummary: vi.fn(async () => undefined),
}));

vi.mock('@/lib/memory/remote-injection', () => ({
  collectRemoteMemoryItems: vi.fn(async () => []),
  withTimeout: vi.fn(async (promise: Promise<unknown>) => promise),
}));

vi.mock('@/lib/workflow/agent/context', () => ({
  buildInitialContextMessages: vi.fn(async () => []),
}));

vi.mock('@/lib/workflow/agent/dispatch', () => ({
  canResumeRun: vi.fn(async () => false),
  pauseWorkflow: vi.fn(async () => undefined),
  requestCompact: vi.fn(async () => undefined),
  resumeToolApproval: vi.fn(async () => undefined),
  resumeWithMessage: vi.fn(async () => undefined),
  startWorkflow: mocks.startWorkflow,
}));

vi.mock('@/lib/chat/attachment-processing', () => ({
  normalizeUserMessageParts: vi.fn(
    async (input: { parts?: unknown[]; text?: string }) => ({
      text: input.text ?? '',
      parts: input.parts ?? [],
      attachments: [],
    }),
  ),
}));

vi.mock('@/lib/chat/dedup', () => ({
  checkDuplicate: vi.fn(async () => null),
  checkIdempotencyDuplicate: vi.fn(async () => null),
  recordIdempotencyMessage: vi.fn(async () => undefined),
  recordMessage: vi.fn(async () => undefined),
}));

vi.mock('@/lib/chat/session-cleanup', () => ({
  cleanupChatSession: vi.fn(async () => undefined),
}));

// Command modules are irrelevant for the message path but imported at the
// top of lib/chat/index.ts; stub them to keep their heavy deps out of tests.
vi.mock('@/lib/chat/commands/cancel', () => ({
  executeCancelCommand: vi.fn(),
}));
vi.mock('@/lib/chat/commands/config', () => ({
  executeConfigCommand: vi.fn(),
}));
vi.mock('@/lib/chat/commands/id', () => ({ executeIdCommand: vi.fn() }));
vi.mock('@/lib/chat/commands/lang', () => ({ executeLangCommand: vi.fn() }));
vi.mock('@/lib/chat/commands/memory', () => ({
  executeMemoryCommand: vi.fn(),
}));
vi.mock('@/lib/chat/commands/model', () => ({ executeModelCommand: vi.fn() }));
vi.mock('@/lib/chat/commands/pair', () => ({
  executePairCommand: vi.fn(),
  executeUnpairCommand: vi.fn(),
}));
vi.mock('@/lib/chat/commands/provider', () => ({
  executeProviderCommand: vi.fn(),
}));
vi.mock('@/lib/chat/commands/reset', () => ({ executeResetCommand: vi.fn() }));
vi.mock('@/lib/chat/commands/retry', () => ({ executeRetryCommand: vi.fn() }));
vi.mock('@/lib/chat/commands/start', () => ({ executeStartCommand: vi.fn() }));
vi.mock('@/lib/chat/commands/version', () => ({
  executeVersionCommand: vi.fn(),
}));
vi.mock('@/lib/chat/commands/whoami', () => ({
  executeWhoamiCommand: vi.fn(),
}));
vi.mock('@/lib/chat/commands/remote', () => ({
  executeAttachCommand: vi.fn(),
  executeDetachCommand: vi.fn(),
  executeRemoteCommand: vi.fn(),
}));

import { chatMain } from '@/lib/chat';

const USER_ID = 'user-1';

function workspaceRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ws-1',
    ownerId: USER_ID,
    name: 'workspace',
    preferredNodeId: null,
    nodeGeneration: 0,
    isDefault: false,
    visibility: 'private',
    sharedMemoryEnabled: false,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Access-granted result for an actor with full control of the workspace
 *  (its owner, or an admin permitted to manage it): canAccess + canManage. */
function accessGranted(ws: ReturnType<typeof workspaceRecord>) {
  return { ws, canAccess: true, canManage: true };
}

async function submitFirstMessage(workspaceId?: string) {
  return chatMain(
    {
      trigger: 'submit-message',
      input: {
        text: 'hello',
        parts: [{ type: 'text', text: 'hello' }],
      },
      ...(workspaceId ? { workspaceId } : {}),
    },
    { source: { type: 'web', userId: USER_ID } },
  );
}

beforeEach(() => {
  vi.clearAllMocks();

  mocks.createSession.mockImplementation(
    async (input: {
      id?: string;
      channel: string;
      userId?: string | null;
      workspaceId?: string | null;
      metadata?: Record<string, unknown>;
    }) => ({
      id: input.id ?? 'sess-created-1',
      channel: input.channel,
      externalThreadId: null,
      userId: input.userId ?? null,
      workspaceId: input.workspaceId ?? null,
      metadata: input.metadata ?? {},
      title: null,
      model: null,
      workflowRunId: null,
    }),
  );
  mocks.startWorkflow.mockResolvedValue({ runId: 'run-1' });
});

describe('ensureMessageSession workspace resolution', () => {
  it('creates the first-message session in the requested non-default workspace', async () => {
    mocks.resolveWorkspaceAccess.mockResolvedValue(
      accessGranted(workspaceRecord({ id: 'ws-nondefault' })),
    );

    const result = await submitFirstMessage('ws-nondefault');

    expect(result.kind).toBe('message');
    expect(mocks.resolveWorkspaceAccess).toHaveBeenCalledWith(
      'ws-nondefault',
      expect.objectContaining({ userId: USER_ID }),
    );
    expect(mocks.getOrCreateDefaultWorkspace).not.toHaveBeenCalled();
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-nondefault' }),
    );
  });

  it('creates the session in another user’s PUBLIC workspace (shared access)', async () => {
    mocks.resolveWorkspaceAccess.mockResolvedValue({
      ws: workspaceRecord({
        id: 'ws-shared',
        ownerId: 'user-2',
        visibility: 'public',
      }),
      canAccess: true,
      canManage: false,
    });

    const result = await submitFirstMessage('ws-shared');

    expect(result.kind).toBe('message');
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-shared' }),
    );
  });

  it('falls back to the default workspace when none is requested', async () => {
    mocks.getOrCreateDefaultWorkspace.mockResolvedValue(
      workspaceRecord({ id: 'ws-default', isDefault: true }),
    );

    const result = await submitFirstMessage();

    expect(result.kind).toBe('message');
    expect(mocks.resolveWorkspaceAccess).not.toHaveBeenCalled();
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-default' }),
    );
  });

  it('rejects and creates no session when the requested workspace is missing', async () => {
    mocks.resolveWorkspaceAccess.mockResolvedValue(null);

    await expect(submitFirstMessage('ws-gone')).rejects.toThrow(
      /workspace not found/i,
    );
    // Typed error carries the machine-readable code the web route maps
    // to a 4xx (see app/(chat)/api/ai/route.ts).
    await expect(submitFirstMessage('ws-gone')).rejects.toMatchObject({
      name: 'SessionWorkspaceError',
      code: 'not_found',
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.startWorkflow).not.toHaveBeenCalled();
  });

  it('rejects and creates no session when the requested workspace belongs to another user', async () => {
    mocks.resolveWorkspaceAccess.mockResolvedValue({
      ws: workspaceRecord({ id: 'ws-other', ownerId: 'user-2' }),
      canAccess: false,
      canManage: false,
    });

    await expect(submitFirstMessage('ws-other')).rejects.toThrow(
      /workspace not found/i,
    );
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.startWorkflow).not.toHaveBeenCalled();
  });

  it('rejects and creates no session when the requested workspace is archived', async () => {
    mocks.resolveWorkspaceAccess.mockResolvedValue(
      accessGranted(workspaceRecord({ id: 'ws-archived', status: 'archived' })),
    );

    await expect(submitFirstMessage('ws-archived')).rejects.toThrow(
      /not active/i,
    );
    await expect(submitFirstMessage('ws-archived')).rejects.toMatchObject({
      name: 'SessionWorkspaceError',
      code: 'not_active',
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.startWorkflow).not.toHaveBeenCalled();
  });

  it('rejects and creates no session when default-workspace resolution fails', async () => {
    mocks.getOrCreateDefaultWorkspace.mockRejectedValue(
      new Error('db unavailable'),
    );

    await expect(submitFirstMessage()).rejects.toThrow(/db unavailable/);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.startWorkflow).not.toHaveBeenCalled();
  });
});
