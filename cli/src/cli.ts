import { Command } from 'commander';
import { loginCommand } from './commands/login';

const program = new Command();

program
  .name('agentboster')
  .description('Terminal client for agentboster')
  .version('0.1.0');

program
  .command('login')
  .description('Authenticate against a web deployment and save credentials locally')
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

// `chat` command is added in a later stage. For now login is the only
// subcommand so users can verify the CLI <-> web auth path before the
// full TUI is wired up.

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
