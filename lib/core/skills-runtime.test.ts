import { describe, expect, it } from 'vitest';

import {
  buildSkillExecCommand,
  getSkillEntrypointPath,
  getSkillRuntime,
  SKILL_RUNTIMES,
  skillRuntimeSchema,
  type SkillDetail,
} from '@/types/skills';

function detail(
  frontmatter: Partial<SkillDetail['frontmatter']>,
  files: Array<{ path: string }> = [{ path: 'SKILL.md' }],
): Pick<SkillDetail, 'files' | 'frontmatter'> {
  return { frontmatter, files };
}

describe('skillRuntimeSchema', () => {
  it('accepts the supported runtimes', () => {
    expect(SKILL_RUNTIMES).toEqual(['python', 'bash']);
    for (const r of SKILL_RUNTIMES) {
      expect(skillRuntimeSchema.parse(r)).toBe(r);
    }
  });

  it('rejects unsupported runtimes', () => {
    expect(skillRuntimeSchema.safeParse('node').success).toBe(false);
    expect(skillRuntimeSchema.safeParse('').success).toBe(false);
    expect(skillRuntimeSchema.safeParse('PYTHON').success).toBe(false);
  });
});

describe('getSkillRuntime', () => {
  it('returns the declared runtime', () => {
    expect(getSkillRuntime(detail({ runtime: 'python' }))).toBe('python');
    expect(getSkillRuntime(detail({ runtime: 'bash' }))).toBe('bash');
  });

  it('is case- and whitespace-insensitive on the declared value', () => {
    expect(getSkillRuntime(detail({ runtime: '  Python ' }))).toBe('python');
    expect(getSkillRuntime(detail({ runtime: 'BASH' }))).toBe('bash');
  });

  it('returns null when runtime is absent (read-only fallback)', () => {
    expect(getSkillRuntime(detail({}))).toBeNull();
    expect(getSkillRuntime(detail({ entrypoint: 'foo.py' }))).toBeNull();
  });

  it('returns null on unsupported runtime values (typo degrades to read-only, no throw)', () => {
    expect(getSkillRuntime(detail({ runtime: 'node' }))).toBeNull();
    expect(getSkillRuntime(detail({ runtime: 'python3' }))).toBeNull();
    expect(getSkillRuntime(detail({ runtime: 42 }))).toBeNull();
    expect(getSkillRuntime(detail({ runtime: null }))).toBeNull();
  });
});

describe('buildSkillExecCommand', () => {
  it('prefixes python3 for the python runtime', () => {
    expect(buildSkillExecCommand('python', 'main.py')).toBe(
      `python3 'main.py'`,
    );
  });

  it('prefixes bash for the bash runtime', () => {
    expect(buildSkillExecCommand('bash', 'run.sh')).toBe(`bash 'run.sh'`);
  });

  it('shell-quotes single quotes inside the entrypoint path', () => {
    // POSIX single-quote escape: close quote, escaped quote, reopen.
    const cmd = buildSkillExecCommand('python', "it's a file.py");
    expect(cmd).toBe(`python3 'it'\\''s a file.py'`);
  });

  it('works for nested entrypoint paths', () => {
    expect(buildSkillExecCommand('python', 'src/main.py')).toBe(
      `python3 'src/main.py'`,
    );
  });
});

describe('getSkillEntrypointPath (regression)', () => {
  it('still prefers frontmatter entrypoint', () => {
    expect(getSkillEntrypointPath(detail({ entrypoint: 'foo.py' }, []))).toBe(
      'foo.py',
    );
  });

  it('falls back to SKILL.md when present', () => {
    expect(getSkillEntrypointPath(detail({}))).toBe('SKILL.md');
  });

  it('returns null for empty file lists without SKILL.md', () => {
    expect(getSkillEntrypointPath(detail({}, []))).toBeNull();
  });
});
