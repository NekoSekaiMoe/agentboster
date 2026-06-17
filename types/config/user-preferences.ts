/**
 * Per-user preferences that override the global AppConfig defaults for the
 * user's own interactions (chat, memory extraction). Background tasks
 * (task-summary, task-memory, compress, L1 scorer) ignore these and always
 * use the global fallback (`config.models.model`), because they have no
 * meaningful "owning user" in scope.
 *
 * Everything in this object is optional. An unset field means "fall back to
 * the global default" — there is no `null`-sentinel semantics.
 */
export interface UserModelPreferences {
  /**
   * Default model id ("provider/model-id" or bare). When set, this user's
   * chat runs use this model instead of `config.models.model`.
   */
  model?: string;
}
