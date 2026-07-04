interface ConfiguredAgentdNode {
  id?: string;
  node_id?: string;
  url?: string;
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

export function resolveAgentdNodeUrl({
  configuredNodes,
  nodeId,
  envUrl,
  fallbackUrl,
}: {
  configuredNodes: readonly ConfiguredAgentdNode[] | undefined;
  nodeId: string;
  envUrl: string | undefined;
  fallbackUrl: string;
}): string {
  const exact = (configuredNodes ?? []).find(
    (node) => node.id === nodeId || node.node_id === nodeId,
  );
  const exactUrl = cleanUrl(exact?.url);
  if (exactUrl) {
    return exactUrl;
  }

  const urls = configuredUrls(configuredNodes);
  if (urls.length === 1) {
    return urls[0];
  }

  return cleanUrl(envUrl) ?? fallbackUrl;
}
