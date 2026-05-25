import { patchConfig } from '@/lib/core/kv/config';
import { aiModelConfigSchema } from '@/types/config/ai';

export async function executeModelCommand(args: string): Promise<string> {
  const trimmed = args.trim();

  if (!trimmed) {
    const { getConfig } = await import('@/lib/core/kv/config');
    const config = await getConfig();
    const model = config.models?.model ?? 'not set';
    const temperature = config.models?.temperature ?? 0.7;
    const contextLimit = config.models?.context_limit ?? 'unset';
    const maxOutput = config.models?.max_output_tokens ?? 'unset';
    return [
      `Current model: ${model}`,
      `Temperature: ${temperature}`,
      `Context limit: ${contextLimit}`,
      `Max output tokens: ${maxOutput}`,
    ].join('\n');
  }

  const parsed = aiModelConfigSchema.safeParse(trimmed);
  if (!parsed.success) {
    return 'Invalid model format. Use: /model provider/model-id (e.g. /model anthropic/claude-sonnet-4-20250514)';
  }

  const { getConfig } = await import('@/lib/core/kv/config');
  const current = await getConfig();
  await patchConfig({
    models: {
      ...current.models,
      model: parsed.data,
    },
  });

  return `Model updated to: ${parsed.data}`;
}
