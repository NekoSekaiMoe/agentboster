import { z } from 'zod';

import { getConfig, patchConfig } from '@/lib/core/kv/config';
import type { AppConfig } from '@/types/config';
import { aiConfigSchema, aiModelConfigSchema } from '@/types/config/ai';
import {
  autonomyConfigSchema,
  autonomyLevelEnum,
} from '@/types/config/autonomy';
import { sandboxConfigSchema, sandboxTypeEnum } from '@/types/config/sandbox';

interface ConfigPathDef {
  schema: z.ZodType<unknown>;
  patch: (value: unknown, current: AppConfig) => Partial<AppConfig>;
  display: (config: AppConfig) => string;
}

const CONFIG_PATHS: Record<string, ConfigPathDef> = {
  'sandbox.default': {
    schema: sandboxTypeEnum,
    patch: (value, current) => ({
      sandbox: sandboxConfigSchema.parse({
        ...current.sandbox,
        defaultType: value,
      }),
    }),
    display: (c) => c.sandbox?.defaultType ?? 'tmpfs',
  },
  'autonomy.level': {
    schema: autonomyLevelEnum,
    patch: (value, current) => ({
      autonomy: autonomyConfigSchema.parse({
        ...current.autonomy,
        level: value,
      }),
    }),
    display: (c) => c.autonomy?.level ?? 'supervised',
  },
  'autonomy.max_steps': {
    schema: z.coerce.number().int().min(1).max(100),
    patch: (value, current) => ({
      autonomy: autonomyConfigSchema.parse({
        ...current.autonomy,
        max_steps: value,
      }),
    }),
    display: (c) => String(c.autonomy?.max_steps ?? 20),
  },
  'models.temperature': {
    schema: z.coerce.number().min(0).max(2),
    patch: (value, current) => ({
      models: aiConfigSchema.parse({
        ...current.models,
        temperature: value,
      }),
    }),
    display: (c) => String(c.models?.temperature ?? 0.7),
  },
  'models.model': {
    schema: aiModelConfigSchema,
    patch: (value, current) => ({
      models: aiConfigSchema.parse({
        ...current.models,
        model: value,
      }),
    }),
    display: (c) => c.models?.model ?? 'not set',
  },
};

function listAvailablePaths(): string {
  return Object.keys(CONFIG_PATHS)
    .map((p) => `  ${p}`)
    .join('\n');
}

export async function executeConfigCommand(args: string): Promise<string> {
  const trimmed = args.trim();

  if (!trimmed) {
    const config = await getConfig();
    const lines = Object.entries(CONFIG_PATHS).map(([path, def]) => {
      return `${path} = ${def.display(config)}`;
    });
    return `Config (whitelist):\n${lines.join('\n')}\n\nUse /config <path> <value> to set.`;
  }

  const parts = trimmed.split(/\s+/);
  const path = parts[0];

  const def = CONFIG_PATHS[path];
  if (!def) {
    return `Unknown config path: ${path}\nAvailable paths:\n${listAvailablePaths()}`;
  }

  if (parts.length === 1) {
    const config = await getConfig();
    return `${path} = ${def.display(config)}`;
  }

  const rawValue = parts.slice(1).join(' ');
  const parsed = def.schema.safeParse(rawValue);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => i.message).join('; ');
    return `Invalid value for ${path}: ${issues}`;
  }

  const current = await getConfig();
  await patchConfig({
    ...current,
    ...def.patch(parsed.data, current),
  });

  return `${path} updated to: ${parsed.data}`;
}
