import { describe, expect, it } from 'vitest';

import { parseFrontmatter } from './frontmatter.ts';

describe('parseFrontmatter BOM handling (pi #8337)', () => {
  it('parses frontmatter from a BOM-prefixed file', () => {
    const content =
      '\ufeff---\nname: my-skill\ndescription: hi\n---\nbody text';
    const { frontmatter, body } = parseFrontmatter<{
      name: string;
      description: string;
    }>(content);
    expect(frontmatter.name).toBe('my-skill');
    expect(frontmatter.description).toBe('hi');
    expect(body).toBe('body text');
  });

  it('parses frontmatter without BOM unchanged', () => {
    const { frontmatter } = parseFrontmatter<{ name: string }>(
      '---\nname: x\n---\nbody',
    );
    expect(frontmatter.name).toBe('x');
  });

  it('treats a BOM-prefixed body without frontmatter as plain content', () => {
    const { frontmatter, body } = parseFrontmatter('\ufeffjust some text');
    expect(frontmatter).toEqual({});
    expect(body).toBe('just some text');
  });
});
