import { z } from 'zod';

export const longTermMemoryIndexModeSchema = z.enum([
  'embedded',
  'keyword_only_no_model',
  'keyword_only_embedding_failed',
]);

export type LongTermMemoryIndexMode = z.infer<
  typeof longTermMemoryIndexModeSchema
>;

export const memoryTypeEnum = z.enum([
  'fact',
  'preference',
  'decision',
  'conversation',
]);

export type MemoryType = z.infer<typeof memoryTypeEnum>;

export const longTermMemoryIndexingSchema = z.object({
  mode: longTermMemoryIndexModeSchema,
  embeddingModel: z.string().nullable(),
  embeddingDimensions: z.number().int().nullable(),
  warning: z.string().nullable(),
});

export type LongTermMemoryIndexing = z.infer<
  typeof longTermMemoryIndexingSchema
>;

export const longTermMemoryRecordSchema = z.object({
  id: z.string().uuid(),
  content: z.string(),
  memoryType: memoryTypeEnum,
  importance: z.number().int().min(1).max(10),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type LongTermMemoryRecord = z.infer<typeof longTermMemoryRecordSchema>;

export const createLongTermMemorySchema = z.object({
  content: z.string().min(1, 'Memory content is required'),
  memoryType: memoryTypeEnum.optional().default('fact'),
  importance: z.number().int().min(1).max(10).optional().default(5),
});

export type CreateLongTermMemoryInput = z.infer<
  typeof createLongTermMemorySchema
>;

export const updateLongTermMemorySchema = z.object({
  content: z.string().min(1, 'Memory content is required'),
});

export type UpdateLongTermMemoryInput = z.infer<
  typeof updateLongTermMemorySchema
>;

export const longTermMemoryIdSchema = z.object({
  id: z.string().uuid(),
});

export const longTermMemoryListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export type LongTermMemoryListQuery = z.infer<
  typeof longTermMemoryListQuerySchema
>;

export const longTermMemorySearchQuerySchema = z.object({
  query: z.string().trim().min(1).optional(),
  minConfidence: z.coerce.number().min(0).max(1).default(0.05),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
});

export type LongTermMemorySearchQuery = z.infer<
  typeof longTermMemorySearchQuerySchema
>;
