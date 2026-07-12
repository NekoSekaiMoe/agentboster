/**
 * constants — shared literals for the advisor extension.
 *
 * Kept in a leaf module so both the tool registration (index.ts) and the
 * command (command.ts) reference the same tool name without a circular import.
 */

export const ADVISOR_TOOL_NAME = 'advisor';
export const ADVISOR_TOOL_LABEL = 'Advisor';

/** One-line snippet for the Available tools section of the system prompt. */
export const ADVISOR_PROMPT_SNIPPET =
  'Escalate to a stronger reviewer model for guidance when stuck, before substantive work, or before declaring done';

/** Guideline bullets appended to the system prompt when the advisor tool is active. */
export const ADVISOR_PROMPT_GUIDELINES: string[] = [
  'Call `advisor` BEFORE substantive work — before writing, before committing to an interpretation, before building on an assumption. Orientation (finding files, reading a source, seeing what is there) is not substantive work; writing, editing, and declaring an answer are.',
  'Also call `advisor` when you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, save the result, commit the change.',
  'Also call `advisor` when stuck — errors recurring, approach not converging, results that do not fit — or when considering a change of approach.',
  "Give the advisor's advice serious weight, but if you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim, adapt.",
];
