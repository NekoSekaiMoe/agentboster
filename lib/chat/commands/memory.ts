import { listBuiltinMemorySections } from '@/lib/memory/builtin';
import {
  createLongTermMemory,
  searchLongTermMemories,
} from '@/lib/memory/long-term';
import type { HybridSearchRow } from '@/lib/memory/search';

function formatBuiltinSections(
  sections: Awaited<ReturnType<typeof listBuiltinMemorySections>>,
): string {
  const lines = sections
    .filter((s) => s.content.trim().length > 0)
    .map((s) => `- **${s.key}**: ${s.content}`);
  if (lines.length === 0) return 'No builtin memories set.';
  return lines.join('\n');
}

function formatSearchResults(results: HybridSearchRow[]): string {
  if (results.length === 0) return 'No results found.';
  return results
    .slice(0, 5)
    .map(
      (r, i) =>
        `${i + 1}. [${(r.finalScore * 100).toFixed(0)}%] ${r.content.slice(0, 120)}`,
    )
    .join('\n');
}

export async function executeMemoryCommand(args: string): Promise<string> {
  const trimmed = args.trim();

  if (!trimmed) {
    return 'Usage: /memory <query> | /memory builtin | /memory search <query> | /memory add <text>';
  }

  const [sub, ...rest] = trimmed.split(/\s+/);
  const restText = rest.join(' ').trim();

  switch (sub) {
    case 'builtin': {
      const sections = await listBuiltinMemorySections();
      return `**Builtin Memories:**\n${formatBuiltinSections(sections)}`;
    }

    case 'add': {
      if (!restText) return 'Usage: /memory add <text>';
      const result = await createLongTermMemory({ content: restText });
      return `Memory created (id: ${result.memory.id.slice(0, 8)}…)`;
    }

    case 'search': {
      if (!restText) return 'Usage: /memory search <query>';
      const results = await searchLongTermMemories({
        query: restText,
        minConfidence: 0.05,
        pageSize: 5,
      });
      return `**Search results:**\n${formatSearchResults(results)}`;
    }

    default: {
      const query = trimmed;
      const [sections, results] = await Promise.all([
        listBuiltinMemorySections(),
        searchLongTermMemories({ query, minConfidence: 0.05, pageSize: 5 }),
      ]);

      const builtinMatch = sections
        .filter(
          (s) =>
            s.content.toLowerCase().includes(query.toLowerCase()) ||
            query.toLowerCase().includes(s.key.toLowerCase()),
        )
        .map((s) => `- **${s.key}**: ${s.content}`)
        .join('\n');

      const output: string[] = [];
      if (builtinMatch) output.push(`**Builtin:**\n${builtinMatch}`);
      if (results.length > 0)
        output.push(`**Long-term:**\n${formatSearchResults(results)}`);
      if (output.length === 0)
        return 'No memories found. Use /memory add <text> to create one.';

      return output.join('\n\n');
    }
  }
}
