import { type NeonQueryFunction, neon } from '@neondatabase/serverless';

import type { DBConfig, IDatabaseProvider } from './types';

export class PostgresProvider implements IDatabaseProvider {
  private sql: NeonQueryFunction<boolean, boolean> | null = null;

  async connect(config: DBConfig): Promise<void> {
    this.sql = neon(config.connectionString);
  }

  private getSql(): NeonQueryFunction<boolean, boolean> {
    if (!this.sql) {
      throw new Error('PostgresProvider: not connected. Call connect() first.');
    }
    return this.sql;
  }

  async query(text: string, params?: unknown[]): Promise<unknown> {
    const sql = this.getSql();
    if (params && params.length > 0) {
      return (
        sql as unknown as (text: string, params: string[]) => Promise<unknown>
      )(text, params as string[]);
    }
    return (sql as unknown as (text: string) => Promise<unknown>)(text);
  }

  async insert(
    collection: string,
    data: Record<string, unknown>,
  ): Promise<string> {
    const sql = this.getSql() as unknown as (
      text: string,
      params: string[],
    ) => Promise<unknown>;
    const id = crypto.randomUUID();
    const entries = Object.entries(data);
    const allColumns = ['id', ...entries.map(([k]) => k)];
    const allValues = [id, ...entries.map(([, v]) => v)];
    const placeholders = allValues.map((_, i) => `$${i + 1}`).join(', ');
    const colNames = allColumns.join(', ');

    await sql(
      `INSERT INTO ${collection} (${colNames}) VALUES (${placeholders})`,
      allValues as string[],
    );
    return id;
  }

  async find(
    collection: string,
    filter: Record<string, unknown>,
  ): Promise<unknown[]> {
    const sql = this.getSql() as unknown as (
      text: string,
      params: string[],
    ) => Promise<unknown[]>;
    const keys = Object.keys(filter);
    if (keys.length === 0) {
      return sql(`SELECT * FROM ${collection}`, []);
    }
    const conditions = keys.map((k, i) => `${k} = $${i + 1}`).join(' AND ');
    const values = Object.values(filter) as string[];
    return sql(`SELECT * FROM ${collection} WHERE ${conditions}`, values);
  }

  async update(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const sql = this.getSql() as unknown as (
      text: string,
      params: string[],
    ) => Promise<unknown>;
    const entries = Object.entries(data);
    const setClause = entries.map(([k], i) => `${k} = $${i + 1}`).join(', ');
    const values = [...entries.map(([, v]) => v), id] as string[];
    await sql(
      `UPDATE ${collection} SET ${setClause} WHERE id = $${entries.length + 1}`,
      values,
    );
  }

  async delete(collection: string, id: string): Promise<void> {
    const sql = this.getSql() as unknown as (
      text: string,
      params: string[],
    ) => Promise<unknown>;
    await sql(`DELETE FROM ${collection} WHERE id = $1`, [id]);
  }

  close(): void {
    this.sql = null;
  }
}
