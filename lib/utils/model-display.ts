/**
 * Human-friendly display names for raw model ids.
 *
 * The chat header shows the formatted model name only (no provider
 * prefix — the brand is already part of the model name). Raw ids arrive
 * in shapes like:
 *
 *   deepseek-v4-flash        -> { provider: 'DeepSeek',  model: 'DeepSeek V4 Flash' }
 *   claude-sonnet-4-5        -> { provider: 'Anthropic', model: 'Claude Sonnet 4.5' }
 *   glm-rikki/glm-5.2        -> { provider: 'GLM Rikki', model: 'GLM 5.2' }
 *   gpt-4o                   -> { provider: 'OpenAI',    model: 'GPT 4o' }
 *
 * Rules:
 *  - `-` / `_` are word separators.
 *  - Known brands get their canonical casing (deepseek -> DeepSeek, glm -> GLM).
 *  - `v4` -> `V4`; numeric tokens keep their digits.
 *  - Consecutive trailing pure-digit tokens are joined with `.`
 *    (claude-sonnet-4-5 -> Claude Sonnet 4.5).
 *  - With a `provider/model` id the provider part is formatted the same way;
 *    without one it is inferred from the first model token when the brand is
 *    known (claude -> Anthropic, gpt/o-series -> OpenAI, gemini -> Google,
 *    otherwise the brand itself, e.g. deepseek -> DeepSeek).
 */

/** Canonical casing for known brand / tier tokens (lookup is lowercase). */
const TOKEN_CASES: Record<string, string> = {
  // brands
  deepseek: 'DeepSeek',
  glm: 'GLM',
  claude: 'Claude',
  gpt: 'GPT',
  chatgpt: 'ChatGPT',
  codex: 'Codex',
  gemini: 'Gemini',
  qwen: 'Qwen',
  llama: 'Llama',
  mistral: 'Mistral',
  mixtral: 'Mixtral',
  grok: 'Grok',
  kimi: 'Kimi',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  zhipu: 'Zhipu',
  moonshot: 'Moonshot',
  minimax: 'MiniMax',
  doubao: 'Doubao',
  hunyuan: 'Hunyuan',
  ernie: 'ERNIE',
  yi: 'Yi',
  // claude tiers
  sonnet: 'Sonnet',
  opus: 'Opus',
  haiku: 'Haiku',
  // common tiers
  flash: 'Flash',
  pro: 'Pro',
  lite: 'Lite',
  mini: 'Mini',
  nano: 'Nano',
  turbo: 'Turbo',
  max: 'Max',
  ultra: 'Ultra',
  plus: 'Plus',
};

/**
 * When a bare model id (no `provider/` prefix) starts with one of these
 * tokens, the provider is the company rather than the brand itself.
 */
const PROVIDER_BY_FIRST_TOKEN: Record<string, string> = {
  claude: 'Anthropic',
  gpt: 'OpenAI',
  chatgpt: 'OpenAI',
  codex: 'OpenAI',
  o1: 'OpenAI',
  o3: 'OpenAI',
  o4: 'OpenAI',
  gemini: 'Google',
};

function formatToken(token: string): string {
  const lower = token.toLowerCase();
  const known = TOKEN_CASES[lower];
  if (known) {
    return known;
  }
  if (/^v\d/.test(lower)) {
    // v4 -> V4
    return `V${token.slice(1)}`;
  }
  if (/^\d/.test(token)) {
    // 4o / 5.2 / 70b keep their shape
    return token;
  }
  return token.charAt(0).toUpperCase() + token.slice(1);
}

function formatSegment(segment: string): string {
  const tokens = segment.split(/[-_]+/).filter(Boolean);
  const merged: string[] = [];
  for (const token of tokens) {
    const previous = merged[merged.length - 1];
    if (
      /^\d+$/.test(token) &&
      previous !== undefined &&
      /^\d+$/.test(previous)
    ) {
      // 4-5 -> 4.5 (version tail)
      merged[merged.length - 1] = `${previous}.${token}`;
    } else {
      merged.push(token);
    }
  }
  return merged.map(formatToken).join(' ');
}

export type ModelDisplay = {
  /** Formatted provider, or null when it cannot be inferred. */
  provider: string | null;
  /** Formatted model name. */
  model: string;
};

export function parseModelDisplay(modelId: string): ModelDisplay {
  const trimmed = modelId.trim();
  const slashIndex = trimmed.indexOf('/');
  const providerRaw = slashIndex > 0 ? trimmed.slice(0, slashIndex) : null;
  const modelRaw = slashIndex > 0 ? trimmed.slice(slashIndex + 1) : trimmed;

  const model = formatSegment(modelRaw);

  let provider: string | null = null;
  if (providerRaw) {
    provider = formatSegment(providerRaw);
  } else {
    const firstToken = modelRaw.split(/[-_]+/)[0]?.toLowerCase();
    if (firstToken) {
      provider =
        PROVIDER_BY_FIRST_TOKEN[firstToken] ?? TOKEN_CASES[firstToken] ?? null;
    }
  }

  return { provider, model };
}
