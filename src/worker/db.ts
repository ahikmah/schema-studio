import { Client } from 'pg';

export type QueryResult<T> = { rows: T[]; rowCount: number };

export interface Database {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
  close(): Promise<void>;
}

export type HyperdriveBinding = { connectionString: string };
export type DatabaseFactory = (env: { HYPERDRIVE: HyperdriveBinding }) => Promise<Database>;

export const openPostgres: DatabaseFactory = async (env) => {
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
  await client.connect();
  return {
    async query<T>(text: string, values: unknown[] = []) {
      const result = await client.query(text, values);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    },
    close: () => client.end(),
  };
};
