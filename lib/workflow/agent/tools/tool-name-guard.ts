/**
 * Unified tool-name guard.
 *
 * DurableAgent's `executeTool` hard-throws `Tool "X" not found` when
 * `tools[toolName]` is undefined, and that throw is NOT caught by
 * `experimental_repairToolCall` (which only fires on schema-validation
 * failure). To keep the workflow run alive when the model emits an empty
 * or hallucinated tool name, the toolset returned by `buildAgentTools`
 * is wrapped in a Proxy (see `createResilientToolSet` in `./index.ts`)
 * that synthesizes a fallback tool for any unknown key — so
 * `tools[anything]` is always truthy and executeTool's hard throw is
 * never reached.
 *
 * This module is the single source of truth for normalizing tool names
 * and is consumed by:
 *   1. `createResilientToolSet` — its fallback tool uses
 *      `sanitizeToolName` (alias resolution) and `suggestClosestName`
 *      (edit-distance fallback) to either forward the call to the
 *      canonical real tool or return a structured error telling the
 *      model which tools exist.
 *   2. `chatWorkflow` — wires `experimental_repairToolCall`, which
 *      reuses `sanitizeToolName` to fix schema-failure cases where the
 *      model got the name subtly wrong.
 *
 * Both paths share `sanitizeToolName`, so adding a new alias or fuzzy
 * rule only requires editing this file.
 */

/**
 * Aliases the model is likely to hallucinate.
 *
 * The left side is the malformed name the model emitted; the right side is
 * the canonical key registered in the ToolSet. Only aliases whose canonical
 * name actually exists as a registered tool are honored at runtime
 * (checked against the `known` set), so it is safe to be permissive here.
 *
 * Rules covered:
 *  - snake_case variants of camelCase tools (write_memory → writeMemory)
 *  - kebab-case variants (write-memory → writeMemory)
 *  - common typos / casing mistakes for built-in tools
 *
 * Tools whose canonical name is already snake_case (task_summary, web_search,
 * browser_*, github_*, context7_*) are intentionally NOT listed: the model
 * already sees them as snake_case in the tools array, so a hallucination
 * would be a different class of error handled by the fuzzy matcher.
 */
export const TOOL_NAME_ALIASES: Record<string, string> = {
  // memory tools (camelCase canonical)
  write_memory: 'writeMemory',
  'write-memory': 'writeMemory',
  read_memory: 'readMemory',
  'read-memory': 'readMemory',
  delete_memory: 'deleteMemory',
  'delete-memory': 'deleteMemory',

  // skill tools (camelCase canonical)
  list_skills: 'listSkills',
  'list-skills': 'listSkills',
  get_skill: 'getSkill',
  'get-skill': 'getSkill',
  get_skill_file: 'getSkillFile',
  'get-skill-file': 'getSkillFile',
  get_skill_entrypoint: 'getSkillEntrypoint',
  'get-skill-entrypoint': 'getSkillEntrypoint',
  import_skill_repo: 'importSkillRepo',
  'import-skill-repo': 'importSkillRepo',
  import_skill_from_clawhub: 'importSkillFromClawHub',
  upsert_skill: 'upsertSkill',
  'upsert-skill': 'upsertSkill',
  update_skill_file: 'updateSkillFile',
  'update-skill-file': 'updateSkillFile',
  delete_skill: 'deleteSkill',
  'delete-skill': 'deleteSkill',

  // task tools (camelCase canonical)
  daily_task: 'dailyTask',
  'daily-task': 'dailyTask',
  delay_task: 'delayTask',
  'delay-task': 'delayTask',
  sub_agent: 'subAgent',
  'sub-agent': 'subAgent',

  // sandbox tools (camelCase canonical)
  read_file: 'readFile',
  'read-file': 'readFile',
  write_file: 'writeFile',
  'write-file': 'writeFile',
  open_port: 'openPort',
  'open-port': 'openPort',
  download_file: 'downloadFile',
  'download-file': 'downloadFile',

  // agentd node tools (camelCase canonical)
  list_nodes: 'listNodes',
  'list-nodes': 'listNodes',
  get_best_node: 'getBestNode',
  'get-best-node': 'getBestNode',
};

export type SanitizeResult = {
  name: string;
  reason: 'exact' | 'alias' | 'case-insensitive';
};

