/**
 * extra-cmd — built-in extension ported from @NekoSekaiMoe/pi-extra-cmd.
 *
 * Registers the /init and /context commands:
 *
 *   /init [extra instructions]   Generate an AGENTS.md contributor guide for
 *                               the current repository. Command-driven (injects
 *                               the generation instructions as a user message)
 *                               so it always triggers a turn, unlike the
 *                               skill-based flow which relies on the model
 *                               discovering a skill.
 *   /context                    Show context-window usage plus a per-category
 *                               token composition breakdown. The report is
 *                               persisted as a display-only custom session
 *                               entry (never enters LLM context) and rendered
 *                               via registerEntryRenderer.
 *
 * /exit is NOT ported: this fork already ships /exit and /quit as built-in
 * slash commands.
 */

import type { ExtensionAPI } from '../../core/extensions/index.ts';
import { registerContextCommand } from './context.ts';
import { registerInitCommand } from './init.ts';

export default function extraCmd(pi: ExtensionAPI): void {
  registerInitCommand(pi);
  registerContextCommand(pi);
}
