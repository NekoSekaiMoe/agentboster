import { loginCommand } from './commands/login';
import { pairCommand } from './commands/pair';
import { modelsCommand } from './commands/models';
import { sessionsCommand } from './commands/sessions';
import { chatCommand } from './commands/chat';
import { localCommand } from './commands/local';
import { runCliTui } from './tui';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '-h' || command === '--help') {
    await runCliTui();
    return;
  }

  if (command === 'login') {
    await loginCommand({
      url: getFlag(args, '--url') ?? '',
      username: getFlag(args, '--username'),
      password: getFlag(args, '--password'),
    });
    return;
  }

  if (command === 'pair') {
    await pairCommand({
      url: getFlag(args, '--url'),
      adapter: getFlag(args, '--adapter'),
    });
    return;
  }

  if (command === 'models') {
    await modelsCommand({ url: getFlag(args, '--url') ?? '' });
    return;
  }

  if (command === 'sessions') {
    await sessionsCommand({ url: getFlag(args, '--url') ?? '' });
    return;
  }

  if (command === 'local') {
    await localCommand(args.slice(1));
    return;
  }

  await chatCommand({
    url: getFlag(args, '--url'),
    sessionId: getFlag(args, '--session'),
    model: getFlag(args, '--model'),
    message: args.join(' '),
  });
}

function getFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1] && !args[index + 1].startsWith('-')
    ? args[index + 1]
    : '';
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
