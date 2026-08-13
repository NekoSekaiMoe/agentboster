import { enUS } from './en-US';

export const enGB = {
  ...enUS,
  'appearance.language.description':
    'Choose the language used by navigation, settings and shared controls.',
  'config.sections.appearance.description':
    'Customise navigation style and display preferences.',
  'config.sections.models.description':
    'Set default models, provider endpoints and token limits.',
  'workspace.label': 'Workspace',
  'workspace.switch': 'Switch workspace',
  'workspace.createNew': 'New workspace',
  'workspace.defaultName': 'New workspace',
  'workspace.createSuccess': 'Workspace created',
  'workspace.createError': 'Failed to create workspace',
  'workspace.defaultWorkspaceName': 'Default workspace',
  'skill.approval.importSkillRepo':
    'The model requests to import skills from the Git repository: {gitURL}. Allow?',
  'skill.approval.importSkillFromClawHub':
    'The model requests to import the skill {slug} (version {version}) from ClawHub. Allow?',
  'skill.approval.upsertSkill':
    'The model requests to create/update the skill {name} ({fileCount} files: {fileList}). Allow?',
  'skill.approval.updateSkillFile':
    'The model requests to modify the skill file {name}/{filePath} (new content: {contentLength} characters). Allow?',
  'skill.approval.deleteSkill':
    'The model requests to delete the skill {name} (including all its files and metadata). Allow?',
  'skill.approval.timeout':
    'The approval request received no response within {hours} hours and was treated as rejected.',
  'cmd.goal.noGoal': 'No goal set. Use `/goal set <text>` to define one.',
  'cmd.goal.statusGoal': '**Goal:** {goal}',
  'cmd.goal.statusHidden': 'Hidden continuations: {count} / {max}',
  'cmd.goal.statusNonProgress':
    'Consecutive identical non-progress: {count} / {max}',
  'cmd.goal.statusEval': 'Last evaluation: {reason}',
  'cmd.goal.usageSet': 'Usage: /goal set <text>',
  'cmd.goal.setRunActive':
    'Cannot set a goal while a run is active. Wait for it to finish or /stop it first.',
  'cmd.goal.tooLong': 'Goal is too long ({length} > {max} chars).',
  'cmd.goal.setOk':
    "Goal set. The agent will self-drive toward it until it's met or the breaker trips.\n\n{text}",
  'cmd.goal.clearRunActive':
    'Cannot clear the goal while a run is active. Wait for it to finish or /stop it first.',
  'cmd.goal.clearOk': 'Goal cleared. The agent will no longer self-drive.',
  'cmd.goal.usage': 'Usage: /goal set <text> | /goal clear | /goal',
} satisfies Record<keyof typeof enUS, string>;
