const BASE_SET: ReadonlySet<string> = new Set([
  'readMemory',
  'writeMemory',
  'deleteMemory',
  // skill entrypoints — keep list + get so the agent can answer
  // "what skills do I have" and read one when the user mentions it
  'listSkills',
  'getSkill',
  'getSkillFile',
  'getSkillEntrypoint',
  // task summary + scheduling — long-running task continuity + "remind me tomorrow"
  'task_summary',
  'task_progress',
  'dailyTask',
  'delayTask',
]);

const SANDBOX_SET: ReadonlySet<string> = new Set([
  'exec',
  'readFile',
  'writeFile',
  'openPort',
  'downloadFile',
]);

const SUBAGENT_SET: ReadonlySet<string> = new Set(['subAgent']);

const NODES_SET: ReadonlySet<string> = new Set(['listNodes', 'getBestNode']);

// Heuristic input length above which we fall back to the full toolset.
// Long inputs usually signal complex tasks where keyword matching may miss
// the actual intent — the cost of a missing tool (LLM stalls or calls a
// hallucinated name) outweighs the prompt savings.
const TASK_MODE_INPUT_LENGTH_THRESHOLD = 500;

// Keyword routing tables. Lowercase, plain substring match — no regex,
// no normalisation, no segmentation. Languages covered: en, zh.
const SANDBOX_KEYWORDS = [
  // en
  'code',
  'exec',
  'run',
  'file',
  'shell',
  'bash',
  'script',
  'build',
  'compile',
  'test',
  'npm',
  'node',
  'python',
  'go ',
  'rust',
  'java ',
  'grep',
  'git ',
  'commit',
  'branch',
  'deploy',
  'debug',
  'log',
  'stdout',
  'stderr',
  // zh
  '代码',
  '命令',
  '执行',
  '跑',
  '脚本',
  '编译',
  '安装',
  '部署',
  '调试',
  '日志',
  '文件',
  '读写',
  '压缩',
  '下载文件',
] as const;

const SANDBOX_CODE_FENCE_RE = /```/;

const SUBAGENT_KEYWORDS = [
  'delegate',
  'sub-agent',
  'subagent',
  'parallel task',
  'fan out',
  '委派',
  '子代理',
  '子任务',
  '并行',
] as const;

const NODES_KEYWORDS = [
  'sandbox node',
  'agentd node',
  'fleet',
  'compute node',
  'best node',
  '节点',
  'fleet',
  'agentd',
] as const;

const BROWSER_KEYWORDS = [
  'browse',
  'browser',
  'web page',
  'website',
  'click',
  'screenshot',
  'navigate to',
  'open url',
  '网页',
  '网站',
  '页面',
  '浏览器',
  '点击',
] as const;

export type ToolSelectionStrategy = 'dynamic' | 'all';

export interface SelectToolsOptions {
  /** The latest user-facing input text (system messages excluded). */
  userInput: string;
  /** Previously-finished steps in this run, used to keep historical tools. */
  steps: ReadonlyArray<{
    toolCalls?: ReadonlyArray<{ toolName: string }>;
    toolResults?: ReadonlyArray<{ toolName: string }>;
  }>;
  /** Complete set of tool names actually registered (for filtering). */
  availableTools: ReadonlySet<string>;
  /** MCP tool names registered at runtime (browser_*, web_search, etc.). */
  mcpTools?: ReadonlySet<string>;
  /** Per-agent config switch. Default: 'dynamic'. */
  strategy?: ToolSelectionStrategy;
}

/**
 * Pick which tool names should be exposed to the LLM for the next step.
 *
 * Strategy 'all' returns every registered tool name (legacy behaviour).
 *
 * Strategy 'dynamic' (default) returns:
 *   1. BASE_SET — memory / skill reads / task summary / scheduling. Always
 *      present so the agent can answer "what skills do I have", continue a
 *      long task, or schedule a follow-up even when the current turn looks
 *      like chat.
 *   2. Historical dependency — every tool that was actually CALLED in any
 *      previous step of this run. Without this, the LLM sees a tool_result
 *      for a tool that's no longer in its tool list and gets confused.
 *   3. Keyword-routed groups — sandbox / subAgent / nodes / browser — when
 *      the user's input mentions them.
 *   4. Long-input fallback — if the input exceeds
 *      TASK_MODE_INPUT_LENGTH_THRESHOLD characters OR contains a ``` code
 *      fence, the full toolset is returned. Long inputs usually mean
 *      "execute this complex task" and keyword matching may miss intent.
 *
 * The result is intersected with `availableTools` so callers never receive
 * a tool name that wasn't registered (e.g. when sandbox is disabled at the
 * config level).
 */
