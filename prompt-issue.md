# System Prompt Audit — TODO

Status: **pending deployment validation**. Do not act on these items until
auto-recall (`7e5ad27`) has been in production for at least 1–2 weeks and
real usage data is available. See "Validation checklist" at the bottom.

## Context

AgentClaw's system prompt has grown through many iterative layers —
the initial Manboster template, three-tier security review, sandbox
routing, sub-agent management, memory rules, tool guidance, anti-prompt-
injection rules, and the P.2 readMemory nudge. Each layer was added to
fix a real failure mode, but no layer has ever been pruned. The result
is a prompt with known redundancy that is 20–30% longer than necessary.

This file lists the specific known-redundant spots. Pruning should
remove duplication, not cut information the agent actually needs —
Task Agent's context genuinely is larger than a chat assistant's
(security boundaries, sandbox routing, delegation, memory strategy).
The goal is "same coverage, fewer tokens", not "smaller prompt at any
cost".

## Known redundancy (4 items)

### 1. L0/L1/L2 described twice

The three trust tiers (L0 / L1 / L2) are explained in **two separate
sections**:

- The **permission-management** section (what each tier means for tool
  gating).
- The **security-review** section (how each tier maps to the gatekeeper
  pipeline).

A reader of the prompt sees the L0/L1/L2 definitions twice, with
slightly different framing each time. Decide on a single canonical
home and have the other section reference it ("see L0/L1/L2
definitions in <section>") rather than restating.

**Risk if removed wrongly**: model misroutes a tool call to the wrong
tier. Need deployment data to confirm the model isn't actively cross-
referencing both copies when making a routing decision.

### 2. Sandbox selection strategy duplicated

The rules for choosing between serverless sandbox, agentd LXC, and
which `permission_profile` to use appear:

- In the **system prompt** (a dedicated subsection of tool guidance).
- In the **description** of each sandbox-routing tool
  (`browser_*`, `execute_*`).

Either the prompt version is canonical and the tool descriptions
should be one-liners that reference it, or the tool descriptions are
canonical (each tool fully describes its own routing) and the prompt
section is removed.

**Risk if removed wrongly**: model routes to the wrong sandbox for a
task that needs login persistence or strong isolation. Need
deployment data on actual routing decisions to confirm which copy
the model is reading from.

### 3. Generic tool rules overlap with per-tool descriptions

The tool-guidance section has generic rules ("prefer the cheapest
tool that can do the job", "do not chain `web_search` + `fetch_url`
when one suffices", "use `task_progress` for transient state").
Several of these are restated nearly verbatim in individual tool
`description` fields.

The generic section is the right place for cross-tool policies. The
per-tool description should focus on what THIS tool does and when to
pick it over its siblings, not restate the generic policy.

**Risk if removed wrongly**: model loses a tie-breaking rule between
two similar tools. Low-severity — usually surfaces as a wasteful extra
tool call rather than a wrong answer.

### 4. P.2 readMemory nudge may be obsolete after auto-recall

The "many everyday requests implicitly depend on personal context"
paragraph was added in `a22e40e` to push the model toward calling
`readMemory(scope='long_term', query=...)` for queries like "weather
where I live". With auto-recall now landed (`7e5ad27`), the model
receives a `[Relevant Long-term Memories]` block at the start of
context for every turn — the memories are pushed, not pulled.

If auto-recall's hit rate is high enough, the P.2 nudge becomes
redundant noise. Worse, it's slightly contradictory: the prompt tells
the model both "memories are auto-injected, treat them as
authoritative, don't re-call readMemory" AND "call readMemory before
answering personal-context queries".

**Risk if removed wrongly**: auto-recall misses a relevant memory
(low top-K recall, embedding mismatch on cross-topic Chinese queries)
and the model has no fallback instruction to fall back to. This is
exactly why P.2 must NOT be removed until auto-recall's actual hit
rate is measured.

## What NOT to prune

These look tempting but are load-bearing — do not touch without
deployment evidence that the model is ignoring them:

- **Anti-prompt-injection rules**: verbose, but the only defense
  against adversarial user/tool content. The cost of one successful
  injection >> the token savings.
- **Sub-agent delegation policy**: looks like generic guidance but
  governs when the main agent spawns a sub-agent vs. does the work
  itself — wrong pruning here causes cost blowups or context bloat.
- **Per-tier tool gating tables**: the actual table of "L0 = these
  tools, L1 = these, L2 = these". Even if the tier *definitions* are
  duplicated, the *tables* are not — keep them.
- **The `task_progress` rule**: tiny but frequently violated by the
  model if absent — removing it regresses task-state tracking.

## Validation checklist (run before starting the audit)

Gather these signals over 1–2 weeks of production traffic:

- [ ] **auto-recall hit rate**: of the turns where the user message
  references personal context, what fraction has the relevant memory
  in the top-5 injected? (Look at `recallRelevantMemories` logs vs.
  user message content.) If < 70%, P.2 must stay.
- [ ] **readMemory call rate post-auto-recall**: did the model's
  voluntary `readMemory` calls drop after `7e5ad27`? If yes, the
  auto-injection is substituting for the prompt nudge — P.2 is a
  candidate for removal. If calls stayed flat, P.2 is still doing
  work.
- [ ] **routing decision patterns**: when the model picks a sandbox,
  does the prompt's sandbox section appear in the trace's "reasoning"
  or tool-call context? (May require spot-checks via DevTools / trace
  dumps — see `.agents/skills/ai-sdk/references/devtools.md`.)
- [ ] **tier-misrouting incidents**: any reports of the model gating
  a tool to the wrong L-tier? If yes, the duplicated L0/L1/L2
  description is doing load-bearing work — prune cautiously.

## Approach when ready to prune

1. **One commit per redundancy** — each of the 4 items above is a
   separate PR. Easier to revert if a regression surfaces.
2. **Keep the old version in a comment for one release cycle** —
   wrap deleted prompt blocks in `/* legacy: … */` or move to a
   `_prompt_archive.md` so the original wording is recoverable
   without `git archaeology`.
3. **Run a task regression suite** before merging each pruning
   commit. If no suite exists, do at least 3 hand-picked tasks that
   exercise the affected area (sandbox routing, personal-context
   recall, tier gating) and compare before/after outputs.
4. **Target 20–30% reduction** — not a hard cap, just the expected
   yield from removing the four listed redundancies. If pruning
   yields < 10% the audit probably missed something; if > 40% it
   probably cut load-bearing content.

## Related commits

- `4af1ecc` — lower minConfidence defaults (first hotfix for the
  "model doesn't know where I live" symptom; superseded by `135aac5`)
- `135aac5` — RRF normalisation (1/3 of the memory-system fix stack)
- `e6dbf94` — key-domain unification (2/3)
- `a22e40e` — P.2 readMemory nudge (candidate for removal pending
  auto-recall validation)
- `7e5ad27` — auto-recall top-K memories into context (3/3; the leg
  that makes P.2 potentially redundant)
