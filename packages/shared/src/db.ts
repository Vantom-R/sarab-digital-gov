import pg from 'pg';
import { readFileSync } from 'node:fs';

export type Db = pg.Pool;

// Return DATE columns as plain 'YYYY-MM-DD' strings (no timezone shifts on birth dates).
pg.types.setTypeParser(1082, (v: string) => v);

/** One pool per service; each service talks ONLY to its own database. */
export function createDb(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL env missing');
  return new pg.Pool({ connectionString: url, max: 5 });
}

/** Waits for Postgres, then applies the (idempotent) schema file. */
export async function migrate(db: Db, schemaPath: string | URL): Promise<void> {
  const sql = readFileSync(schemaPath, 'utf8');
  for (let attempt = 1; ; attempt++) {
    try {
      await db.query('SELECT 1');
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await db.query(sql);
}

export async function tx<T>(db: Db, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
