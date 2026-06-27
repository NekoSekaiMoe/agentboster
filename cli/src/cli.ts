import { Command } from 'commander';
import { chatCommand } from './commands/chat';
import { loginCommand } from './commands/login';

const program = new Command();

program
  .name('agentboster')
  .description('Terminal client for agentboster')
  .version('0.1.0');

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
  .command('chat [message]')
  .description('Send a one-shot message and stream the response to stdout')
  .option('-s, --session <sessionId>', 'resume an existing session id')
  .option('-d, --deployment <name>', 'deployment name (default: "default")')
  .action(
    async (
      message: string | undefined,
      opts: { session?: string; deployment?: string },
    ) => {
      await chatCommand({
        message,
        sessionId: opts.session,
        deployment: opts.deployment,
      });
    },
  );

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
