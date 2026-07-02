import { describe, expect, it } from 'vitest';
import { mapLocalToolToAgentd } from './map';

describe('mapLocalToolToAgentd (/switch forwarding contract)', () => {
  it('maps local_exec → exec, renaming cwd to working_dir', () => {
    const r = mapLocalToolToAgentd('local_exec', {
      command: 'ls -la',
      cwd: '/tmp',
    });
    expect(r).toEqual({
      name: 'exec',
      input: { command: 'ls -la', working_dir: '/tmp' },
    });
  });

  it('drops cwd when absent (agentd defaults working_dir to ".")', () => {
    const r = mapLocalToolToAgentd('local_exec', { command: 'pwd' });
    expect(r).toEqual({ name: 'exec', input: { command: 'pwd' } });
  });

  it('maps local_read_file → read with identical path field', () => {
    const r = mapLocalToolToAgentd('local_read_file', { path: '/etc/hosts' });
    expect(r).toEqual({ name: 'read', input: { path: '/etc/hosts' } });
  });

  it('maps local_write_file → write with path + content', () => {
    const r = mapLocalToolToAgentd('local_write_file', {
      path: '/tmp/x',
      content: 'hello',
    });
    expect(r).toEqual({
      name: 'write',
      input: { path: '/tmp/x', content: 'hello' },
    });
  });

  it('maps local_grep → grep, dropping unsupported fields', () => {
    // CLI's local_grep has glob/ignoreCase/literal/context/limit; agentd's
    // grep only accepts pattern + path. The extra fields must be dropped
    // so agentd's strict unmarshal doesn't choke (it ignores extras, but
    // being explicit keeps the contract documented).
    const r = mapLocalToolToAgentd('local_grep', {
      pattern: 'TODO',
      path: 'src',
      glob: '*.ts',
      ignoreCase: true,
      literal: false,
      context: 2,
      limit: 50,
    });
    expect(r).toEqual({
      name: 'grep',
      input: { pattern: 'TODO', path: 'src' },
    });
  });

  it('returns null for local_ask_question (TTY-only, must not be forwarded)', () => {
    expect(mapLocalToolToAgentd('local_ask_question', {})).toBeNull();
  });

  it('returns null for unknown tool names', () => {
    expect(mapLocalToolToAgentd('local_nope', {})).toBeNull();
    expect(mapLocalToolToAgentd('exec', {})).toBeNull();
  });

  it('handles local_grep without path (agentd defaults to ".")', () => {
    const r = mapLocalToolToAgentd('local_grep', { pattern: 'foo' });
    expect(r).toEqual({ name: 'grep', input: { pattern: 'foo' } });
  });
});
