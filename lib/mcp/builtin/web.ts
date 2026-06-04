import type {
  BuiltinMcpServerContext,
  BuiltinMcpToolDefinition,
  BuiltinMcpToolResult,
} from './types';

const BING_SEARCH_URL = 'https://www.bing.com/search';

function buildError(message: string): BuiltinMcpToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseBingResults(html: string, maxResults: number): string {
  const results: string[] = [];
  const algoRegex = /<li class="b_algo">(.*?)<\/li>/gs;
  let match: RegExpExecArray | null;

  while (
    (match = algoRegex.exec(html)) !== null &&
    results.length < maxResults
  ) {
    const block = match[1];

    const titleMatch = /<h2><a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a><\/h2>/s.exec(
      block,
    );
    const url = titleMatch?.[1] ?? '';
    const title = titleMatch ? stripHtml(titleMatch[2]) : '';

    const snippetMatch =
      /<p[^>]*>(.*?)<\/p>/s.exec(block) ??
      /<div class="b_caption"[^>]*>.*?<p>(.*?)<\/p>/s.exec(block);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : '';

    if (title || snippet) {
      results.push(
        [
          `${results.length + 1}. ${title}`,
          url ? `   URL: ${url}` : '',
          snippet ? `   ${snippet}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
  }

  if (results.length === 0) {
    const text = stripHtml(html);
    return text.slice(0, 5_000) || 'No search results found.';
  }

  return results.join('\n\n');
}

async function searchWeb(query: string, maxResults: number): Promise<string> {
  const searchUrl = `${BING_SEARCH_URL}?${new URLSearchParams({ q: query, count: String(maxResults) }).toString()}`;

  const response = await fetch(searchUrl, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Web search failed with status ${response.status}`);
  }

  return await response.text();
}

async function fetchUrl(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(15_000),
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

      const maxResults =
        typeof input.max_results === 'number' && input.max_results > 0
          ? Math.min(input.max_results, 10)
          : 5;

      const html = await searchWeb(query, maxResults);
      const text = parseBingResults(html, maxResults);
      return {
        content: [{ type: 'text', text }],
      };
    }

    if (toolName === 'fetch_url') {
      const url = typeof input.url === 'string' ? input.url.trim() : '';
      if (!url) {
        return buildError('Missing required field: url');
      }

      const html = await fetchUrl(url);
      const text = stripHtml(html).slice(0, 20_000);
      return {
        content: [{ type: 'text', text }],
      };
    }

    return buildError(`Unknown builtin web tool: ${toolName}`);
  } catch (error) {
    return buildError(
      error instanceof Error ? error.message : 'Web tool execution failed',
    );
  }
}
