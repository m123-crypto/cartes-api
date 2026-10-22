import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow, types } from 'pg';
import { AppConfig, CONFIG } from '../config/config';

// bigint (int8) -> number. Les montants en FCFA restent très loin de 2^53,
// mais on refuse explicitement toute valeur qui perdrait en précision.
types.setTypeParser(20, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`valeur bigint hors limites : ${value}`);
  return n;
});
// date -> chaîne 'YYYY-MM-DD' (pas de conversion de fuseau horaire)
types.setTypeParser(1082, (value: string) => value);

/** Ce qu'il faut pour exécuter une requête : le pool ou un client dans une transaction. */
export interface Queryable {
  query<T extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(@Inject(CONFIG) cfg: AppConfig) {
    this.pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 10 });
  }

  async query<T extends QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query<T>(text, params);
    return res.rows;
  }

  async one<T extends QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T | undefined> {
    const rows = await this.query<T>(text, params);
    return rows[0];
  }

  /**
   * Exécute fn dans une transaction. Les contraintes différées (équilibre du grand livre)
   * sont vérifiées au COMMIT : une erreur à ce moment annule tout et remonte à l'appelant.
   */
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
