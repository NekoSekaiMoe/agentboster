import type {
  BuiltinMcpServerContext,
  BuiltinMcpToolDefinition,
  BuiltinMcpToolResult,
} from './types';

const GITHUB_API_URL = 'https://api.github.com';

function buildError(message: string): BuiltinMcpToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function githubHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'AgentBoster-MCP',
  };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

async function requestGithub(
  path: string,
  init: RequestInit = {},
): Promise<BuiltinMcpToolResult> {
  const response = await fetch(`${GITHUB_API_URL}${path}`, {
    ...init,
    headers: {
      ...githubHeaders(),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });

  const text = await response.text();
  if (!response.ok) {
    return buildError(
      `GitHub request failed with status ${response.status}: ${text}`,
    );
  }

  return {
    content: [{ type: 'text', text: text.slice(0, 30_000) }],
  };
}

export const builtinGithubTools: BuiltinMcpToolDefinition[] = [
  {
    name: 'github_get_repository',
    title: 'Get GitHub Repository',
    description: 'Get repository metadata from GitHub.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'github_search_issues',
    title: 'Search GitHub Issues and PRs',
    description: 'Search GitHub issues and pull requests.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'github_create_issue',
    title: 'Create GitHub Issue',
    description:
      'Create an issue. Requires GITHUB_TOKEN with repo permissions.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'github_update_issue',
    title: 'Update GitHub Issue',
    description:
      'Update an issue. Requires GITHUB_TOKEN with repo permissions.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        issue_number: { type: 'number' },
        title: { type: 'string' },
        body: { type: 'string' },
        state: { type: 'string' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'github_create_pull_request',
    title: 'Create GitHub Pull Request',
    description:
      'Create a pull request. Requires GITHUB_TOKEN with repo permissions.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
];

export async function executeBuiltinGithubTool(
  toolName: string,
  input: Record<string, unknown>,
  _context?: BuiltinMcpServerContext,
): Promise<BuiltinMcpToolResult> {
  const owner = typeof input.owner === 'string' ? input.owner.trim() : '';
  const repo = typeof input.repo === 'string' ? input.repo.trim() : '';

  if (toolName === 'github_get_repository') {
    if (!owner || !repo) return buildError('Missing owner or repo.');
    return requestGithub(`/repos/${owner}/${repo}`);
  }

  if (toolName === 'github_search_issues') {
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (!query) return buildError('Missing query.');
    return requestGithub(`/search/issues?q=${encodeURIComponent(query)}`);
  }

  if (toolName === 'github_create_issue') {
    if (!owner || !repo) return buildError('Missing owner or repo.');
    const title = typeof input.title === 'string' ? input.title : '';
    if (!title) return buildError('Missing title.');
    return requestGithub(`/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      body: JSON.stringify({
        title,
        body: typeof input.body === 'string' ? input.body : undefined,
      }),
    });
  }

  if (toolName === 'github_update_issue') {
    if (!owner || !repo) return buildError('Missing owner or repo.');
    const issueNumber =
      typeof input.issue_number === 'number' ? input.issue_number : null;
    if (!issueNumber) return buildError('Missing issue_number.');
    return requestGithub(`/repos/${owner}/${repo}/issues/${issueNumber}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: typeof input.title === 'string' ? input.title : undefined,
        body: typeof input.body === 'string' ? input.body : undefined,
        state: typeof input.state === 'string' ? input.state : undefined,
      }),
    });
  }

  if (toolName === 'github_create_pull_request') {
    if (!owner || !repo) return buildError('Missing owner or repo.');
    const title = typeof input.title === 'string' ? input.title : '';
    const head = typeof input.head === 'string' ? input.head : '';
    const base = typeof input.base === 'string' ? input.base : '';
    if (!title || !head || !base)
      return buildError('Missing title, head, or base.');
    return requestGithub(`/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({
        title,
        head,
        base,
        body: typeof input.body === 'string' ? input.body : undefined,
      }),
    });
  }

  return buildError(`Unknown builtin GitHub tool: ${toolName}`);
}
