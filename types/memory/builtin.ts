import { z } from 'zod';

export const builtinMemoryKeySchema = z.enum([
  'AGENTS',
  'SOUL',
  'IDENTITY',
  'USER',
]);

export type BuiltinMemoryKey = z.infer<typeof builtinMemoryKeySchema>;

export const BUILTIN_MEMORY_KEYS = [
  'AGENTS',
  'SOUL',
  'IDENTITY',
  'USER',
] as const satisfies readonly BuiltinMemoryKey[];

export const BUILTIN_MEMORY_MAX_LENGTH = 300;

export const SOUL_MEMORY_MAX_LENGTH = 5000;

export const builtinMemorySectionSchema = z.object({
  key: builtinMemoryKeySchema,
  content: z.string(),
  updatedAt: z.string().nullable(),
});

export type BuiltinMemorySection = z.infer<typeof builtinMemorySectionSchema>;

export const updateBuiltinMemorySchema = z.object({
  key: builtinMemoryKeySchema,
  content: z
    .string()
    .min(1, 'Content is required')
    .max(
      SOUL_MEMORY_MAX_LENGTH,
      `Built-in memory content must be at most ${SOUL_MEMORY_MAX_LENGTH} characters`,
    ),
});

export type UpdateBuiltinMemoryInput = z.infer<
  typeof updateBuiltinMemorySchema
>;
