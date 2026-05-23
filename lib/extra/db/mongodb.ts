import { type Collection, type Db, MongoClient, ObjectId } from 'mongodb';

import type { DBConfig, IDatabaseProvider } from './types';

export class MongoDBProvider implements IDatabaseProvider {
  private client: MongoClient | null = null;
  private db: Db | null = null;

  async connect(config: DBConfig): Promise<void> {
    this.client = new MongoClient(config.connectionString, {
      tls: config.ssl ?? false,
    });
    await this.client.connect();
    const dbName =
      new URL(config.connectionString).pathname.slice(1) || 'agentclaw';
    this.db = this.client.db(dbName);
  }

  private getCollection(collection: string): Collection {
    if (!this.db) {
      throw new Error('MongoDBProvider: not connected. Call connect() first.');
    }
    return this.db.collection(collection);
  }

  async query(_sql: string, _params?: unknown[]): Promise<unknown> {
    throw new Error(
      'MongoDBProvider: query() is not supported. Use find() instead.',
    );
  }

  async insert(
    collection: string,
    data: Record<string, unknown>,
  ): Promise<string> {
    const result = await this.getCollection(collection).insertOne(data);
    return result.insertedId.toString();
  }

  async find(
    collection: string,
    filter: Record<string, unknown>,
  ): Promise<unknown[]> {
    const docs = await this.getCollection(collection).find(filter).toArray();
    return docs.map((doc) => ({
      ...doc,
      id: doc._id.toString(),
      _id: undefined,
    }));
  }

  async update(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.getCollection(collection).updateOne(
      { _id: new ObjectId(id) },
      { $set: data },
    );
  }

  async delete(collection: string, id: string): Promise<void> {
    await this.getCollection(collection).deleteOne({ _id: new ObjectId(id) });
  }

  close(): void {
    if (this.client) {
      this.client.close().catch(() => {});
      this.client = null;
      this.db = null;
    }
  }
}
