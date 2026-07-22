import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ───
// The distill module reaches into the DB, the blob store, the KV skill
// store, and the AI SDK. Each is mocked so the test exercises ONLY the
// distillation decision logic — not the LLM call or the storage layer.

vi.mock('@/lib/core/db/chat', () => ({
  getVisibleSessionMessages: vi.fn(),
}));

vi.mock('@/lib/core/blob/skills', () => ({
  downloadAndSyncSkillFromClawHub: vi.fn(),
  searchClawHubSkills: vi.fn(),
}));

vi.mock('@/lib/core/kv/skills', () => ({
  checkSkillNameExists: vi.fn(),
  persistManualSkill: vi.fn(),
  upsertSkillDetail: vi.fn(),
}));

vi.mock('@/lib/memory/extract', () => ({
  // distill reuses this to render the conversation transcript.
  buildConversationContext: vi.fn(),
}));

vi.mock('./curator', () => ({
  // distill piggybacks a curator sweep before its review. The sweep's own
  // behavior is exercised in curator.test.ts; here we only need it to be
  // a no-op so it doesn't trigger extra LLM / KV calls in the distill tests.
  maybeCurateSkills: vi.fn().mockResolvedValue({
    ran: false,
    reason: 'interval_not_elapsed',
    reviewed: 0,
    archived: 0,
    kept: 0,
  }),
}));

vi.mock('@/lib/ai', () => ({
  resolveLanguageModel: vi.fn(() => ({})),
}));

vi.mock('ai', () => ({
  generateObject: vi.fn(),
}));

vi.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { generateObject } from 'ai';
import { getVisibleSessionMessages } from '@/lib/core/db/chat';
import {
  downloadAndSyncSkillFromClawHub,
  searchClawHubSkills,
} from '@/lib/core/blob/skills';
import {
  checkSkillNameExists,
  persistManualSkill,
  upsertSkillDetail,
} from '@/lib/core/kv/skills';
import { buildConversationContext } from '@/lib/memory/extract';
import type { AppConfig } from '@/types/config';

import { maybeDistillSkillFromSession } from './distill';

const SESSION_ID = 'sess-1';
const USER_ID = 'user-1';

function makeConfig(
  overrides: Partial<
    NonNullable<AppConfig['experiments']>['skillDistillation']
  > = {},
): AppConfig {
  return {
    experiments: {
      skillDistillation: {
        enabled: true,
        toolCallThreshold: 8,
        preferClawHub: true,
        clawhubMinScore: 1.5,
        ...overrides,
      },
    },
    models: { model: 'test-model' },
  } as AppConfig;
}

/** Build a fake message list with N tool calls (the density signal). */
function fakeMessages(toolCalls: number) {
  const msgs: Array<{ role: string }> = [
    { role: 'user' },
    { role: 'assistant' },
  ];
  for (let i = 0; i < toolCalls; i++) msgs.push({ role: 'tool' });
  return msgs;
}

