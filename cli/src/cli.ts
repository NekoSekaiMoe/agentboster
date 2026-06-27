import { Command } from 'commander';
import { chatCommand } from './commands/chat';
import { chatTuiCommand } from './commands/chat-tui';
import { loginCommand } from './commands/login';
import { modelsCommand } from './commands/models';
import { sessionsCommand } from './commands/sessions';
import { themesCommand } from './commands/themes';

const program = new Command();

program
  .name('agentboster')
  .description('Terminal client for agentboster')
  .version('0.1.0')
  .argument(
    '[message]',
    'if provided, run a one-shot chat (print mode) and exit',
  )
  .option('-s, --session <sessionId>', 'resume an existing session id')
  .option('-d, --deployment <name>', 'deployment name (default: "default")')
  .option('-m, --model <modelId>', 'override the model for this run')
  .action(
    async (
      message: string | undefined,
      opts: {
        session?: string;
        deployment?: string;
        model?: string;
      },
    ) => {
      // No message arg → interactive TUI. With a message → one-shot print.
      if (message === undefined) {
        await chatTuiCommand({
          sessionId: opts.session,
          deployment: opts.deployment,
          model: opts.model,
        });
      } else {
        await chatCommand({
          message,
          sessionId: opts.session,
          deployment: opts.deployment,
          model: opts.model,
        });
      }
    },
  );

program
  .command('login')
  .description(
    'Authenticate against a web deployment and save credentials locally',
  )
  .requiredOption('--url <url>', 'agentboster web deployment base URL')
  .option('--username <username>', 'username (prompted if omitted)')
  .option('--password <password>', 'password (prompted if omitted)')
  .option('--name <name>', 'deployment name to save as (default: "default")')
  .action(
    async (opts: {
      url: string;
      username?: string;
      password?: string;
      name?: string;
    }) => {
      await loginCommand({
        baseUrl: opts.url,
        username: opts.username,
        password: opts.password,
        name: opts.name,
      });
    },
  );

program
  .command('sessions')
  .description('List your sessions (default: only this machine)')
  .option('-a, --all', 'include web/IM sessions (read-only for those)')
  .option('-d, --deployment <name>', 'deployment name')
  .option('-n, --limit <n>', 'max sessions to fetch', '50')
  .action(
    async (opts: { all?: boolean; deployment?: string; limit?: string }) => {
      await sessionsCommand({
        deployment: opts.deployment,
        all: opts.all,
        limit: opts.limit ? Number.parseInt(opts.limit, 10) : undefined,
      });
    },
  );

program
  .command('models')
  .description('List models configured on the server')
  .option('-d, --deployment <name>', 'deployment name')
  .action(async (opts: { deployment?: string }) => {
    await modelsCommand({ deployment: opts.deployment });
  });

program
  .command('themes [name]')
  .description('List themes or set the active theme (saved to config)')
  .option(
    '-s, --set <name>',
    'set theme and save (alternative to positional arg)',
  )
  .action(async (name: string | undefined, opts: { set?: string }) => {
    await themesCommand({ set: opts.set ?? name });
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
