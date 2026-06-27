import { homedir } from 'node:os';
import { join } from 'node:path';

export const CLI_HOME =
  process.env.AGENTBOSTER_HOME ?? join(homedir(), '.agentboster');
export const CLI_CONFIG_FILE = join(CLI_HOME, 'config.json');

export type CliConfig = {
  url: string;
  token?: string;
};
