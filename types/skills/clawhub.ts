import { z } from 'zod';

export const clawhubManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string(),
  description: z.string(),
  author: z.string().optional(),
  entrypoint: z.string().default('SKILL.md'),
  scripts: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  compatibility: z
    .object({
      clawless: z.string().optional(),
      clawhub: z.string().optional(),
    })
    .optional(),
});

export type ClawHubManifest = z.infer<typeof clawhubManifestSchema>;

export const SUPPORTED_IMAGE_FORMATS = [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
] as const;

export const imageAnalyzeInputSchema = z.object({
  image_path: z
    .string()
    .min(1)
    .describe('Absolute path to the image file in the sandbox'),
  prompt: z.string().optional().describe('Specific question about the image'),
  max_tokens: z.number().int().min(1).max(4096).optional().default(1024),
});

export const imageAnalyzeOutputSchema = z.object({
  description: z.string().describe('Text description of the image'),
  confidence: z.number().min(0).max(1).optional(),
});

export type ImageAnalyzeInput = z.infer<typeof imageAnalyzeInputSchema>;
export type ImageAnalyzeOutput = z.infer<typeof imageAnalyzeOutputSchema>;
