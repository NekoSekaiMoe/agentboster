/**
 * CLI commands for remote control mode.
 * Allows the CLI to be controlled remotely from IM/Web sessions.
 */

import chalk from 'chalk';
import { getStoredAuth } from '@agentboster/adapter';
import { runRemoteControlMode } from '../modes/remote-control/remote-control-mode.ts';

/**
 * Handle `agentboster-cli remote` subcommands.
 * Returns true if a remote command was handled.
 */
export async function handleRemoteCommand(args: string[]): Promise<boolean> {
  if (args[0] !== 'remote') {
    return false;
  }

  const subcommand = args[1];

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    printRemoteHelp();
    return true;
  }

  if (subcommand === 'start') {
    await handleRemoteStart(args.slice(2));
    return true;
  }

  console.error(
    chalk.red(`Unknown remote subcommand: ${subcommand}`),
  );
  console.error('Run `agentboster-cli remote --help` for usage.');
  process.exit(1);
}

function printRemoteHelp(): void {
  console.log(`
${chalk.bold('agentboster-cli remote')} - Remote control mode

${chalk.bold('USAGE')}
  agentboster-cli remote start [options]

${chalk.bold('SUBCOMMANDS')}
  start     Start remote control mode (allows IM/Web to control this CLI)

${chalk.bold('OPTIONS')}
  --session <id>    Attach to an existing session ID
  --help, -h        Show this help message

${chalk.bold('DESCRIPTION')}
  Remote control mode allows you to control this CLI instance from your
  phone (via IM adapters like Telegram/Discord) or from the Web UI.

  When started, the CLI connects to the backend and waits for commands.
  You can then send messages from IM/Web, and the LLM will execute tools
  on your local machine (file operations, shell commands, computer use).

${chalk.bold('EXAMPLES')}
  # Start remote control for a new session
  agentboster-cli remote start

  # Attach to an existing session
  agentboster-cli remote start --session abc123

${chalk.bold('SECURITY')}
  - All tool executions require L2 approval (via IM buttons or Web UI)
  - You can configure trust rules in ~/.config/agentboster-cli/settings.json
  - Remote control mode respects the same security boundaries as local CLI
`);
}

async function handleRemoteStart(args: string[]): Promise<void> {
  // Parse options
  let sessionId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--session' && i + 1 < args.length) {
      sessionId = args[i + 1];
      i++;
    } else if (arg === '--help' || arg === '-h') {
      printRemoteHelp();
      return;
    } else {
      console.error(chalk.red(`Unknown option: ${arg}`));
      process.exit(1);
    }
  }

  // Auth gate
  if (!getStoredAuth()) {
    console.error(
      chalk.red(
        'Not logged in. Run `agentboster-cli login` first, then re-run this command.',
      ),
    );
    process.exit(1);
  }

  console.log(chalk.cyan('Starting remote control mode...'));
  if (sessionId) {
    console.log(chalk.dim(`Attaching to session: ${sessionId}`));
  }

  try {
    await runRemoteControlMode({ sessionId });
  } catch (error) {
    console.error(
      chalk.red('Remote control mode failed:'),
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  }
}