describe('maybeDistillSkillFromSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getVisibleSessionMessages).mockResolvedValue([]);
    vi.mocked(buildConversationContext).mockReturnValue('');
    vi.mocked(searchClawHubSkills).mockResolvedValue([]);
    vi.mocked(downloadAndSyncSkillFromClawHub).mockResolvedValue({
      name: 'slug',
      description: '',
      sourceType: 'clawhub',
      gitURL: '',
      repoId: '',
      updatedAt: 0,
      frontmatter: {},
      files: [],
      status: 'active',
    });
    vi.mocked(checkSkillNameExists).mockResolvedValue(false);
    vi.mocked(persistManualSkill).mockImplementation(async (input) => ({
      name: input.name,
      description: input.description,
      sourceType: 'manual',
      gitURL: '',
      repoId: '',
      updatedAt: 0,
      frontmatter: {},
      files: [],
      status: input.status ?? 'active',
    }));
    vi.mocked(upsertSkillDetail).mockImplementation(
      async (input) =>
        ({
          ...input,
          status: input.status ?? 'active',
        }) as never,
    );
  });

  it('skips immediately when the feature is disabled', async () => {
    const result = await maybeDistillSkillFromSession({
      sessionId: SESSION_ID,
      userId: USER_ID,
      config: makeConfig({ enabled: false }),
    });

    expect(result).toEqual({
      distilled: false,
      origin: 'skipped',
      reason: 'disabled',
    });
    // No DB / LLM / search calls should fire.
    expect(getVisibleSessionMessages).not.toHaveBeenCalled();
    expect(generateObject).not.toHaveBeenCalled();
    expect(searchClawHubSkills).not.toHaveBeenCalled();
  });

  it('skips when tool-call density is below the threshold', async () => {
    vi.mocked(getVisibleSessionMessages).mockResolvedValue(
      fakeMessages(3) as never,
    );

    const result = await maybeDistillSkillFromSession({
      sessionId: SESSION_ID,
      userId: USER_ID,
      config: makeConfig({ toolCallThreshold: 8 }),
    });

    expect(result).toEqual({
      distilled: false,
      origin: 'skipped',
      reason: 'tool_call_count_3_below_threshold',
    });
    expect(generateObject).not.toHaveBeenCalled();
  });

  it('skips when the reviewer LLM declines (shouldDistill=false)', async () => {
    vi.mocked(getVisibleSessionMessages).mockResolvedValue(
      fakeMessages(10) as never,
    );
    vi.mocked(buildConversationContext).mockReturnValue('a real conversation');
    vi.mocked(generateObject).mockResolvedValue({
      object: {
        shouldDistill: false,
        skillName: '',
        description: '',
        clawhubQuery: '',
        rationale: '',
      },
    } as never);

    const result = await maybeDistillSkillFromSession({
      sessionId: SESSION_ID,
      userId: USER_ID,
      config: makeConfig(),
    });

    expect(result.reason).toBe('review_declined');
    expect(searchClawHubSkills).not.toHaveBeenCalled();
    expect(persistManualSkill).not.toHaveBeenCalled();
  });

  it('stages a ClawHub suggestion when search returns a high-scoring hit', async () => {
    vi.mocked(getVisibleSessionMessages).mockResolvedValue(
      fakeMessages(10) as never,
    );
    vi.mocked(buildConversationContext).mockReturnValue('a real conversation');
    vi.mocked(generateObject).mockResolvedValue({
      object: {
        shouldDistill: true,
        skillName: 'Deploy Vercel Preview',
        description: 'Deploy a preview branch to Vercel.',
        clawhubQuery: 'vercel preview deploy',
        rationale: 'Repeated deploy workflow.',
      },
    } as never);
    vi.mocked(searchClawHubSkills).mockResolvedValue([
      {
        slug: 'vercel-deploy',
        displayName: 'Vercel Deploy',
        summary: 'Deploy to Vercel',
        score: 3.2,
      },
    ]);

    const result = await maybeDistillSkillFromSession({
      sessionId: SESSION_ID,
      userId: USER_ID,
      config: makeConfig({ clawhubMinScore: 1.5 }),
    });

    expect(result).toEqual({
      distilled: true,
      origin: 'clawhub_suggestion',
      skillName: 'deploy-vercel-preview',
      clawhubSlug: 'vercel-deploy',
    });
    expect(searchClawHubSkills).toHaveBeenCalledWith({
      query: 'vercel preview deploy',
      limit: 3,
    });
    // The staged detail must carry status: 'draft' + clawhub provenance.
    const staged = vi.mocked(upsertSkillDetail).mock.calls[0][0];
    expect(staged.status).toBe('draft');
    expect(staged.draft?.origin).toBe('clawhub_suggestion');
    expect(staged.draft?.clawhubSlug).toBe('vercel-deploy');
    // Self-authoring path must NOT have run.
    expect(persistManualSkill).not.toHaveBeenCalled();
  });

  it('self-authors when ClawHub search has no good hit', async () => {
    vi.mocked(getVisibleSessionMessages).mockResolvedValue(
      fakeMessages(10) as never,
    );
    vi.mocked(buildConversationContext).mockReturnValue('a real conversation');
    // First generateObject = review (distill=yes). Second = body authoring.
    vi.mocked(generateObject)
      .mockResolvedValueOnce({
        object: {
          shouldDistill: true,
          skillName: 'Custom Workflow',
          description: 'A bespoke workflow.',
          clawhubQuery: 'custom workflow xyz',
          rationale: 'Worth saving.',
        },
      } as never)
      .mockResolvedValueOnce({
        object: {
          whenToUse: ['trigger one'],
          procedure: ['step one'],
          pitfalls: [],
        },
      } as never);
    vi.mocked(searchClawHubSkills).mockResolvedValue([]); // no hits

    const result = await maybeDistillSkillFromSession({
      sessionId: SESSION_ID,
      userId: USER_ID,
      config: makeConfig(),
    });

    expect(result.origin).toBe('self_authored');
    expect(result.skillName).toBe('custom-workflow');
    expect(persistManualSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'custom-workflow',
        status: 'draft',
        draft: expect.objectContaining({
          origin: 'self_authored',
        }),
      }),
    );
    // Two LLM calls: review + body.
    expect(generateObject).toHaveBeenCalledTimes(2);
  });

  it('does NOT fire when the user-disabled ClawHub preference holds and search would have matched', async () => {
    vi.mocked(getVisibleSessionMessages).mockResolvedValue(
      fakeMessages(10) as never,
    );
    vi.mocked(buildConversationContext).mockReturnValue('a real conversation');
    vi.mocked(generateObject).mockResolvedValue({
      object: {
        shouldDistill: true,
        skillName: 'x',
        description: 'd',
        clawhubQuery: 'q',
        rationale: 'r',
      },
    } as never);

    await maybeDistillSkillFromSession({
      sessionId: SESSION_ID,
      userId: USER_ID,
      config: makeConfig({ preferClawHub: false }),
    });

    expect(searchClawHubSkills).not.toHaveBeenCalled();
  });

  it('resolves name collisions by appending -N suffixes', async () => {
    vi.mocked(getVisibleSessionMessages).mockResolvedValue(
      fakeMessages(10) as never,
    );
    vi.mocked(buildConversationContext).mockReturnValue('a real conversation');
    vi.mocked(generateObject)
      .mockResolvedValueOnce({
        object: {
          shouldDistill: true,
          skillName: 'taken-name',
          description: 'd',
          clawhubQuery: 'q',
          rationale: 'r',
        },
      } as never)
      .mockResolvedValueOnce({
        object: { whenToUse: [], procedure: [], pitfalls: [] },
      } as never);
    // First name exists, second probe (taken-name-2) is free.
    vi.mocked(checkSkillNameExists)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    vi.mocked(searchClawHubSkills).mockResolvedValue([]);

    const result = await maybeDistillSkillFromSession({
      sessionId: SESSION_ID,
      userId: USER_ID,
      config: makeConfig({ preferClawHub: false }),
    });

    expect(result.skillName).toBe('taken-name-2');
    expect(persistManualSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'taken-name-2' }),
    );
  });
});
