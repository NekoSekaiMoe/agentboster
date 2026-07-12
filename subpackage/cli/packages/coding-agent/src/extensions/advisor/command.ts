/**
 * command — the `/advisor` slash command.
 *
 * Configures which model the advisor tool escalates to. The flow is:
 *   1. pick a model from the models the web backend exposes (or "No advisor"),
 *   2. infer the wire protocol (api) from the model's provider,
 *   3. pick an effort level for reasoning-capable providers,
 *   4. resolve an API key (env var default, else prompt),
 *   5. persist + apply.
 *
 * Persist happens BEFORE mutating in-memory state so a write failure can't
 * strand "configured in memory, nothing on disk".
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '../../core/extensions/index.ts';
import {
  type AdvisorApi,
  type AdvisorConfig,
  loadAdvisorConfig,
  resolveApiKey,
  saveAdvisorConfig,
} from './config.ts';
import { ADVISOR_TOOL_NAME } from './constants.ts';
import { applyAdvisorConfig, clearAdvisorState } from './state.ts';

const NO_ADVISOR = '— No advisor —';
const EFFORT_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh'];

/** Guess the wire protocol from a provider id. Anthropic → messages, else OpenAI-compatible. */
function inferApi(provider: string): AdvisorApi {
  return provider.toLowerCase().includes('anthropic')
    ? 'anthropic-messages'
    : 'openai-completions';
}

/** Default env var name to look up for a provider's key. */
function defaultKeyEnv(provider: string): string {
  return provider.toLowerCase().includes('anthropic')
    ? 'ANTHROPIC_API_KEY'
    : 'OPENAI_API_KEY';
}

function ensureAdvisorToolActive(pi: ExtensionAPI, active: boolean): void {
  const tools = pi.getActiveTools();
  const has = tools.includes(ADVISOR_TOOL_NAME);
  if (active && !has) {
    pi.setActiveTools([...tools, ADVISOR_TOOL_NAME]);
  } else if (!active && has) {
    pi.setActiveTools(tools.filter((n) => n !== ADVISOR_TOOL_NAME));
  }
}

export function registerAdvisorCommand(pi: ExtensionAPI): void {
  pi.registerCommand('advisor', {
    description: 'Configure the advisor model the agent can escalate to',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(
          'The /advisor command requires interactive mode.',
          'error',
        );
        return;
      }

      const available = ctx.modelRegistry.getAvailable();
      const modelLabels = available.map((m) => `${m.name} (${m.provider})`);
      const choice = await ctx.ui.select('Advisor model', [
        ...modelLabels,
        NO_ADVISOR,
      ]);
      if (choice === undefined) return;

      if (choice === NO_ADVISOR) {
        if (!saveAdvisorConfig({})) {
          ctx.ui.notify('Failed to save advisor config.', 'error');
          return;
        }
        clearAdvisorState();
        ensureAdvisorToolActive(pi, false);
        ctx.ui.notify('Advisor disabled.', 'info');
        return;
      }

      const picked = available[modelLabels.indexOf(choice)];
      if (!picked) {
        ctx.ui.notify('Model not found.', 'error');
        return;
      }

      const api = inferApi(picked.provider);

      let effort: string | undefined;
      if (picked.reasoning) {
        const effortChoice = await ctx.ui.select(
          'Advisor effort',
          EFFORT_LEVELS,
        );
        if (effortChoice === undefined) return;
        effort = effortChoice === 'off' ? undefined : effortChoice;
      }

      // API key: default to the provider's standard env var if it's set,
      // otherwise prompt. Store the "$ENV_VAR" spec (not the secret) when the
      // env var is present so the key never lands on disk.
      const envName = defaultKeyEnv(picked.provider);
      const prior = loadAdvisorConfig();
      let apiKeySpec = prior.apiKey;
      if (process.env[envName]) {
        apiKeySpec = `$${envName}`;
      } else if (!resolveApiKey(apiKeySpec)) {
        const entered = await ctx.ui.input(
          `API key for ${picked.provider}`,
          `${envName} is unset — paste a key or "$ENV_VAR"`,
        );
        if (entered === undefined) return;
        apiKeySpec = entered.trim() || undefined;
      }

      const config: AdvisorConfig = {
        provider: picked.provider,
        modelId: picked.id,
        api,
        effort,
        apiKey: apiKeySpec,
        ...(prior.baseUrl ? { baseUrl: prior.baseUrl } : {}),
      };

      if (!saveAdvisorConfig(config)) {
        ctx.ui.notify('Failed to save advisor config.', 'error');
        return;
      }
      applyAdvisorConfig(config);
      ensureAdvisorToolActive(pi, true);

      const keyState = resolveApiKey(apiKeySpec)
        ? ''
        : ' (no API key yet — set one before calling the advisor)';
      ctx.ui.notify(
        `Advisor set to ${picked.name}${effort ? ` (${effort})` : ''}${keyState}.`,
        'info',
      );
    },
  });
}