/**
 * Normalize a raw tool name against the set of known tool names.
 *
 * @returns the canonical name + how it was resolved, or `null` if the name
 *          is empty, blank, or completely unknown.
 */
export function sanitizeToolName(
  raw: string | undefined | null,
  known: Set<string>,
): SanitizeResult | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // 1. Exact match — fast path.
  if (known.has(trimmed)) {
    return { name: trimmed, reason: 'exact' };
  }

  // 2. Alias map (snake_case / kebab-case / common typos).
  const aliased =
    TOOL_NAME_ALIASES[trimmed] ?? TOOL_NAME_ALIASES[trimmed.toLowerCase()];
  if (aliased && known.has(aliased)) {
    return { name: aliased, reason: 'alias' };
  }

  // 3. Case-insensitive fallback. Catches "WriteMemory", "WRITEMEMORY", etc.
  //    Only used when there's exactly one case variant in `known` to avoid
  //    ambiguity (e.g. if both "Foo" and "foo" were registered, we punt and
  //    let the trap path emit an error).
  const lower = trimmed.toLowerCase();
  const matches = [...known].filter((n) => n.toLowerCase() === lower);
  if (matches.length === 1) {
    return { name: matches[0], reason: 'case-insensitive' };
  }

  return null;
}

/**
 * Maximum Levenshtein distance considered "close enough" for a suggestion.
 * Tuned to catch single-character edits and transpositions without
 * suggesting wildly unrelated tools.
 */
const SUGGEST_MAX_DISTANCE = 2;

/**
 * Compute Levenshtein edit distance between two strings.
 * Iterative two-row implementation; O(a.length * b.length) time, O(min) space.
 */
function levenshtein(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;

  if (al === 0) return bl;
  if (bl === 0) return al;

  // Ensure b is the shorter string to minimize row width.
  if (bl > al) {
    return levenshtein(b, a);
  }

  let prevRow = new Array<number>(bl + 1);
  let currRow = new Array<number>(bl + 1);

  for (let j = 0; j <= bl; j++) {
    prevRow[j] = j;
  }

  for (let i = 1; i <= al; i++) {
    currRow[0] = i;
    const aChar = a.charCodeAt(i - 1);

    for (let j = 1; j <= bl; j++) {
      const cost = aChar === b.charCodeAt(j - 1) ? 0 : 1;
      const del = prevRow[j] + 1;
      const ins = currRow[j - 1] + 1;
      const sub = prevRow[j - 1] + cost;
      currRow[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }

    [prevRow, currRow] = [currRow, prevRow];
  }

  return prevRow[bl];
}

/**
 * Suggest the closest known tool name by edit distance.
 *
 * @returns the closest name within {@link SUGGEST_MAX_DISTANCE}, or `null`
 *          if nothing is close enough. Ties are broken by the order keys
 *          appear in `known`, which is deterministic for a given build.
 */
export function suggestClosestName(
  raw: string | undefined | null,
  known: Set<string>,
): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let best: string | null = null;
  let bestDist = SUGGEST_MAX_DISTANCE + 1;

  for (const candidate of known) {
    // Skip our own trap alias keys when suggesting — they aren't real tools.
    if (TOOL_NAME_ALIASES[candidate] !== undefined) {
      continue;
    }
    const dist = levenshtein(trimmed.toLowerCase(), candidate.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }

  return best;
}

/**
 * Maximum length permitted for a tool/function name. Mirrors Gemini's
 * documented 128-char cap, which is the strictest limit among the
 * providers we support.
 */
export const MAX_TOOL_NAME_LENGTH = 128;

/**
 * Regex describing a provider-safe tool name.
 *
 * Gemini enforces the strictest rules among the providers we target:
 *   - first character must be a letter or underscore
 *   - subsequent characters must be in [a-zA-Z0-9_.:-]
 *   - max length 128 chars
 *
 * OpenAI's rules are looser (allows nearly anything), but a name that
 * satisfies Gemini also satisfies OpenAI/Anthropic, so this is the
 * conservative gate.
 */
const VALID_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;

/**
 * Returns true if {@link name} is a valid tool/function name for every
 * supported provider. The empty string, names starting with a digit or
 * dash/dot/colon, names containing characters outside the allowed set,
 * and names longer than 128 chars all return false.
 */
export function isValidToolName(name: string): boolean {
  return VALID_TOOL_NAME.test(name);
}
