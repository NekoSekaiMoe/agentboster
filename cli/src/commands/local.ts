import { evaluateLocalCommand, executeLocalTool } from '../lib/local-security';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

async function confirm(promptText: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${promptText} [y/N]: `))
      .trim()
      .toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

async function requireApproval(command: string): Promise<void> {
  const decision = await evaluateLocalCommand(command);
  if (!decision.ok) {
    throw new Error(decision.message);
  }

  if (decision.level === 'l2') {
    const approved = await confirm(
      `${decision.reasoning ?? decision.message} Approve risky local action?`,
    );
    if (!approved) {
      throw new Error('Operation cancelled by user.');
    }
  }
}

export async function localCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === 'read') {
    const path = args[1];
    if (!path) {
      throw new Error('Usage: local read <path>');
    }
    const result = await executeLocalTool('local_read_file', { path });
    if (!result.ok) {
      throw new Error(result.error ?? 'read failed');
    }
    process.stdout.write(`${String(result.output ?? '')}\n`);
    return;
  }

  if (subcommand === 'write') {
    const path = args[1];
    const content = args.slice(2).join(' ');
    if (!path || !content) {
      throw new Error('Usage: local write <path> <content>');
    }
    await requireApproval(`write ${path}`);
    const result = await executeLocalTool('local_write_file', {
      path,
      content,
    });
    if (!result.ok) {
      throw new Error(result.error ?? 'write failed');
    }
    process.stdout.write(`${String(result.output ?? '')}\n`);
    return;
  }

  if (subcommand === 'patch') {
    const path = args[1];
    const patch = args.slice(2).join(' ');
    if (!path || !patch) {
      throw new Error('Usage: local patch <path> <patch>');
    }
    await requireApproval(`patch ${path}`);
    const result = await executeLocalTool('local_patch_file', { path, patch });
    if (!result.ok) {
      throw new Error(result.error ?? 'patch failed');
    }
    process.stdout.write(`${String(result.output ?? '')}\n`);
    return;
  }

  if (subcommand === 'exec') {
    const command = args.slice(1).join(' ');
    if (!command) {
      throw new Error('Usage: local exec <command>');
    }
    await requireApproval(command);
    const result = await executeLocalTool('local_exec', { command });
    if (!result.ok) {
      throw new Error(result.error ?? 'exec failed');
    }
    process.stdout.write(`${String(result.output ?? '')}\n`);
    return;
  }

  throw new Error('Usage: local <read|write|patch|exec> ...');
}
