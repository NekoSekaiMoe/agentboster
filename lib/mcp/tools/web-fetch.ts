import type { JSONValue } from '@ai-sdk/provider';

import { createLogger } from '@/lib/utils/logger';
import type {
  BuiltinMcpServerContext,
  BuiltinMcpToolDefinition,
  BuiltinMcpToolResult,
} from '@/lib/mcp/builtin/types';

const logger = createLogger('web-fetch');

const BING_SEARCH_URL = 'https://www.bing.com/search';
const DUCKDUCKGO_SEARCH_URL = 'https://html.duckduckgo.com/html/';
const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

const USER_AGENT_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];
const SEARCH_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 20_000;
const FETCH_MAX_RETRIES = 2;
const DEFAULT_FETCH_TEXT_LIMIT = 20_000;
const DEFAULT_RAW_HTML_LIMIT = 50_000;

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  source: string;
};

type SearchAttempt = {
  provider: string;
  ok: boolean;
  error?: string;
  resultCount?: number;
};

function buildError(message: string): BuiltinMcpToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripHtmlBlock(html: string, tagName: string): string {
  const open = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  const close = new RegExp(`</${tagName}\\b[^>]*>`, 'gi');
  let previous = '';
  let result = html;
  while (previous !== result) {
    previous = result;
    result = result.replace(
      new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?</${tagName}\\b[^>]*>`, 'gi'),
      ' ',
    );
  }
  // Drop any unmatched leftover open/close tags of this kind.
  return result.replace(open, ' ').replace(close, ' ');
}

function stripHtml(html: string): string {
  return decodeHtmlEntities(
    stripHtmlBlock(
      stripHtmlBlock(stripHtmlBlock(html, 'script'), 'style'),
      'noscript',
    ).replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const removed = value.length - maxLength;
  return `${value.slice(0, maxLength)}\n\n[truncated: ${removed} characters removed]`;
}

function toJsonValue(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value)) as JSONValue;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cleanUrl(value: string): string {
  const decoded = decodeHtmlEntities(value);
  try {
    const url = new URL(decoded, 'https://duckduckgo.com');
    const redirectParam =
      url.searchParams.get('uddg') ??
      url.searchParams.get('u') ??
      url.searchParams.get('url');
    if (redirectParam) {
      return decodeURIComponent(redirectParam);
    }
    return url.toString();
  } catch {
    return decoded;
  }
}

function validateHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function maxResultsInput(input: Record<string, unknown>): number {
  const value = input.max_results;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 5;
  }

  return Math.min(Math.floor(value), 10);
}

function maxLengthInput(
  input: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(value), fallback);
}

let uaIndex = 0;
function rotateUserAgent(): string {
  const ua = USER_AGENT_POOL[uaIndex % USER_AGENT_POOL.length];
  uaIndex++;
  return ua;
}

function buildBrowserHeaders(url: string, ua: string): Record<string, string> {
  let origin: string | undefined;
  try {
    origin = new URL(url).origin;
  } catch {}

  return {
    'user-agent': ua,
    accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
    'accept-encoding': 'gzip, deflate, br',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    ...(origin ? { referer: origin } : {}),
  };
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

async function fetchUrlWithRetry(
  url: string,
  timeoutMs: number,
  maxRetries: number,
  proxyUrl?: string,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const ua = rotateUserAgent();
      const headers = buildBrowserHeaders(url, ua);
      const fetchUrl = proxyUrl
        ? `${proxyUrl}?url=${encodeURIComponent(url)}`
        : url;

      const response = await fetchWithTimeout(
        fetchUrl,
        {
          method: 'GET',
          headers,
          redirect: 'follow',
        },
        timeoutMs,
      );

      if (response.ok || response.status === 404 || response.status === 403) {
        return response;
      }

      if (attempt < maxRetries && response.status >= 500) {
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * (attempt + 1)),
        );
        continue;
      }

      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries) {
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * (attempt + 1)),
        );
        continue;
      }
    }
  }

  throw lastError ?? new Error('Fetch failed after retries');
}

function extractTitle(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  return stripHtml(title);
}

function countMatches(html: string, pattern: RegExp): number {
  return html.match(pattern)?.length ?? 0;
}

function detectJavaScriptRenderingNeed(
  html: string,
  text: string,
): {
  likely: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  const lowerHtml = html.toLowerCase();
  const lowerText = text.toLowerCase();
  const scriptCount = countMatches(html, /<script\b/gi);
  const bodyHtml = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;
  const bodyWithoutScripts = stripHtmlBlock(
    stripHtmlBlock(bodyHtml, 'script'),
    'style',
  ).trim();
  const visibleWordCount = text
    .split(/\s+/)
    .filter((word) => word.trim().length > 0).length;

  if (
    /<div[^>]+id=["'](?:root|app|__next|__nuxt|svelte)["'][^>]*>\s*<\/div>/i.test(
      html,
    )
  ) {
    reasons.push('empty app root container');
  }

  if (
    lowerHtml.includes('__next_data__') ||
    lowerHtml.includes('webpack') ||
    lowerHtml.includes('vite') ||
    lowerHtml.includes('static/chunks') ||
    lowerHtml.includes('/_next/')
  ) {
    reasons.push('client application bundle markers');
  }

  if (
    lowerText.includes('enable javascript') ||
    lowerText.includes('requires javascript') ||
    lowerHtml.includes('please enable javascript')
  ) {
    reasons.push('page asks for JavaScript');
  }

  if (visibleWordCount < 80 && scriptCount >= 5) {
    reasons.push('little visible text with many scripts');
  }

  if (
    visibleWordCount < 20 &&
    bodyWithoutScripts.length < 800 &&
    scriptCount > 0
  ) {
    reasons.push('mostly empty HTML body');
  }

  return {
    likely: reasons.length > 0,
    reasons,
  };
}

async function fetchText(
  url: string,
  init: RequestInit = {},
): Promise<{
  response: Response;
  text: string;
}> {
  const ua = rotateUserAgent();
  const response = await fetch(url, {
    ...init,
    headers: {
      'user-agent': ua,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  const text = await response.text();
  return { response, text };
}

async function searchBrave(
  query: string,
  maxResults: number,
): Promise<SearchResult[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!apiKey) {
    return [];
  }

  const url = `${BRAVE_SEARCH_URL}?${new URLSearchParams({
    q: query,
    count: String(maxResults),
  }).toString()}`;
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'accept-encoding': 'gzip',
      'x-subscription-token': apiKey,
    },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `Brave Search failed with status ${response.status}: ${JSON.stringify(payload)}`,
    );
  }

  const results = asArray(
    asRecord(payload).web && asRecord(asRecord(payload).web).results,
  );
  return results
    .map((item) => {
      const record = asRecord(item);
      return {
        title: String(record.title ?? ''),
        url: String(record.url ?? ''),
        snippet: stripHtml(String(record.description ?? '')),
        source: 'brave',
      };
    })
    .filter((result) => result.title || result.url || result.snippet)
    .slice(0, maxResults);
}

async function searchTavily(
  query: string,
  maxResults: number,
): Promise<SearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey) {
    return [];
  }

  const response = await fetch(TAVILY_SEARCH_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      search_depth: 'basic',
    }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `Tavily Search failed with status ${response.status}: ${JSON.stringify(payload)}`,
    );
  }

  return asArray(asRecord(payload).results)
    .map((item) => {
      const record = asRecord(item);
      return {
        title: String(record.title ?? ''),
        url: String(record.url ?? ''),
        snippet: stripHtml(String(record.content ?? '')),
        source: 'tavily',
      };
    })
    .filter((result) => result.title || result.url || result.snippet)
    .slice(0, maxResults);
}

function parseDuckDuckGoResults(
  html: string,
  maxResults: number,
): SearchResult[] {
  const results: SearchResult[] = [];
  const resultRegex =
    /<div[^>]+class="[^"]*\bresult\b[^"]*"[\s\S]*?<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>)/gi;
  let match: RegExpExecArray | null = resultRegex.exec(html);

  while (match !== null && results.length < maxResults) {
    results.push({
      url: cleanUrl(match[1] ?? ''),
      title: stripHtml(match[2] ?? ''),
      snippet: stripHtml(match[3] ?? match[4] ?? ''),
      source: 'duckduckgo-html',
    });
    match = resultRegex.exec(html);
  }

  return results;
}

function parseBingResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const algoRegex = /<li class="b_algo"[\s\S]*?<\/li>/gi;
  let match: RegExpExecArray | null = algoRegex.exec(html);

  while (match !== null && results.length < maxResults) {
    const block = match[0];
    const titleMatch =
      /<h2[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i.exec(
        block,
      );
    const snippetMatch =
      /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block) ??
      /<div class="b_caption"[^>]*>[\s\S]*?<p>([\s\S]*?)<\/p>/i.exec(block);

    const title = titleMatch ? stripHtml(titleMatch[2] ?? '') : '';
    const url = titleMatch ? cleanUrl(titleMatch[1] ?? '') : '';
    const snippet = snippetMatch ? stripHtml(snippetMatch[1] ?? '') : '';

    if (title || snippet || url) {
      results.push({
        title,
        url,
        snippet,
        source: 'bing-html',
      });
    }
    match = algoRegex.exec(html);
  }

  return results;
}

async function searchDuckDuckGoHtml(
  query: string,
  maxResults: number,
): Promise<SearchResult[]> {
  const searchUrl = `${DUCKDUCKGO_SEARCH_URL}?${new URLSearchParams({
    q: query,
  }).toString()}`;
  const { response, text } = await fetchText(searchUrl, {
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`DuckDuckGo HTML failed with status ${response.status}`);
  }

  return parseDuckDuckGoResults(text, maxResults);
}

async function searchBingHtml(
  query: string,
  maxResults: number,
): Promise<SearchResult[]> {
  const searchUrl = `${BING_SEARCH_URL}?${new URLSearchParams({
    q: query,
    count: String(maxResults),
  }).toString()}`;
  const { response, text } = await fetchText(searchUrl, {
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Bing HTML failed with status ${response.status}`);
  }

  return parseBingResults(text, maxResults);
}