export function selectToolsForInput(options: SelectToolsOptions): string[] {
  const {
    userInput,
    steps,
    availableTools,
    mcpTools,
    strategy = 'dynamic',
  } = options;

  if (strategy === 'all') {
    return [...availableTools];
  }

  const input = (userInput ?? '').toLowerCase();
  const isLongInput = input.length >= TASK_MODE_INPUT_LENGTH_THRESHOLD;
  const hasCodeFence = SANDBOX_CODE_FENCE_RE.test(userInput ?? '');

  // (4) Long-input fallback — full toolset.
  if (isLongInput || hasCodeFence) {
    return [...availableTools];
  }

  const selected = new Set<string>();

  // (1) Base set — always present.
  for (const name of BASE_SET) {
    selected.add(name);
  }

  // (2) Historical dependency — keep every tool used in previous steps.
  for (const step of steps) {
    for (const call of step.toolCalls ?? []) {
      selected.add(call.toolName);
    }
    for (const result of step.toolResults ?? []) {
      selected.add(result.toolName);
    }
  }

  // (3) Keyword routing.
  if (containsAny(input, SANDBOX_KEYWORDS)) {
    addAll(selected, SANDBOX_SET);
  }
  if (containsAny(input, SUBAGENT_KEYWORDS)) {
    addAll(selected, SUBAGENT_SET);
  }
  if (containsAny(input, NODES_KEYWORDS)) {
    addAll(selected, NODES_SET);
  }
  if (containsAny(input, BROWSER_KEYWORDS)) {
    // Browser tools come from MCP (web_search, browser_navigate, etc.).
    // We don't know their exact names ahead of time, so when the user
    // mentions browsing we expose ALL mcp tools. This is a deliberate
    // trade-off: browser intent is rare and mis-routing is costly.
    if (mcpTools) {
      addAll(selected, mcpTools);
    }
  }

  // Intersect with actually-registered tools.
  const result: string[] = [];
  for (const name of selected) {
    if (availableTools.has(name)) {
      result.push(name);
    }
  }

  return result;
}

function containsAny(
  haystack: string,
  needles: ReadonlyArray<string>,
): boolean {
  for (const n of needles) {
    if (haystack.includes(n)) {
      return true;
    }
  }
  return false;
}

function addAll<T>(set: Set<T>, values: Iterable<T>): void {
  for (const v of values) {
    set.add(v);
  }
}

/**
 * Extract the latest user-role text from a LanguageModelV3Prompt / ModelMessage[]
 * for tool selection. Returns '' when no user text is found.
 *
 * Accepts the message shape used by the ai SDK in prepareStep: an array of
 * { role, content } where content may be a string or an array of parts.
 */
export function extractLatestUserText(
  messages: ReadonlyArray<{
    role: string;
    content: unknown;
  }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      // Concatenate text parts. Other parts (images, files) carry no
      // keyword signal — skip them.
      let text = '';
      for (const part of c) {
        if (
          part &&
          typeof part === 'object' &&
          'type' in part &&
          (part as { type: string }).type === 'text' &&
          'text' in part &&
          typeof (part as { text?: unknown }).text === 'string'
        ) {
          text += (part as { text: string }).text;
        }
      }
      return text;
    }
  }
  return '';
}
