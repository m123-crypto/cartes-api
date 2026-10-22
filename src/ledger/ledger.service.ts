import { Injectable } from '@nestjs/common';
import { Queryable } from '../db/db.service';
import { Operator } from '../common/pricing';

export type LedgerKind =
  | 'topup'
  | 'card_creation_fee'
  | 'card_load'
  | 'card_unload'
  | 'card_authorization'
  | 'card_reversal'
  | 'withdrawal_hold'
  | 'withdrawal_settle'
  | 'withdrawal_release'
  | 'adjustment';

export interface Posting {
  accountId: string;
  direction: 'D' | 'C';
  amount: number;
}

export interface PostInput {
  kind: LedgerKind;
  /** Clé unique : rejouer la même opération ne crée jamais de seconde écriture. */
  idempotencyKey: string;
  userId?: string | null;
  referenceId?: string | null;
  metadata?: Record<string, unknown>;
  postings: Posting[];
}

export interface PostResult {
  transactionId: string;
  /** false si la transaction existait déjà (rejeu idempotent). */
  created: boolean;
}

/** Codes des comptes système créés par la migration 001. */
export const SystemAccount = {
  momoFloat: (op: Operator) => `system:momo_float:${op}`,
  withdrawalsInFlight: 'system:withdrawals_in_flight',
  issuerPayable: 'system:issuer_payable',
  feesRevenue: 'system:fees_revenue',
} as const;

export const walletAccountCode = (userId: string) => `user:${userId}:wallet`;
export const cardAccountCode = (cardId: string) => `card:${cardId}`;

/**
 * Seule porte d'écriture dans le grand livre. Les garanties fortes (équilibre, pas de
 * découvert, immutabilité) sont imposées par PostgreSQL ; ce service vérifie les mêmes
 * règles en amont pour échouer vite avec un message clair.
 */
@Injectable()
export class LedgerService {
  private readonly systemIds = new Map<string, string>();

  async post(c: Queryable, input: PostInput): Promise<PostResult> {
    const postings = input.postings.filter((p) => p.amount !== 0);
    validatePostings(postings);

    const inserted = await c.query<{ id: string }>(
      `insert into ledger_transactions (kind, idempotency_key, user_id, reference_id, metadata)
       values ($1, $2, $3, $4, $5)
       on conflict (idempotency_key) do nothing
       returning id`,
      [input.kind, input.idempotencyKey, input.userId ?? null, input.referenceId ?? null, JSON.stringify(input.metadata ?? {})],
    );
    if (inserted.rows.length === 0) {
      const existing = await c.query<{ id: string }>('select id from ledger_transactions where idempotency_key = $1', [
        input.idempotencyKey,
      ]);
      return { transactionId: existing.rows[0].id, created: false };
    }
    const transactionId = inserted.rows[0].id;

    // Ordre stable par compte : deux transactions concurrentes verrouillent les comptes
    // dans le même ordre, ce qui évite les interblocages.
    const sorted = [...postings].sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
    await c.query(
      `insert into ledger_entries (transaction_id, account_id, direction, amount)
       select $1, account_id, direction, amount
         from unnest($2::uuid[], $3::char[], $4::bigint[]) with ordinality as p(account_id, direction, amount, ord)
        order by ord`,
      [transactionId, sorted.map((p) => p.accountId), sorted.map((p) => p.direction), sorted.map((p) => p.amount)],
    );
    return { transactionId, created: true };
  }

  async systemAccountId(c: Queryable, code: string): Promise<string> {
    const cached = this.systemIds.get(code);
    if (cached) return cached;
    const res = await c.query<{ id: string }>('select id from ledger_accounts where code = $1', [code]);
    if (!res.rows[0]) throw new Error(`compte système absent : ${code}`);
    this.systemIds.set(code, res.rows[0].id);
    return res.rows[0].id;
  }

  /** Crée le compte s'il n'existe pas et renvoie son id. */
  async ensureAccount(
    c: Queryable,
    code: string,
    kind: 'asset' | 'liability' | 'revenue' | 'expense',
    ownerUserId: string | null,
  ): Promise<string> {
    const res = await c.query<{ id: string }>(
      `with ins as (
         insert into ledger_accounts (code, kind, owner_user_id) values ($1, $2, $3)
         on conflict (code) do nothing returning id
       )
       select id from ins union all select id from ledger_accounts where code = $1 limit 1`,
      [code, kind, ownerUserId],
    );
    if (res.rows[0]) return res.rows[0].id;
    // Création concurrente validée après le début de notre requête : on relit.
    const again = await c.query<{ id: string }>('select id from ledger_accounts where code = $1', [code]);
    return again.rows[0].id;
  }

  async walletAccountId(c: Queryable, userId: string): Promise<string> {
    return this.ensureAccount(c, walletAccountCode(userId), 'liability', userId);
  }

  async balance(c: Queryable, accountId: string): Promise<number> {
    const res = await c.query<{ balance: number }>('select balance from ledger_accounts where id = $1', [accountId]);
    return res.rows[0]?.balance ?? 0;
  }

  /** Total détenu par un utilisateur : portefeuille + toutes ses cartes. */
  async userHoldings(c: Queryable, userId: string): Promise<number> {
    const res = await c.query<{ total: number }>(
      'select coalesce(sum(balance), 0)::bigint as total from ledger_accounts where owner_user_id = $1',
      [userId],
    );
    return res.rows[0].total;
  }
}

export function validatePostings(postings: Posting[]): void {
  if (postings.length < 2) throw new Error('une transaction comptable demande au moins 2 écritures');
  let debits = 0;
  let credits = 0;
  for (const p of postings) {
    if (!Number.isSafeInteger(p.amount) || p.amount <= 0) throw new Error(`montant invalide : ${p.amount}`);
    if (p.direction === 'D') debits += p.amount;
    else if (p.direction === 'C') credits += p.amount;
    else throw new Error(`sens invalide : ${p.direction}`);
  }
  if (debits !== credits) throw new Error(`transaction déséquilibrée : débits ${debits}, crédits ${credits}`);
}
