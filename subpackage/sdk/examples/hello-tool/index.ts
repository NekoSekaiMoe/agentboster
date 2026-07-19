/**
 * Minimal agentboster extension — reference for the SDK.
 *
 * Demonstrates the three most common capabilities:
 *   1. registerTool — exposes a callable tool to the model
 *   2. registerCommand — adds a /hello slash command for the user
 *   3. on('session_start') — runs a side effect when a session begins
 *
 * Install: drop this directory into ~/.config/agentboster-cli/extensions/
 * (or ~/.pi/agent/extensions/) and start the agentboster CLI. The runtime
 * discovers it via jiti and calls the default export.
 */

import { Type } from 'typebox';
import type { ExtensionAPI } from '@agentboster/sdk';

export default function hello(pi: ExtensionAPI): void {
  // (1) Tool — the model can call this. Returns a text content block.
  pi.registerTool({
    name: 'hello',
    label: 'Hello',
    description: 'Say hello to someone. Pass `name` to personalize.',
    promptSnippet: 'Greet someone',
    promptGuidelines: [
      'Prefer the hello tool over hand-writing greetings so usage stays consistent.',
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: 'Who to greet' })),
    }),
    async execute(_toolCallId, params) {
      const name =
        typeof params.name === 'string' && params.name.trim()
          ? params.name.trim()
          : 'world';
      return {
        content: [{ type: 'text', text: `Hello, ${name}!` }],
      };
    },
  });

  // (2) Slash command — the user types /hello to configure the default.
  pi.registerCommand('hello', {
    description: 'Configure the hello tool default',
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const name = await ctx.ui.input('Default name for hello tool');
      if (name) {
        ctx.ui.notify(`Hello default set to "${name}"`, 'info');
      }
    },
  });

  // (3) Lifecycle hook — seed any per-session state here.
  pi.on('session_start', () => {
    // No-op in this example. Real extensions use this to warm caches,
    // register flags, set status, etc.
  });
}
