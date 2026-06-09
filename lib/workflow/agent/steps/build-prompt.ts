import { listSkillMetas } from '@/lib/core/kv/skills';
import {
  getBuiltinMemorySection,
  listBuiltinMemorySections,
} from '@/lib/memory';
import { listBuiltinMCPToolDescriptors } from '@/lib/workflow/agent/tools/mcp';
import type { AppConfig } from '@/types/config';
import { BUILTIN_MEMORY_MAX_LENGTH } from '@/types/memory';
import { DEFAULT_SYSTEM_PROMPT } from '../config';
import { MAIN_AGENT_NAME } from '../utils/agent-config';

export type BuildSystemPromptOptions = {
  agentName?: string;
  enableFollowUpSuggestions?: boolean;
  useConfiguredAgentPrompt?: boolean;
  delegation?: {
    parentAgentName: string;
  };
  sessionId?: string;
};

function createSection(title: string, lines: string[]) {
  return [`# \`${title}\``, ...lines].join('\n\n');
}

function createSubsection(title: string, lines: string[]) {
  return [`## \`${title}\``, ...lines].join('\n\n');
}

async function buildMCPSubsection(): Promise<string> {
  const descriptors = await listBuiltinMCPToolDescriptors('MCP');

  if (descriptors.length === 0) {
    return createSubsection('Builtin MCP Tools', [
      'No builtin MCP tools are currently available.',
    ]);
  }

  const lines: string[] = [
    'Use builtin MCP tools for live information, web content, documentation lookup, and repository operations.',
    'Use `web_search` for search and `fetch_url` for lightweight static page reads.',
    'Use browser tools when a page is JavaScript-rendered, requires interaction, needs a screenshot, or when you need DOM/network inspection.',
    'For browser workflows, call `browser_navigate` first, inspect with `browser_get_text`, `browser_get_html`, `browser_screenshot`, or `browser_get_network_requests`, interact with `browser_click` and `browser_type`, and call `browser_close` when finished.',
  ];

  const toolDescriptions: string[] = [];
  for (const d of descriptors) {
    const desc = d.description || d.toolName;
    toolDescriptions.push(`- \`${d.toolName}\`: ${desc}`);
  }
  lines.push(...toolDescriptions);

  lines.push(
    'When relevant builtin MCP tools are available, do not claim that you cannot access live information or browse the web.',
  );

  return createSubsection('Builtin MCP Tools', lines);
}

function buildFollowUpSection(enabled: boolean): string {
  if (!enabled) {
    return createSection('Follow-up Suggestions', [
      'Do not end answers with "你要是愿意", "If you want", or generated follow-up suggestion buttons/questions unless the user explicitly asks for suggestions.',
    ]);
  }

  return createSection('Follow-up Suggestions', [
    'After fully answering the user, append a short follow-up suggestion block at the very end of your final assistant answer.',
    'Use exactly this format:',
    '',
    '你要是愿意，我还可以继续帮你：',
    '- <a concise follow-up question or next action>',
    '- <a concise follow-up question or next action>',
    '- <a concise follow-up question or next action>',
    '',
    'The three items must be useful continuations for the just-finished answer. Keep each item short enough to fit on a button.',
    'Do not add more text after this block.',
  ]);
}

