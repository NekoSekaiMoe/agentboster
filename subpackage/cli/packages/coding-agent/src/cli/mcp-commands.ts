import chalk from 'chalk';
import {
  type DiscoveredMcpService,
  McpServiceManager,
} from '../core/mcp-services.ts';

function printMcpHelp(): void {
  console.log(`${chalk.bold('agentboster mcp')} - discover and run local MCP/LSP services

${chalk.bold('Usage:')}
  agentboster mcp list [--json]
  agentboster mcp start <service> [--json]

${chalk.bold('Examples:')}
  agentboster mcp list
  agentboster mcp start clangd
  agentboster mcp start config:filesystem --json
`);
}

function formatYesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function serviceLabel(service: DiscoveredMcpService): string {
  const source =
    service.source === 'project-config'
      ? `project ${service.sourcePath ?? ''}`.trim()
      : 'builtin';
  return `${service.id.padEnd(28)} ${service.protocol.padEnd(3)} installed=${formatYesNo(
    service.installed,
  )} project=${formatYesNo(service.projectDetected)} source=${source}`;
}

function printServiceList(services: DiscoveredMcpService[]): void {
  if (services.length === 0) {
    console.log(chalk.dim('No MCP/LSP services discovered.'));
    return;
  }
  console.log(chalk.bold(`MCP/LSP services in ${process.cwd()}`));
  for (const service of services) {
    const marker = service.installed && service.projectDetected ? '*' : ' ';
    console.log(`${marker} ${serviceLabel(service)}`);
    console.log(chalk.dim(`    ${service.command} ${service.args.join(' ')}`));
    console.log(chalk.dim(`    ${service.description} (${service.reason})`));
  }
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export async function handleMcpCommand(args: string[]): Promise<boolean> {
  if (args[0] !== 'mcp') return false;

  const subcommand = args[1] ?? 'list';
  const json = hasFlag(args, '--json');
  const help = hasFlag(args, '--help') || hasFlag(args, '-h');
  if (help) {
    printMcpHelp();
    return true;
  }

  const manager = new McpServiceManager();

  if (subcommand === 'list' || subcommand === 'discover') {
    const services = await manager.discover();
    if (json) {
      console.log(JSON.stringify({ services }, null, 2));
    } else {
      printServiceList(services);
    }
    return true;
  }

  if (subcommand === 'start') {
    const target = args.find(
      (arg, index) =>
        index > 1 && !arg.startsWith('-') && args[index - 1] !== '--',
    );
    if (!target) {
      console.error('Error: Missing service name');
      console.error('Usage: agentboster mcp start <service>');
      process.exit(1);
    }

    try {
      const status = await manager.start(target, {
        onStderr: (chunk) => process.stderr.write(chunk),
      });
      if (json) {
        console.log(JSON.stringify({ service: status }, null, 2));
      } else {
        console.log(
          `Started ${chalk.bold(status.name)} (${status.protocol}) pid=${status.pid ?? 'unknown'}.`,
        );
        console.log(chalk.dim('Press Ctrl-C to stop the service.'));
      }

      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        void manager.stop(status.id).finally(() => process.exit(0));
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      await manager.waitForExit(status.id);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      return true;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  console.error(`Unknown mcp subcommand: ${subcommand}`);
  console.error('Available: list, start');
  process.exit(1);
}
