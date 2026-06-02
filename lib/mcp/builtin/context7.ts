import context7 from '@/context7.json';
import type {
  BuiltinMcpServerContext,
  BuiltinMcpToolDefinition,
  BuiltinMcpToolResult,
} from './types';

function buildError(message: string): BuiltinMcpToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

export const builtinContext7Tools: BuiltinMcpToolDefinition[] = [
  {
    name: 'context7_search_docs',
    title: 'Context7 Search Docs',
    description: 'Search Context7 documentation for the current project.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
  },
];

export async function executeBuiltinContext7Tool(
  toolName: string,
  input: Record<string, unknown>,
  _context?: BuiltinMcpServerContext,
): Promise<BuiltinMcpToolResult> {
  if (toolName !== 'context7_search_docs') {
    return buildError(`Unknown builtin Context7 tool: ${toolName}`);
  }

  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (!query) {
    return buildError('Missing required field: query');
  }

  try {
    const response = await fetch(
      `${context7.url}?query=${encodeURIComponent(query)}`,
      {
        headers: {
          authorization: `Bearer ${context7.public_key}`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
      },
    );

    const text = await response.text();
    if (!response.ok) {
      return buildError(`Context7 request failed with status ${response.status}: ${text}`);
    }

    return {
      content: [{ type: 'text', text: text.slice(0, 30_000) }],
    };
  } catch (error) {
    return buildError(
      error instanceof Error ? error.message : 'Context7 execution failed',
    );
  }
}
