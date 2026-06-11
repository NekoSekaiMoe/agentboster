import { generateText } from 'ai';

import { resolveLanguageModel } from '@/lib/ai';
import { getConfig } from '@/lib/core/kv/config';
import { createLongTermMemory } from '@/lib/memory/long-term';
import { createLogger } from '@/lib/utils/logger';
import { z } from 'zod';

const logger = createLogger('api.agentd.task-memory');

const requestSchema = z.object({
  status: z.string(),
  result: z.string(),
  session_id: z.string().optional(),
  agent_id: z.string().optional(),
  command: z.string().optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: taskId } = await params;
    const body = await request.json();
    const parsed = requestSchema.safeParse(body);

    if (!parsed.success) {
      return Response.json({ error: 'Invalid request' }, { status: 400 });
    }

    const { result, command } = parsed.data;

    if (!result?.trim()) {
      return Response.json({ success: true, extracted: false });
    }

    const config = await getConfig();
    const modelId = config.models?.model;

    if (!modelId) {
      logger.warn('no model configured, skipping extraction');
      return Response.json({ success: true, extracted: false });
    }

    const prompt = `Extract key facts from this task result that should be saved to long-term memory.
Focus on: project configuration, user preferences, decisions made, important patterns.

Command: ${command || 'N/A'}

Result:
${result.slice(0, 4000)}

Output a JSON array of memory items. Each item should be a concise fact (1-3 sentences).
Format: ["fact 1", "fact 2", ...]

If nothing is worth saving, return an empty array.`;

    const model = resolveLanguageModel(modelId, config);
    const { text } = await generateText({ model, prompt });

    let facts: string[] = [];
    try {
      facts = JSON.parse(text.trim());
    } catch {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        facts = JSON.parse(match[0]);
      }
    }

    if (!Array.isArray(facts) || facts.length === 0) {
      return Response.json({ success: true, extracted: false });
    }

    for (const fact of facts.slice(0, 5)) {
      if (fact?.trim()) {
        await createLongTermMemory({
          content: fact.trim(),
          memoryType: 'fact',
          importance: 5,
          userId: 'agentd',
          config,
        });
      }
    }

    logger.info('memory extracted', { taskId, count: facts.length });
    return Response.json({
      success: true,
      extracted: true,
      count: facts.length,
    });
  } catch (error) {
    logger.error('memory extraction failed', { error });
    return Response.json({ error: 'Internal error' }, { status: 500 });
  }
}
