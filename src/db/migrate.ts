import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';

/** Dossier des migrations, valable depuis src/db (ts-node) comme depuis dist/db (build). */
export const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');

/**
 * Applique, dans l'ordre alphabétique, les fichiers .sql pas encore appliqués.
 * Chaque fichier tourne dans sa propre transaction ; un verrou consultatif empêche
 * deux instances de migrer en même temps.
 */
export async function migrate(databaseUrl: string, dir = MIGRATIONS_DIR, log = console.log): Promise<string[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock(727274)');
    await client.query(`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`);
    const done = new Set((await client.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`échec de la migration ${file} : ${(err as Error).message}`);
      }
      applied.push(file);
      log(`migration appliquée : ${file}`);
    }
  } finally {
    await client.query('select pg_advisory_unlock(727274)').catch(() => undefined);
    await client.end();
  }
  return applied;
}
