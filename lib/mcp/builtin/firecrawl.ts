import type {
  BuiltinMcpServerContext,
  BuiltinMcpToolDefinition,
  BuiltinMcpToolResult,
} from './types';

const FIRECRAWL_API_URL = 'https://api.firecrawl.dev/v1/scrape';

function buildError(message: string): BuiltinMcpToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

export const builtinFirecrawlTools: BuiltinMcpToolDefinition[] = [
  {
    name: 'firecrawl_scrape',
    title: 'Firecrawl Scrape',
    description:
      'Scrape a web page with Firecrawl. Requires FIRECRAWL_API_KEY.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        formats: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['url'],
    },
  },
];

export async function executeBuiltinFirecrawlTool(
  toolName: string,
  input: Record<string, unknown>,
  _context?: BuiltinMcpServerContext,
): Promise<BuiltinMcpToolResult> {
  if (toolName !== 'firecrawl_scrape') {
    return buildError(`Unknown builtin Firecrawl tool: ${toolName}`);
  }

  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    return buildError('FIRECRAWL_API_KEY is not configured.');
  }

  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (!url) {
    return buildError('Missing required field: url');
  }

  const formats = Array.isArray(input.formats)
    ? input.formats.filter((value): value is string => typeof value === 'string')
    : ['markdown'];

  try {
    const response = await fetch(FIRECRAWL_API_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ url, formats }),
    });

    const text = await response.text();
    if (!response.ok) {
      return buildError(`Firecrawl failed with status ${response.status}: ${text}`);
    }

    return {
      content: [{ type: 'text', text: text.slice(0, 30_000) }],
    };
  } catch (error) {
    return buildError(
      error instanceof Error ? error.message : 'Firecrawl execution failed',
    );
  }
}