async function runSearchFallbacks(
  query: string,
  maxResults: number,
): Promise<{ results: SearchResult[]; attempts: SearchAttempt[] }> {
  const attempts: SearchAttempt[] = [];
  const providers: Array<{
    name: string;
    enabled: boolean;
    search: () => Promise<SearchResult[]>;
  }> = [
    {
      name: 'brave',
      enabled: Boolean(process.env.BRAVE_SEARCH_API_KEY?.trim()),
      search: () => searchBrave(query, maxResults),
    },
    {
      name: 'tavily',
      enabled: Boolean(process.env.TAVILY_API_KEY?.trim()),
      search: () => searchTavily(query, maxResults),
    },
    {
      name: 'duckduckgo-html',
      enabled: true,
      search: () => searchDuckDuckGoHtml(query, maxResults),
    },
    {
      name: 'bing-html',
      enabled: true,
      search: () => searchBingHtml(query, maxResults),
    },
  ];

  for (const provider of providers) {
    if (!provider.enabled) {
      continue;
    }

    try {
      const results = await provider.search();
      attempts.push({
        provider: provider.name,
        ok: true,
        resultCount: results.length,
      });
      if (results.length > 0) {
        return { results, attempts };
      }
    } catch (error) {
      attempts.push({
        provider: provider.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { results: [], attempts };
}

function formatSearchResults(
  results: SearchResult[],
  attempts: SearchAttempt[],
): string {
  if (results.length === 0) {
    const attempted = attempts
      .map((attempt) =>
        attempt.ok
          ? `${attempt.provider}: 0 results`
          : `${attempt.provider}: ${attempt.error}`,
      )
      .join('; ');
    return `No search results found. Attempts: ${attempted || 'none'}`;
  }

  const body = results
    .map((result, index) =>
      [
        `${index + 1}. ${result.title || result.url || 'Untitled result'}`,
        result.url ? `   URL: ${result.url}` : '',
        result.snippet ? `   ${result.snippet}` : '',
        `   Source: ${result.source}`,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
  const attemptsLine = attempts
    .map((attempt) =>
      attempt.ok
        ? `${attempt.provider}(${attempt.resultCount ?? 0})`
        : `${attempt.provider}(failed)`,
    )
    .join(', ');

  return `${body}\n\nSearch attempts: ${attemptsLine}`;
}

export const builtinWebTools: BuiltinMcpToolDefinition[] = [
  {
    name: 'web_search',
    title: 'Web Search',
    description:
      'Search the public web for current information. Uses configured search APIs first, then HTML search fallbacks.',
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
    description:
      'Fetch a URL with plain HTTP and return extracted text. Includes a hint when JavaScript rendering is likely required. WARNING: Do NOT use this after calling browser_navigate — use browser_get_text instead to reuse the browser session.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        max_length: { type: 'number' },
        raw_html: { type: 'boolean' },
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

      const maxResults = maxResultsInput(input);
      const { results, attempts } = await runSearchFallbacks(query, maxResults);

      return {
        content: [
          { type: 'text', text: formatSearchResults(results, attempts) },
        ],
        structuredContent: toJsonValue({ results, attempts }),
      };
    }

    if (toolName === 'fetch_url') {
      const url = validateHttpUrl(
        typeof input.url === 'string' ? input.url.trim() : '',
      );
      if (!url) {
        return buildError('Missing or invalid HTTP(S) URL.');
      }

      logger.info('fetch_url called', {
        url,
        sessionId: _context?.sessionId,
        agentName: _context?.agentName,
      });

      const proxyUrl = process.env.HTTP_PROXY_URL?.trim();
      const response = await fetchUrlWithRetry(
        url,
        FETCH_TIMEOUT_MS,
        FETCH_MAX_RETRIES,
        proxyUrl,
      );

      const body = await response.text();

      if (!response.ok) {
        logger.warn('fetch_url failed', { url, status: response.status });
        return buildError(`Fetch failed with status ${response.status}`);
      }

      logger.info('fetch_url succeeded', {
        url,
        status: response.status,
        contentLength: body.length,
      });

      const contentType = response.headers.get('content-type') ?? '';
      const rawHtml = input.raw_html === true;
      const text = contentType.toLowerCase().includes('text/html')
        ? stripHtml(body)
        : body;
      const jsRendering = contentType.toLowerCase().includes('text/html')
        ? detectJavaScriptRenderingNeed(body, text)
        : { likely: false, reasons: [] };
      const maxLength = maxLengthInput(
        input,
        'max_length',
        rawHtml ? DEFAULT_RAW_HTML_LIMIT : DEFAULT_FETCH_TEXT_LIMIT,
      );
      const title = contentType.toLowerCase().includes('text/html')
        ? extractTitle(body)
        : '';
      const renderedHint = jsRendering.likely
        ? [
            '',
            '[JavaScript rendering likely required]',
            `Reasons: ${jsRendering.reasons.join(', ')}`,
            'Use browser_navigate with browser_get_text/browser_get_html for rendered content.',
          ].join('\n')
        : '';

      const output = [
        `URL: ${response.url}`,
        `Status: ${response.status}`,
        contentType ? `Content-Type: ${contentType}` : '',
        title ? `Title: ${title}` : '',
        '',
        truncate(rawHtml ? body : text, maxLength),
        renderedHint,
      ]
        .filter(Boolean)
        .join('\n');

      return {
        content: [{ type: 'text', text: output }],
        structuredContent: toJsonValue({
          url: response.url,
          status: response.status,
          contentType,
          title,
          jsRendering,
          rawHtml,
        }),
      };
    }

    return buildError(`Unknown builtin web tool: ${toolName}`);
  } catch (error) {
    return buildError(
      error instanceof Error ? error.message : 'Web tool execution failed',
    );
  }
}
