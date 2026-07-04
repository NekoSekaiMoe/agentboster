import { describe, expect, it } from 'vitest';
import {
  resolveAgentdNodeUrl,
  resolveAgentdNodeUrlWithReason,
  resolveDefaultAgentdBaseUrl,
} from './agentd-url';

describe('agentd URL resolution', () => {
  it('uses the first configured URL for direct health checks', () => {
    expect(
      resolveDefaultAgentdBaseUrl(
        [
          { id: 'a', url: ' http://agentd-a.example.test ' },
          { id: 'b', url: 'http://agentd-b.example.test' },
        ],
        'http://env.example.test',
      ),
    ).toBe('http://agentd-a.example.test');
  });

  it('falls back to AGENTD_URL when no configured URL exists', () => {
    expect(resolveDefaultAgentdBaseUrl([], ' http://env.example.test ')).toBe(
      'http://env.example.test',
    );
  });

  it('uses the URL whose configured id matches the registered node id', () => {
    expect(
      resolveAgentdNodeUrl({
        configuredNodes: [
          { id: 'node-a', url: 'http://agentd-a.example.test' },
          { id: 'node-b', url: 'http://agentd-b.example.test' },
        ],
        nodeId: 'node-b',
        envUrl: 'http://env.example.test',
        fallbackUrl: 'http://10.0.0.2:18732',
      }),
    ).toBe('http://agentd-b.example.test');
  });

  it('uses the only configured URL when a single-node config id is a UI UUID', () => {
    expect(
      resolveAgentdNodeUrl({
        configuredNodes: [
          {
            id: 'cfcbbe65-c66a-4cd3-8cdf-a749c7a3a2de',
            url: 'http://agentd-public.example.test',
          },
        ],
        nodeId: 'registered-node-id',
        envUrl: undefined,
        fallbackUrl: 'http://192.168.1.23:18732',
      }),
    ).toBe('http://agentd-public.example.test');
  });

  it('uses AGENTD_URL when multiple configured URLs cannot be matched', () => {
    expect(
      resolveAgentdNodeUrl({
        configuredNodes: [
          { id: 'node-a', url: 'http://agentd-a.example.test' },
          { id: 'node-b', url: 'http://agentd-b.example.test' },
        ],
        nodeId: 'node-c',
        envUrl: 'http://env.example.test',
        fallbackUrl: 'http://10.0.0.3:18732',
      }),
    ).toBe('http://env.example.test');
  });

  it('reports env fallback when multiple configured URLs cannot be matched', () => {
    expect(
      resolveAgentdNodeUrlWithReason({
        configuredNodes: [
          { id: 'node-a', url: 'http://agentd-a.example.test' },
          { id: 'node-b', url: 'http://agentd-b.example.test' },
        ],
        nodeId: 'node-c',
        envUrl: 'http://env.example.test',
        fallbackUrl: 'http://10.0.0.3:18732',
      }),
    ).toEqual({
      url: 'http://env.example.test',
      reason: 'env',
      usableConfiguredUrlCount: 2,
    });
  });

  it('falls back to the registered ip/port URL when no configured URL applies', () => {
    expect(
      resolveAgentdNodeUrl({
        configuredNodes: [],
        nodeId: 'node-a',
        envUrl: undefined,
        fallbackUrl: 'http://10.0.0.1:18732',
      }),
    ).toBe('http://10.0.0.1:18732');
  });

  it('ignores a whitespace-only single configured URL and uses AGENTD_URL', () => {
    expect(
      resolveAgentdNodeUrl({
        configuredNodes: [{ id: 'node-a', url: '   ' }],
        nodeId: 'node-a',
        envUrl: 'http://env.example.test',
        fallbackUrl: 'http://10.0.0.1:18732',
      }),
    ).toBe('http://env.example.test');
  });

  it('ignores whitespace-only AGENTD_URL and uses the registered fallback', () => {
    expect(
      resolveAgentdNodeUrl({
        configuredNodes: [],
        nodeId: 'node-a',
        envUrl: '  ',
        fallbackUrl: 'http://10.0.0.1:18732',
      }),
    ).toBe('http://10.0.0.1:18732');
  });

  it('uses the first non-empty configured URL for direct health checks', () => {
    expect(
      resolveDefaultAgentdBaseUrl(
        [
          { id: 'dirty', url: ' ' },
          { id: 'valid', url: 'http://agentd.example.test' },
        ],
        'http://env.example.test',
      ),
    ).toBe('http://agentd.example.test');
  });
});
