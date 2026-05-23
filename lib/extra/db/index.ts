import { MongoDBProvider } from './mongodb';
import { PostgresProvider } from './postgres';
import type { DBConfig, IDatabaseProvider } from './types';

export type { DBConfig, DBProviderType, IDatabaseProvider } from './types';
export { PostgresProvider } from './postgres';
export { MongoDBProvider } from './mongodb';

export function createDatabaseProvider(config: DBConfig): IDatabaseProvider {
  switch (config.type) {
    case 'vercel-postgres':
      return new PostgresProvider();
    case 'mongodb':
      return new MongoDBProvider();
    default: {
      const unsupported: never = config.type;
      throw new Error(`Unsupported database provider type: ${unsupported}`);
    }
  }
}
