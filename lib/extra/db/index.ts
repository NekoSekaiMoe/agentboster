import { PostgresProvider } from './postgres';
import type { DBConfig, IDatabaseProvider } from './types';

export type { DBConfig, DBProviderType, IDatabaseProvider } from './types';
export { PostgresProvider } from './postgres';

export function createDatabaseProvider(config: DBConfig): IDatabaseProvider {
  switch (config.type) {
    case 'vercel-postgres':
      return new PostgresProvider();
    default: {
      const unsupported: never = config.type;
      throw new Error(`Unsupported database provider type: ${unsupported}`);
    }
  }
}
