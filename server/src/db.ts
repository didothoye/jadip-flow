import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

// numeric → number, int8 → number (les volumes restent < 2^53)
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
// date → chaîne AAAA-MM-JJ (pas de décalage de fuseau)
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 15 });

export type Queryable = Pick<pg.PoolClient, 'query'>;

export async function q<T = any>(text: string, params: unknown[] = [], db: Queryable = pool): Promise<T[]> {
  const r = await db.query(text, params as any[]);
  return r.rows as T[];
}

export async function one<T = any>(text: string, params: unknown[] = [], db: Queryable = pool): Promise<T | null> {
  const rows = await q<T>(text, params, db);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Verrou consultatif : garantit qu'une seule instance de l'application exécute une tâche. */
export async function withLock<T>(key: number, fn: () => Promise<T>): Promise<T | undefined> {
  const c = await pool.connect();
  try {
    const { rows } = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [key]);
    if (!rows[0].ok) return undefined;
    try {
      return await fn();
    } finally {
      await c.query('SELECT pg_advisory_unlock($1)', [key]);
    }
  } finally {
    c.release();
  }
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate(log: (m: string) => void = () => {}): Promise<void> {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await q<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(migrationsDir, f), 'utf8');
    await tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(424242)');
      const again = await c.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f]);
      if (again.rowCount) return;
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
    });
    log(`migration appliquée : ${f}`);
  }
}
