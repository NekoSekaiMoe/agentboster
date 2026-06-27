import chalk from 'chalk';
import { ensureConfig, getActiveDeployment, loadConfig } from '../lib/config';
import {
  createApiClient,
  type ListSessionsResponse,
  type SessionListItem,
} from '../lib/api';

/**
 * `agentboster sessions`
 *
 * Lists the user's sessions, newest first. By default only shows
 * sessions started from this CLI machine (channel === cli:<clientId>).
 * Pass --all to see web/IM sessions too (read-only for those).
 *
 * The displayed index can be passed to `agentboster --session <id>`
 * or piped into a future interactive picker.
 */
export async function sessionsCommand(options: {
  deployment?: string;
  all?: boolean;
  limit?: number;
}): Promise<void> {
  const loaded = loadConfig();
  if (!loaded) {
    console.error(
      'Not logged in. Run `agentboster login --url <your-web-url>` first.',
    );
    process.exit(1);
  }

  const config = ensureConfig();
  const active = getActiveDeployment(config, options.deployment);
  if (!active) {
    console.error(
      'No configured deployment. Run `agentboster login --url <your-web-url>` first.',
    );
    process.exit(1);
  }

  const client = createApiClient(active.deployment);
  const params = new URLSearchParams();
  params.set('limit', String(options.limit ?? 50));
  // Default scope: only this machine's sessions. --all opts out.
  if (!options.all) {
    params.set('channel', `cli:${config.clientId}`);
  }

  let response: ListSessionsResponse;
  try {
    response = await client<ListSessionsResponse>(
      `/api/cli/sessions?${params}`,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Failed to list sessions: ${msg}`);
    process.exit(1);
  }

  if (!response.ok || !response.sessions) {
    console.error(`Server error: ${JSON.stringify(response).slice(0, 200)}`);
    process.exit(1);
  }

  if (response.sessions.length === 0) {
    if (options.all) {
      console.log('No sessions found.');
    } else {
      console.log(
        `No CLI sessions on this machine yet. Run \`agentboster\` to start one, or \`agentboster sessions --all\` to see all your sessions.`,
      );
    }
    return;
  }

  console.log(
    chalk.bold(
      `Sessions on ${options.all ? 'all channels' : `this machine (cli:${config.clientId.slice(0, 8)}…)`}`,
    ),
  );
  console.log();

  response.sessions.forEach((session, i) => {
    printSessionLine(i + 1, session);
  });

  console.log();
  console.log(
    chalk.gray(
      `Resume with: agentboster --session <id>  (or just agentboster -s <id>)`,
    ),
  );
}

function printSessionLine(index: number, session: SessionListItem): void {
  const num = chalk.gray(`${index}.`.padEnd(4));
  const title = session.title?.trim() || chalk.gray('(untitled)');
  const updated = new Date(session.updatedAt).toLocaleString();
  const channelTag = formatChannelTag(session.channel);
  const id = chalk.gray(session.id.slice(0, 8));

  console.log(`${num}${title} ${channelTag} ${id}`);
  console.log(
    chalk.gray(`     updated ${updated} · ${session.totalTokens} tokens`),
  );
}

function formatChannelTag(channel: string): string {
  if (channel === 'web') return chalk.blue('[web]');
  if (channel.startsWith('cli:')) {
    return chalk.cyan(`[cli:${channel.slice(4, 12)}…]`);
  }
  return chalk.magenta(`[${channel}]`);
}
