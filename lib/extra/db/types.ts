export type DBProviderType = 'vercel-postgres';

export interface DBConfig {
  type: DBProviderType;
  connectionString: string;
  ssl?: boolean;
}

export interface DatabaseRow {
  [key: string]: unknown;
}

export interface QueryResult {
  rows: DatabaseRow[];
  rowCount: number;
}

export interface InsertResult {
  id: string;
}

export interface FindResult {
  rows: DatabaseRow[];
}

export interface IDatabaseProvider {
  connect(config: DBConfig): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<unknown>;
  insert(collection: string, data: Record<string, unknown>): Promise<string>;
  find(collection: string, filter: Record<string, unknown>): Promise<unknown[]>;
  update(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<void>;
  delete(collection: string, id: string): Promise<void>;
  close(): void;
}
