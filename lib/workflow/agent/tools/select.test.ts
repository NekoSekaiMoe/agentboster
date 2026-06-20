import { describe, it, expect } from 'vitest';
import { selectToolsForInput, extractLatestUserText } from './select';

const ALL_TOOLS = new Set([
  'readMemory',
  'writeMemory',
  'deleteMemory',
  'listSkills',
  'getSkill',
  'getSkillFile',
  'getSkillEntrypoint',
  'importSkillRepo',
  'importSkillFromClawHub',
  'upsertSkill',
  'updateSkillFile',
  'deleteSkill',
  'task_summary',
  'task_progress',
  'dailyTask',
  'delayTask',
  'exec',
  'readFile',
  'writeFile',
  'openPort',
  'downloadFile',
  'subAgent',
  'listNodes',
  'getBestNode',
]);

const MCP_TOOLS = new Set(['web_search', 'browser_navigate', 'browser_click']);

describe('selectToolsForInput', () => {
  describe("strategy 'all'", () => {
    it('returns every available tool regardless of input', () => {
      const result = selectToolsForInput({
        userInput: 'hi',
        steps: [],
        availableTools: ALL_TOOLS,
        strategy: 'all',
      });
      expect(new Set(result)).toEqual(ALL_TOOLS);
    });
  });

  describe("strategy 'dynamic' — base set", () => {
    it('returns the base set for a plain greeting', () => {
      const result = selectToolsForInput({
        userInput: 'hello',
        steps: [],
        availableTools: ALL_TOOLS,
      });
      const set = new Set(result);
      // base set always present
      for (const name of [
        'readMemory',
        'writeMemory',
        'listSkills',
        'getSkill',
        'task_summary',
        'dailyTask',
      ]) {
        expect(set.has(name)).toBe(true);
      }
      // sandbox / subAgent / nodes NOT included
      expect(set.has('exec')).toBe(false);
      expect(set.has('subAgent')).toBe(false);
      expect(set.has('listNodes')).toBe(false);
    });

    it('includes the base set even when input is empty', () => {
      const result = selectToolsForInput({
        userInput: '',
        steps: [],
        availableTools: ALL_TOOLS,
      });
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain('readMemory');
    });
  });

  describe("strategy 'dynamic' — keyword routing", () => {
    it('adds sandbox tools when input mentions "run a script"', () => {
      const result = selectToolsForInput({
        userInput: 'please run this script for me',
        steps: [],
        availableTools: ALL_TOOLS,
      });
      const set = new Set(result);
      expect(set.has('exec')).toBe(true);
      expect(set.has('readFile')).toBe(true);
      expect(set.has('writeFile')).toBe(true);
    });

    it('adds sandbox tools for Chinese 命令', () => {
      const result = selectToolsForInput({
        userInput: '帮我执行这个命令',
        steps: [],
        availableTools: ALL_TOOLS,
      });
      expect(new Set(result).has('exec')).toBe(true);
    });

    it('adds subAgent when input mentions delegation', () => {
      const result = selectToolsForInput({
        userInput: 'delegate this to a sub-agent',
        steps: [],
        availableTools: ALL_TOOLS,
      });
      expect(new Set(result).has('subAgent')).toBe(true);
    });

    it('adds MCP browser tools when input mentions browsing', () => {
      const result = selectToolsForInput({
        userInput: 'open this website and click the button',
        steps: [],
        availableTools: new Set([...ALL_TOOLS, ...MCP_TOOLS]),
        mcpTools: MCP_TOOLS,
      });
      const set = new Set(result);
      expect(set.has('browser_navigate')).toBe(true);
      expect(set.has('web_search')).toBe(true);
    });

    it('does NOT add MCP tools when input does not mention browsing', () => {
      const result = selectToolsForInput({
        userInput: 'just a chat message',
        steps: [],
        availableTools: new Set([...ALL_TOOLS, ...MCP_TOOLS]),
        mcpTools: MCP_TOOLS,
      });
      const set = new Set(result);
      expect(set.has('browser_navigate')).toBe(false);
    });
  });

  describe("strategy 'dynamic' — long input fallback", () => {
    it('falls back to full toolset for long inputs', () => {
      const longInput = 'a'.repeat(600);
      const result = selectToolsForInput({
        userInput: longInput,
        steps: [],
        availableTools: ALL_TOOLS,
      });
      expect(new Set(result)).toEqual(ALL_TOOLS);
    });

    it('falls back to full toolset when input contains a code fence', () => {
      const input = 'fix this:\n```ts\nconst x = 1;\n```';
      const result = selectToolsForInput({
        userInput: input,
        steps: [],
        availableTools: ALL_TOOLS,
      });
      expect(new Set(result)).toEqual(ALL_TOOLS);
    });

    it('does NOT fall back for inputs just under threshold', () => {
      const input = 'a'.repeat(499);
      const result = selectToolsForInput({
        userInput: input,
        steps: [],
        availableTools: ALL_TOOLS,
      });
      // No sandbox keywords in 'aaaa...', so sandbox tools absent
      expect(new Set(result).has('exec')).toBe(false);
    });
  });

  describe("strategy 'dynamic' — historical dependency", () => {
    it('keeps tools that were called in previous steps', () => {
      const result = selectToolsForInput({
        userInput: 'thanks',
        steps: [
          {
            toolCalls: [{ toolName: 'exec' }],
            toolResults: [{ toolName: 'exec' }],
          },
        ],
        availableTools: ALL_TOOLS,
      });
      expect(new Set(result).has('exec')).toBe(true);
    });

    it('keeps tools from toolResults even if not in toolCalls', () => {
      const result = selectToolsForInput({
        userInput: 'thanks',
        steps: [
          {
            toolResults: [{ toolName: 'subAgent' }],
          },
        ],
        availableTools: ALL_TOOLS,
      });
      expect(new Set(result).has('subAgent')).toBe(true);
    });
  });

  describe('intersection with availableTools', () => {
    it('never returns a tool that is not registered', () => {
      const partial = new Set([
        'readMemory',
        'writeMemory',
        'exec',
        // 'subAgent' is NOT in this agent's availableTools
      ]);
      const result = selectToolsForInput({
        userInput: 'delegate this',
        steps: [],
        availableTools: partial,
      });
      expect(new Set(result).has('subAgent')).toBe(false);
      expect(result).toContain('readMemory');
    });
  });
});

describe('extractLatestUserText', () => {
  it('returns the last user-role string content', () => {
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'second' },
    ];
    expect(extractLatestUserText(msgs)).toBe('second');
  });

  it('concatenates text parts when content is an array', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello ' },
          { type: 'image', url: 'ignored' },
          { type: 'text', text: 'world' },
        ],
      },
    ];
    expect(extractLatestUserText(msgs)).toBe('hello world');
  });

  it('returns empty string when no user message exists', () => {
    expect(
      extractLatestUserText([
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: 'hi' },
      ]),
    ).toBe('');
  });

  it('skips older user messages and returns the latest', () => {
    const msgs = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'new' },
    ];
    expect(extractLatestUserText(msgs)).toBe('new');
  });
});