export async function buildSystemPrompt(
  config: AppConfig,
  options: BuildSystemPromptOptions = {},
): Promise<string> {
  'use step';

  const agentName = options.agentName ?? MAIN_AGENT_NAME;
  const agentConfig = config.agents?.[agentName];
  const customPrompt = agentConfig?.system_prompt?.trim();
  const shouldUseConfiguredPrompt = options.useConfiguredAgentPrompt ?? true;
  const resolvedPrompt =
    shouldUseConfiguredPrompt && customPrompt
      ? customPrompt
      : DEFAULT_SYSTEM_PROMPT;

  const builtinSectionsList = await listBuiltinMemorySections();
  const skills = await listSkillMetas();

  // Check for session-level SOUL override
  const _sessionSoulContent: string | null = null;
  if (options.sessionId) {
    try {
      const _sessionSoul = await getBuiltinMemorySection('SOUL');
      // Session SOUL is stored in the session itself; we check if it differs from global
      // For now, the SOUL section in builtin memories is the source of truth
      // Session-level override is handled by the caller passing sessionId
    } catch {
      // ignore
    }
  }

  const builtinMemorySections = builtinSectionsList.map((section) =>
    createSection(section.key.toUpperCase(), [
      section.content.trim().length > 0
        ? section.content
        : "You haven't added that section yet. Try updating `Build-in Memory` to add it.",
    ]),
  );

  const sections = [
    ...builtinMemorySections,

    createSection('Agent Identity', [
      `${options.delegation ? 'You are a Sub-agent' : 'Agent'}: ${agentName}`,
      resolvedPrompt,
    ]),
  ];

  if (options.delegation) {
    sections.push(
      createSection('Delegation Mode', [
        `You are acting as a delegated \`sub-agent\` for \`${options.delegation.parentAgentName}\`.`,
        'Focus on the delegated task only.',
        'Return a concise work product for the calling agent instead of addressing the end user directly, unless the delegated task explicitly asks for user-facing copy.',
      ]),
    );
  }

  const skillsList = skills.map(
    (skill) => `- \`${skill.name}\`: ${skill.description}`,
  );

  const mcpSubsection = await buildMCPSubsection();
  const enableFollowUpSuggestions =
    !options.delegation && options.enableFollowUpSuggestions === true;

  const summarySection = createSection('Tool', [
    createSubsection('Runtime', [
      `You are running on \`Vercel\`, a \`serverless\` platform, the current time is: \`${new Date().toISOString()}\`.`,
    ]),

    createSubsection('Memory Rules', [
      `If a user asks about your preferences, traits, or memories, use the \`memory\` function to retrieve your previous memories.`,
      `Memories fall into three categories: \`built-in memories\`, \`long-term memories\`, and \`session memories\`.`,

      `Built-in memories determine your language style and characteristics. These memories are preloaded and only require \`tool\` invocation when modified. Built-in memories have only a few categories. They should be concise, not exceeding \`${BUILTIN_MEMORY_MAX_LENGTH} words\`.`,
      `Long-term memories are things you learn from previous conversations, such as user preferences. When asked about preferences, you must call the \`memory\` tool to read long-term memories. When asking, editing or deleting for a user's preference, you should first search for any relevant memories. If none exist, then create a new one.`,
      `Session memories are things you learn during the current conversation. These memories are only valid within the current session. When performing a longer task, you need to read session memories. This prevents you from forgetting important details.`,
    ]),

    createSubsection('Long-Running Task Management', [
      `You are executing a task that may span multiple sessions over days or weeks.`,
      `Your task summary is your only memory of what happened before this session.`,
      `Call \`task_summary\` at the start of each session to understand where you left off. Do not rely on conversation history alone; your summary is authoritative.`,
      `Call \`task_progress\` whenever you make a significant decision, complete a milestone, encounter a blocker, or discover or resolve a known issue.`,
      `When recording a decision, include what you chose, why you chose it, and what alternatives you considered and rejected.`,
      `Individual memory entries are for cross-task reference; the task summary is for continuing the same task.`,
    ]),

    createSubsection('Sandbox', [
      `When executing commands, reading, or writing files, you operate within a \`Vercel Sandbox\` container. The Sandbox is a complete \`Linux\` environment (\`Amazon Linux 2023\`), default supporting \`Node.js\` applications.`,
      `The container for the current conversation is destroyed upon dialogue conclusion. It also has a time limit, so only perform small tasks, ideally not exceeding \`40 minutes\`.`,
      `If you have created new files in your workspace, please ensure you use \`sandbox.downloadFile\` tool once you are finished. This is to ensure your work is persistent before the sandbox is destroyed. For multiple files, you need to compress them into a zip archive.`,
      `When users ask to access a running sandbox service from outside, use the \`sandbox.openPort\` tool to resolve the public URL for an exposed port.`,
      `After \`sandbox.downloadFile\` returns a URL, you must include an explicit Markdown download link in your final response.`,
    ]),

    createSubsection('Skills', [
      `Use skill tools to read or write skills. When inquiring about technical or professional knowledge, you have skills you should first read.`,
      `If you've learned new knowledge or encountered an error somewhere but eventually resolved it, please add these to your skills.`,
      `All available skills are listed below:`,

      skillsList.join('\n'),
    ]),

    mcpSubsection,
  ]);

  sections.push(summarySection);
  sections.push(buildFollowUpSection(enableFollowUpSuggestions));

  return sections.join('\n\n');
}
