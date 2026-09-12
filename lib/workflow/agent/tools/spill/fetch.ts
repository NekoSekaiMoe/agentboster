/**
 * fetch_spilled_output — model-facing retrieval tool for spilled results.
 *
 * Registers under built-in tool id `spill` (enabled by default, no required
 * config) so the locator in every spill note always resolves. Output is
 * bounded by SPILL_FETCH_MAX_LENGTH so the tool can never trigger another
 * spill.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { defineBuildInTool } from '../define';
import { DEFAULT_SPILL_PREVIEW_CHARS, clampFetchWindow } from './core';
import { getSpill } from './store';

export default defineBuildInTool({
  id: 'spill',
  description:
    'Page through oversized tool outputs that were spilled to storage. ' +
    'When a tool result is too large for the conversation context, it is ' +
    'replaced by a preview plus a spill id — this tool retrieves the full ' +
    'text in bounded pages.',
  factory: async () => {
    return {
      fetch_spilled_output: tool({
        title: 'Fetch spilled tool output',
        description:
          'Retrieve a page of a previously spilled tool output. Args: ' +
          '`spillId` from the spill note, `offset` (default 0), `length` ' +
          `(default ${DEFAULT_SPILL_PREVIEW_CHARS}, max 20000). ` +
          'Entries expire about a week after creation.',
        inputSchema: z.object({
          spillId: z
            .string()
            .min(1)
            .describe('The spill id from the spill note.'),
          offset: z
            .number()
            .int()
            .min(0)
            .default(0)
            .describe('Character offset to start reading from.'),
          length: z
            .number()
            .int()
            .min(1)
            .max(20_000)
            .default(DEFAULT_SPILL_PREVIEW_CHARS)
            .describe('How many characters to return (max 20000).'),
        }),
        execute: async (input) => {
          // Dynamic import: KV helpers must not be static workflow-bundle deps.
          const record = await getSpill(input.spillId);
          if (!record) {
            return {
              ok: false,
              error:
                `No stored output for spill id "${input.spillId}". ` +
                'It may have expired (about a week) or was never created.',
            };
          }

          const totalChars = record.text.length;
          const { offset, length } = clampFetchWindow({
            offset: input.offset,
            length: input.length,
            totalChars,
          });
          const text = record.text.slice(offset, offset + length);
          return {
            ok: true,
            spillId: input.spillId,
            offset,
            length: text.length,
            totalChars,
            hasMore: offset + text.length < totalChars,
            text,
          };
        },
      }),
    };
  },
});
