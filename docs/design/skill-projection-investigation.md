# Skill Projection into the Sandbox — Already On-Demand (#19)

> Status: investigated; agentboster's architecture already does the right thing. No code change needed.

## What deer-flow does

deer-flow projects skills into the sandbox filesystem (`/mnt/skills/{public,custom,integrations}`) as an **enabled-only view** that updates whenever a skill is toggled/edited/installed/deleted. The concern it addresses: a sandbox that gets the WHOLE skills directory dumped into it (so `bash`/file tools can read disabled or other-tenant skills).

deer-flow's `skills/projection.py` builds the overlay; managed integration packs stay shared, but their VISIBILITY follows per-user enabled state.

## What agentboster does — already correct

agentboster's materialization path (`lib/workflow/agent/tools/skills/local.ts` → `materializeAndRunOnAgentd`) is **on-demand per invoked skill**, not a full-directory dump:

1. `runSkill` is called with ONE `skillName`.
2. `materializeAndRunOnAgentd` → `listSkillFilesWithContentFromBlob(skillName)` reads ONLY that skill's files from blob.
3. Those files (and only those) are written to the sandbox, the entrypoint runs, and the result streams back.

So by construction, the sandbox sees only the skill the agent explicitly invoked — never disabled skills, never other tenants' skills. The "enabled-only overlay" semantic is already enforced at the blob-read boundary, not at a filesystem-projection boundary.

The daemon side confirms this: `subpackage/agentd/internal/sandbox/skills.go:DiscoverSkills` enumerates `workspace/skills/` for DISCOVERY (the listing shown to the model), but execution still goes through the per-invocation write path, and `isSafeRelativeSkillPath` guards the clawhub entrypoint against path traversal.

## When this would need to change

The current design is correct as long as:
- The blob store is the single source of truth for skill files (it is — `syncSkillFilesToBlob` / `persistManualSkillToBlob` are the only write paths, and both now run the Phase-1 security scan from #12).
- Skills are invoked individually by name (they are — `runSkill` is per-name).
- Multi-tenant isolation is at the blob-read layer (it is — a skill is only readable by a tenant whose KV index lists it as active).

It would need to change IF agentboster ever:
- Materialized the whole skills directory into a long-lived LXC container (today the container is workspace-scoped and skills are written per-invocation into `workspace/skills/`).
- Added a per-user "enabled skill set" product concept that must hide disabled skills from the model's discovery listing (today `DiscoverSkills` lists whatever is on disk in the workspace — there's no per-user enabled/disabled product concept; if one is added, the filter belongs in the discovery listing the model sees, not in the materialize path).

## Conclusion

No action. The architecture pre-empts deer-flow's concern by materializing per-invocation rather than projecting a directory. This document records the investigation so the question doesn't get re-asked, and pins the invariant (blob is the source of truth; materialize is per-skill) so a future change that breaks it is flagged at review.
