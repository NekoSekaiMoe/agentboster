/**
 * Per-user preferences that override the global AppConfig defaults for the
 * user's own interactions (chat, memory extraction, CLI). Background tasks
 * (task-summary, task-memory, compress, L1 scorer) ignore these and always
 * use the global fallback (`config.models.model`), because they have no
 * meaningful "owning user" in scope.
 *
 * Everything in this object is optional. An unset field means "fall back to
 * the global default" — there is no `null`-sentinel semantics.
 *
 * These preferences are shared across channels (web chat, IM, CLI): the
 * CLI reads them at startup and writes back when the user switches model
 * or thinking level from the terminal, so the three surfaces stay in sync.
 */
export interface UserModelPreferences {
  /**
   * Default model id ("provider/model-id" or bare). When set, this user's
   * chat runs use this model instead of `config.models.model`.
   */
  model?: string;

  /**
   * Default thinking level applied when the chosen model supports thinking
   * and the caller hasn't pinned one explicitly. Mirrors the CLI
   * "defaultThinkingLevel" setting that used to live in
   * ~/.agentboster/settings.json.
   */
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
}
