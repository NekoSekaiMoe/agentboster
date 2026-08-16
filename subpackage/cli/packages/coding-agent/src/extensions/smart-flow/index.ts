/**
 * smart-flow — built-in extension ported from @NekoSekaiMoe/pi-smart-flow.
 *
 * A lightweight delegation-experience layer:
 *
 * - bash-bg.ts   adaptive foreground/background shell with job control
 * - observe.ts   blocking status/wait/watch over observation providers
 *
 * compact-thinking is NOT ported yet: it depends on pi-ai's completeSimple(),
 * which is a throwing stub in this fork (all LLM traffic routes through the
 * Web backend). It will be ported once a one-shot completion channel exists.
 *
 * The delegation nudge activates only when the `subagent` tool (the
 * npm-installed @narumitw/pi-subagents extension) is registered and active.
 *
 * Attribution: bash-bg/observation/observe/quiet-render are ported from
 * pi-maestro-flow (MIT, Copyright (c) 2026 catlog22).
 */

import type { ExtensionAPI } from '../../core/extensions/index.ts';
import { registerBashBg } from './bash-bg.ts';
import { registerDelegationNudge } from './nudge.ts';
import { registerObserve } from './observe.ts';

export default function smartFlow(pi: ExtensionAPI): void {
  registerBashBg(pi);
  registerObserve(pi);
  registerDelegationNudge(pi);
}
