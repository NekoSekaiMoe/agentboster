import { describe, expect, it } from 'vitest';

import {
  type SkillDetail,
  type SkillStatus,
  skillStatusSchema,
} from '@/types/skills';
import { toSkillMeta } from '@/types/skills';

// ─── Schema: backward-compat default ───

describe('skillStatusSchema', () => {
  it('accepts the three lifecycle values', () => {
    expect(skillStatusSchema.parse('draft')).toBe('draft');
    expect(skillStatusSchema.parse('active')).toBe('active');
    expect(skillStatusSchema.parse('archived')).toBe('archived');
  });

  it('rejects unknown statuses', () => {
    expect(() => skillStatusSchema.parse('published')).toThrow();
  });
});

// ─── Detail → Meta projection carries status ───

describe('toSkillMeta', () => {
  function makeDetail(status: SkillStatus | undefined): SkillDetail {
    return {
      name: 'x',
      description: 'd',
      sourceType: 'manual',
      gitURL: '',
      repoId: '',
      updatedAt: 0,
      frontmatter: {},
      files: [],
      // Intentionally omit `status` when undefined to test the default path —
      // rows written before this field existed deserialize without it.
      ...(status === undefined ? {} : { status }),
    } as SkillDetail;
  }

  it('preserves an explicit status', () => {
    expect(toSkillMeta(makeDetail('draft')).status).toBe('draft');
    expect(toSkillMeta(makeDetail('archived')).status).toBe('archived');
  });

  it('defaults to active when the field is missing (backward compat)', () => {
    // A skill detail written before status existed will not carry the field
    // after JSON round-trip. The projection must still yield 'active' so the
    // skill stays visible in the prompt index (its prior behavior).
    expect(toSkillMeta(makeDetail(undefined)).status).toBe('active');
  });
});
