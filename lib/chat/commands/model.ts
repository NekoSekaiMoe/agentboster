import { getUserById, updateUserModelPreferences } from '@/lib/core/db/users';
import { aiModelConfigSchema } from '@/types/config/ai';

export async function executeModelCommand(
  args: string,
  options?: {
    userId?: string | null;
  },
): Promise<string> {
  const trimmed = args.trim();
  const userId = options?.userId ?? null;

  if (!trimmed) {
    if (!userId) {
      return 'Cannot show model: user ID not available.';
    }
    const { getConfig } = await import('@/lib/core/kv/config');
    const [config, user] = await Promise.all([
      getConfig(),
      getUserById(userId),
    ]);
    const personalModel = user?.modelPreferences?.model;
    const globalModel = config.models?.model;
    if (personalModel) {
      return [
        `Your preferred model: ${personalModel}`,
        globalModel
          ? `(global default: ${globalModel})`
          : '(no global default set)',
      ].join('\n');
    }
    return globalModel
      ? `Currently using global default: ${globalModel} (set a personal preference with /model <name>)`
      : 'No model set. Set one with /model <name>.';
  }

  const parsed = aiModelConfigSchema.safeParse(trimmed);
  if (!parsed.success) {
    return 'Invalid model format. Model ID must not be empty.';
  }

  if (!userId) {
    return 'Cannot set model: user ID not available.';
  }

  // Enforce the admin-configured model allowlist (models.model_catalog).
  // When the admin has set a catalog, only its keys are accepted. This
  // matches the web chat-box picker, which restricts selection to the
  // same list. An absent/empty catalog means "no restriction" — free-form
  // input remains allowed (mirrors the web fallback).
  const { getConfig } = await import('@/lib/core/kv/config');
  const config = await getConfig();
  const allowed = Object.keys(config.models?.model_catalog ?? {});
  if (allowed.length > 0 && !allowed.includes(parsed.data)) {
    const suggestion = allowed.slice().sort().join(', ');
    return `Model "${parsed.data}" is not in the allowed list. Allowed models: ${suggestion}`;
  }

  await updateUserModelPreferences(userId, { model: parsed.data });
  return `Your preferred model is now: ${parsed.data}`;
}
