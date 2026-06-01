import type {
  BuiltinMcpServerContext,
  BuiltinMcpToolDefinition,
  BuiltinMcpToolResult,
} from './types';

const WEB_SEARCH_URL = 'https://html.duckduckgo.com/html/';

function buildError(message: string): BuiltinMcpToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

async function searchWeb(query: string): Promise<string> {
  const response = await fetch(WEB_SEARCH_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'Mozilla/5.0',
    },
    body: new URLSearchParams({ q: query, ia: 'web' }).toString(),
  });

  if (!response.ok) {
    throw new Error(`Web search failed with status ${response.status}`);
  }

  return await response.text();
}

async function fetchUrl(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!response.ok) {
    throw new Error(`Fetch failed with status ${response.status}`);
  }

  return await response.text();
}

export const builtinWebTools: BuiltinMcpToolDefinition[] = [
  {
    name: 'web_search',
    title: 'Web Search',
    description: 'Search the public web for current information.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        max_results: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_url',
    title: 'Fetch URL',
    description: 'Fetch and return the HTML content of a URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
      },
      required: ['url'],
    },
  },
];

export async function executeBuiltinWebTool(
  toolName: string,
  input: Record<string, unknown>,
  _context?: BuiltinMcpServerContext,
): Promise<BuiltinMcpToolResult> {
  try {
    if (toolName === 'web_search') {
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (!query) {
        return buildError('Missing required field: query');
      }

      const html = await searchWeb(query);
      return {
        content: [{ type: 'text', text: html.slice(0, 20_000) }],
      };
    }

    if (toolName === 'fetch_url') {
      const url = typeof input.url === 'string' ? input.url.trim() : '';
      if (!url) {
        return buildError('Missing required field: url');
      }

      const html = await fetchUrl(url);
      return {
        content: [{ type: 'text', text: html.slice(0, 20_000) }],
      };
    }

    return buildError(`Unknown builtin web tool: ${toolName}`);
  } catch (error) {
    return buildError(
      error instanceof Error ? error.message : 'Web tool execution failed',
    );
  }
}
