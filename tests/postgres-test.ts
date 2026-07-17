import { readFile } from 'node:fs/promises';
import { DataType, newDb } from 'pg-mem';
import type { DatabaseFactory } from '../src/worker/db';

const migration = await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');

export async function postgresTestDatabase() {
  const memory = newDb();
  memory.public.registerFunction({
    name: 'length',
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (value: string) => value.length,
  });
  memory.public.none(migration);
  const adapter = memory.adapters.createPg();
  const direct = new adapter.Client();
  await direct.connect();
  const factory: DatabaseFactory = async () => {
    const client = new adapter.Client();
    await client.connect();
    return {
      async query<T>(text: string, values: unknown[] = []) {
        try {
          const result = await client.query(text, values);
          return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
        } catch (error) {
          if (process.env.DEBUG_SQL) console.error(text, error);
          throw error;
        }
      },
      close: () => client.end(),
    };
  };
  return { factory, direct, close: () => direct.end() };
}
