import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ───
vi.mock('@/lib/core/kv', () => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock('@/lib/core/kv/skills', () => ({
  archiveSkill: vi.fn(),
  listSkillDetails: vi.fn(),
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
import { get, set } from '@/lib/core/kv';
import { archiveSkill, listSkillDetails } from '@/lib/core/kv/skills';
import type { AppConfig } from '@/types/config';

import { maybeCurateSkills } from './curator';

const CONFIG = { models: { model: 'm' } } as AppConfig;
const USER = { modelPreferences: { model: 'm' } };

function makeDraft(
  name: string,
  overrides: Partial<{
    description: string;
    updatedAt: number;
    origin: 'self_authored' | 'clawhub_suggestion';
    rationale: string;
  }> = {},
) {
  const ageHours = overrides.updatedAt
    ? Math.round((Date.now() - overrides.updatedAt) / (60 * 60 * 1000))
    : 0;
  return {
    name,
    description: overrides.description ?? '',
    sourceType: 'manual' as const,
    gitURL: '',
    repoId: '',
    updatedAt: overrides.updatedAt ?? Date.now(),
    frontmatter: {},
    files: [],
    status: 'draft' as const,
    draft: {
      origin: overrides.origin ?? 'self_authored',
      rationale: overrides.rationale ?? '',
      sourceSessionId: 's',
      createdAt: 0,
    },
    // exposed for the test's own assertions on summarize ordering
    _ageHours: ageHours,
  };
}

describe('maybeCurateSkills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: never run (recent timestamp).
    vi.mocked(get).mockResolvedValue(JSON.stringify(Date.now()));
    vi.mocked(set).mockResolvedValue('OK');
    vi.mocked(listSkillDetails).mockResolvedValue([]);
    vi.mocked(archiveSkill).mockResolvedValue({} as never);
    vi.mocked(generateObject).mockResolvedValue({
      object: { decisions: [] },
    } as never);
  });

  it('does nothing when the interval has not elapsed', async () => {
    const result = await maybeCurateSkills({
      config: {
        ...CONFIG,
        experiments: { skillDistillation: { curatorIntervalHours: 6 } },
      } as AppConfig,
      user: USER,
    });

    expect(result.ran).toBe(false);
    expect(result.reason).toBe('interval_not_elapsed');
    expect(listSkillDetails).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(generateObject).not.toHaveBeenCalled();
  });

  it('is a no-op when curatorIntervalHours is 0 (disabled)', async () => {
    const result = await maybeCurateSkills({
      config: {
        ...CONFIG,
        experiments: { skillDistillation: { curatorIntervalHours: 0 } },
      } as AppConfig,
      user: USER,
    });

    expect(result.ran).toBe(false);
    expect(result.reason).toBe('disabled');
    expect(get).not.toHaveBeenCalled();
    expect(listSkillDetails).not.toHaveBeenCalled();
    expect(generateObject).not.toHaveBeenCalled();
  });

  it('stamps the run time and returns early when there are no drafts', async () => {
    vi.mocked(get).mockResolvedValue(null); // never run
    vi.mocked(listSkillDetails).mockResolvedValue([]);

    const result = await maybeCurateSkills({ config: CONFIG, user: USER });

    expect(result).toEqual({
      ran: true,
      reason: 'no_drafts',
      reviewed: 0,
      archived: 0,
      kept: 0,
    });
    // Stamps so the next call is gated.
    expect(set).toHaveBeenCalledWith(
      'skills:curator:last_run',
      expect.any(String),
    );
    expect(generateObject).not.toHaveBeenCalled();
  });

  it('archives drafts the reviewer flags as archive, keeps the rest', async () => {
    vi.mocked(get).mockResolvedValue(null);
    const drafts = [
      makeDraft('keep-me', { description: 'A solid workflow.' }),
      makeDraft('junk-one', { description: '', rationale: 'vague' }),
    ];
    vi.mocked(listSkillDetails).mockResolvedValue(drafts as never);
    vi.mocked(generateObject).mockResolvedValue({
      object: {
        decisions: [
          { name: 'keep-me', verdict: 'keep', reason: 'plausible' },
          { name: 'junk-one', verdict: 'archive', reason: 'low signal' },
        ],
      },
    } as never);

    const result = await maybeCurateSkills({ config: CONFIG, user: USER });

    expect(result.ran).toBe(true);
    expect(result.reviewed).toBe(2);
    expect(result.archived).toBe(1);
    expect(result.kept).toBe(1);
    expect(archiveSkill).toHaveBeenCalledWith('junk-one');
    expect(archiveSkill).toHaveBeenCalledTimes(1);
  });

  it('keeps drafts when the reviewer is silent on them (defensive)', async () => {
    vi.mocked(get).mockResolvedValue(null);
    vi.mocked(listSkillDetails).mockResolvedValue([
      makeDraft('d1'),
      makeDraft('d2'),
    ] as never);
    // Model returns decisions for only one draft (hallucinated / truncated).
    vi.mocked(generateObject).mockResolvedValue({
      object: {
        decisions: [{ name: 'd1', verdict: 'archive', reason: 'x' }],
      },
    } as never);

    const result = await maybeCurateSkills({ config: CONFIG, user: USER });

    expect(result.archived).toBe(1);
    // d2 had no decision → counted as kept, never archived.
    expect(result.kept).toBe(1);
    expect(archiveSkill).toHaveBeenCalledTimes(1);
  });

  it('never archives a draft the reviewer said keep on', async () => {
    vi.mocked(get).mockResolvedValue(null);
    vi.mocked(listSkillDetails).mockResolvedValue([makeDraft('d1')] as never);
    vi.mocked(generateObject).mockResolvedValue({
      object: {
        decisions: [{ name: 'd1', verdict: 'keep', reason: 'borderline' }],
      },
    } as never);

    const result = await maybeCurateSkills({ config: CONFIG, user: USER });

    expect(result.archived).toBe(0);
    expect(result.kept).toBe(1);
    expect(archiveSkill).not.toHaveBeenCalled();
  });

  it('skips when no model is configured', async () => {
    vi.mocked(get).mockResolvedValue(null);
    vi.mocked(listSkillDetails).mockResolvedValue([makeDraft('d')] as never);

    const result = await maybeCurateSkills({
      config: { models: {} } as AppConfig,
      user: null,
    });

    expect(result.ran).toBe(false);
    expect(result.reason).toBe('no_model');
    expect(generateObject).not.toHaveBeenCalled();
  });

  it('swallows LLM failures and reports nothing was archived', async () => {
    vi.mocked(get).mockResolvedValue(null);
    vi.mocked(listSkillDetails).mockResolvedValue([makeDraft('d')] as never);
    vi.mocked(generateObject).mockRejectedValue(new Error('upstream 500'));

    const result = await maybeCurateSkills({ config: CONFIG, user: USER });

    expect(result.ran).toBe(false);
    expect(result.reason).toBe('review_llm_failed');
    expect(archiveSkill).not.toHaveBeenCalled();
  });
});
