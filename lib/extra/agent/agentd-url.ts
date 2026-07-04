interface ConfiguredAgentdNode {
  id: string;
  url: string;
  name?: string;
}

function cleanUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function configuredUrls(
  nodes: readonly ConfiguredAgentdNode[] | undefined,
): string[] {
  return (nodes ?? [])
    .map((node) => cleanUrl(node.url))
    .filter((url): url is string => Boolean(url));
}

export function resolveDefaultAgentdBaseUrl(
  nodes: readonly ConfiguredAgentdNode[] | undefined,
  envUrl: string | undefined,
): string | undefined {
  return configuredUrls(nodes)[0] ?? cleanUrl(envUrl);
}

export type AgentdNodeUrlResolutionReason =
  | 'exact-configured'
  | 'single-configured'
  | 'env'
  | 'registered-fallback';

export interface AgentdNodeUrlResolution {
  url: string;
  reason: AgentdNodeUrlResolutionReason;
  usableConfiguredUrlCount: number;
}

export function resolveAgentdNodeUrlWithReason({
  configuredNodes,
  nodeId,
  envUrl,
  fallbackUrl,
}: {
  configuredNodes: readonly ConfiguredAgentdNode[] | undefined;
  nodeId: string;
  envUrl: string | undefined;
  fallbackUrl: string;
}): AgentdNodeUrlResolution {
  const exact = (configuredNodes ?? []).find((node) => node.id === nodeId);
  const exactUrl = cleanUrl(exact?.url);
  const urls = configuredUrls(configuredNodes);

  if (exactUrl) {
    return {
      url: exactUrl,
      reason: 'exact-configured',
      usableConfiguredUrlCount: urls.length,
    };
  }

  if (urls.length === 1) {
    return {
      url: urls[0],
      reason: 'single-configured',
      usableConfiguredUrlCount: urls.length,
    };
  }

  const cleanedEnvUrl = cleanUrl(envUrl);
  if (cleanedEnvUrl) {
    return {
      url: cleanedEnvUrl,
      reason: 'env',
      usableConfiguredUrlCount: urls.length,
    };
  }

  return {
    url: fallbackUrl,
    reason: 'registered-fallback',
    usableConfiguredUrlCount: urls.length,
  };
}

export function resolveAgentdNodeUrl(
  input: Parameters<typeof resolveAgentdNodeUrlWithReason>[0],
): string {
  return resolveAgentdNodeUrlWithReason(input).url;
}
