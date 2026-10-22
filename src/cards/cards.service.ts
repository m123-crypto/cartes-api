import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DbService, Queryable } from '../db/db.service';
import { cardAccountCode, LedgerService, SystemAccount } from '../ledger/ledger.service';
import { DomainError, Errors, isOverdraftError } from '../common/errors';
import { AMOUNTS, CardType, FEES, fxFee, tierLimits } from '../common/pricing';
import { AuthorizationRequest, CARD_ISSUER, CardIssuer, ReversalEvent } from './issuer.provider';

interface CardRow {
  id: string;
  user_id: string;
  issuer_card_id: string;
  type: CardType;
  label: string | null;
  last4: string;
  expiry_month: number;
  expiry_year: number;
  status: 'active' | 'frozen' | 'terminated';
  monthly_limit: number | null;
  ledger_account_id: string;
  created_at: Date;
  terminated_at: Date | null;
}

export interface Decision {
  approved: boolean;
  reason?: string;
}

const CARD_COLUMNS = `c.id, c.user_id, c.issuer_card_id, c.type, c.label, c.last4, c.expiry_month, c.expiry_year,
  c.status, c.monthly_limit, c.ledger_account_id, c.created_at, c.terminated_at`;

@Injectable()
export class CardsService {
  private readonly logger = new Logger('Cards');

  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
    @Inject(CARD_ISSUER) private readonly issuer: CardIssuer,
  ) {}

  // --- Cycle de vie ----------------------------------------------------------

  async create(
    userId: string,
    input: { type: CardType; label?: string; monthlyLimit?: number },
    idempotencyKey: string,
  ) {
    const existing = await this.db.one<CardRow>(`select ${CARD_COLUMNS} from cards c where user_id = $1 and idempotency_key = $2`, [
      userId,
      idempotencyKey,
    ]);
    if (existing) return this.present(this.db.pool, existing);

    const user = await this.db.one<{ kyc_tier: number; status: string; first_name: string | null; last_name: string | null }>(
      'select kyc_tier, status, first_name, last_name from users where id = $1',
      [userId],
    );
    if (!user) throw Errors.notFound('Utilisateur');
    if (user.status !== 'active') throw new DomainError('account_inactive', 'Compte suspendu', 403);
    const limits = tierLimits(user.kyc_tier);
    if (!limits.cardTypes.includes(input.type)) {
      throw Errors.kycRequired(input.type === 'single_use' ? 1 : 2);
    }
    const active = await this.db.one<{ n: number }>(
      `select count(*)::int as n from cards where user_id = $1 and status <> 'terminated'`,
      [userId],
    );
    if ((active?.n ?? 0) >= limits.maxActiveCards) throw Errors.limitExceeded('max_active_cards', limits.maxActiveCards);

    const fee = FEES.cardCreation[input.type];
    const walletBalance = await this.ledger.balance(this.db.pool, await this.ledger.walletAccountId(this.db.pool, userId));
    if (walletBalance < fee) throw Errors.insufficientFunds();

    const cardId = randomUUID();
    const issued = await this.issuer
      .createCard({
        cardId,
        userId,
        type: input.type,
        holderName: [user.first_name, user.last_name].filter(Boolean).join(' ').toUpperCase() || 'TITULAIRE',
      })
      .catch((err) => {
        this.logger.error(`création refusée par l'émetteur : ${(err as Error).message}`);
        throw Errors.providerUnavailable();
      });

    try {
      const card = await this.db.tx(async (c) => {
        const accountId = await this.ledger.ensureAccount(c, cardAccountCode(cardId), 'liability', userId);
        const res = await c.query<CardRow>(
          `insert into cards (id, user_id, issuer, issuer_card_id, type, label, last4, expiry_month, expiry_year,
                              monthly_limit, ledger_account_id, idempotency_key)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           returning id, user_id, issuer_card_id, type, label, last4, expiry_month, expiry_year,
                     status, monthly_limit, ledger_account_id, created_at, terminated_at`,
          [
            cardId, userId, this.issuer.name, issued.issuerCardId, input.type, input.label ?? null, issued.last4,
            issued.expiryMonth, issued.expiryYear, input.monthlyLimit ?? null, accountId, idempotencyKey,
          ],
        );
        await this.ledger.post(c, {
          kind: 'card_creation_fee',
          idempotencyKey: `card-fee:${cardId}`,
          userId,
          referenceId: cardId,
          metadata: { type: input.type },
          postings: [
            { accountId: await this.ledger.walletAccountId(c, userId), direction: 'D', amount: fee },
            { accountId: await this.ledger.systemAccountId(c, SystemAccount.feesRevenue), direction: 'C', amount: fee },
          ],
        });
        return res.rows[0];
      });
      return this.present(this.db.pool, card);
    } catch (err) {
      // La carte existe chez l'émetteur mais pas chez nous : on la résilie.
      await this.issuer.setStatus(issued.issuerCardId, 'terminated').catch((e) =>
        this.logger.error(`carte orpheline ${issued.issuerCardId} à résilier manuellement : ${(e as Error).message}`),
      );
      throw err;
    }
  }

  async list(userId: string) {
    const rows = await this.db.query<CardRow & { balance: number }>(
      `select ${CARD_COLUMNS}, a.balance from cards c join ledger_accounts a on a.id = c.ledger_account_id
        where c.user_id = $1 order by c.status = 'terminated', c.created_at desc`,
      [userId],
    );
    return rows.map((r) => present(r, r.balance));
  }

  async get(userId: string, cardId: string) {
    return this.present(this.db.pool, await this.owned(this.db.pool, userId, cardId));
  }

  async setFrozen(userId: string, cardId: string, frozen: boolean) {
    const card = await this.owned(this.db.pool, userId, cardId);
    if (card.status === 'terminated') throw new DomainError('card_terminated', 'Carte résiliée', 409);
    const target = frozen ? 'frozen' : 'active';
    if (card.status !== target) {
      await this.issuer.setStatus(card.issuer_card_id, target).catch(() => {
        throw Errors.providerUnavailable();
      });
      await this.db.query('update cards set status = $2, updated_at = now() where id = $1', [cardId, target]);
    }
    return this.get(userId, cardId);
  }

  async updateLimit(userId: string, cardId: string, monthlyLimit: number | null) {
    await this.owned(this.db.pool, userId, cardId);
    await this.db.query('update cards set monthly_limit = $2, updated_at = now() where id = $1', [cardId, monthlyLimit]);
    return this.get(userId, cardId);
  }

  /** Résiliation : la carte est désactivée chez l'émetteur et son solde revient au portefeuille. */
  async terminate(userId: string, cardId: string) {
    const card = await this.owned(this.db.pool, userId, cardId);
    if (card.status !== 'terminated') await this.terminateCard(card);
    return this.get(userId, cardId);
  }

  async revealSession(userId: string, cardId: string) {
    const card = await this.owned(this.db.pool, userId, cardId);
    if (card.status === 'terminated') throw new DomainError('card_terminated', 'Carte résiliée', 409);
    return this.issuer.createRevealSession(card.issuer_card_id).catch(() => {
      throw Errors.providerUnavailable();
    });
  }

  // --- Mouvements portefeuille <-> carte ------------------------------------

  async load(userId: string, cardId: string, amount: number, idempotencyKey: string) {
    if (amount < AMOUNTS.cardLoadMin) throw new DomainError('invalid_amount', `Minimum ${AMOUNTS.cardLoadMin} FCFA`, 400);
    return this.transfer(userId, cardId, amount, idempotencyKey, 'load');
  }

  async unload(userId: string, cardId: string, amount: number, idempotencyKey: string) {
    if (amount < 1) throw new DomainError('invalid_amount', 'Montant invalide', 400);
    return this.transfer(userId, cardId, amount, idempotencyKey, 'unload');
  }

  private async transfer(userId: string, cardId: string, amount: number, key: string, way: 'load' | 'unload') {
    await this.db.tx(async (c) => {
      const card = await this.owned(c, userId, cardId);
      if (card.status === 'terminated') throw new DomainError('card_terminated', 'Carte résiliée', 409);
      const wallet = await this.ledger.walletAccountId(c, userId);
      const [from, to] = way === 'load' ? [wallet, card.ledger_account_id] : [card.ledger_account_id, wallet];
      await this.ledger.post(c, {
        kind: way === 'load' ? 'card_load' : 'card_unload',
        idempotencyKey: `card-${way}:${userId}:${key}`,
        userId,
        referenceId: cardId,
        postings: [
          { accountId: from, direction: 'D', amount },
          { accountId: to, direction: 'C', amount },
        ],
      });
    });
    return this.get(userId, cardId);
  }

  // --- Événements de l'émetteur ---------------------------------------------

  /**
   * Décision en temps réel sur un paiement. Doit répondre vite (l'émetteur attend
   * quelques secondes au plus) et toujours renvoyer une décision, jamais une erreur.
   */
  async authorize(req: AuthorizationRequest): Promise<Decision> {
    const result = await this.db.tx(async (c) => {
      const prior = await c.query<{ decision: string; decline_reason: string | null }>(
        'select decision, decline_reason from card_authorizations where issuer_authorization_id = $1',
        [req.issuerAuthorizationId],
      );
      if (prior.rows[0]) {
        return { decision: toDecision(prior.rows[0].decision, prior.rows[0].decline_reason), card: null as CardRow | null };
      }

      const cardRes = await c.query<CardRow & { user_status: string }>(
        `select ${CARD_COLUMNS}, u.status as user_status from cards c join users u on u.id = c.user_id
          where c.issuer_card_id = $1 for update of c`,
        [req.issuerCardId],
      );
      const card = cardRes.rows[0];
      const fee = fxFee(req.billingAmountXof, req.currency);
      const total = req.billingAmountXof + fee;

      let decline: string | null = null;
      if (!card) decline = 'unknown_card';
      else if (card.status !== 'active') decline = card.status === 'frozen' ? 'card_frozen' : 'card_terminated';
      else if (card.user_status !== 'active') decline = 'account_inactive';
      else if (card.monthly_limit) {
        const spent = await c.query<{ total: number }>(
          `select coalesce(sum(amount_xof + fee_xof), 0)::bigint as total from card_authorizations
            where card_id = $1 and decision = 'approved' and reversed_at is null
              and created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'`,
          [card.id],
        );
        if (spent.rows[0].total + total > card.monthly_limit) decline = 'card_limit_exceeded';
      }

      let ledgerTransactionId: string | null = null;
      if (!decline && card) {
        // Point de sauvegarde : un solde insuffisant annule seulement l'écriture, pas l'enregistrement du refus.
        await c.query('savepoint authorize');
        try {
          const posted = await this.ledger.post(c, {
            kind: 'card_authorization',
            idempotencyKey: `auth:${req.issuerAuthorizationId}`,
            userId: card.user_id,
            referenceId: card.id,
            metadata: { merchant: req.merchantName, currency: req.currency, amount: req.amount, fee },
            postings: [
              { accountId: card.ledger_account_id, direction: 'D', amount: total },
              { accountId: await this.ledger.systemAccountId(c, SystemAccount.issuerPayable), direction: 'C', amount: req.billingAmountXof },
              { accountId: await this.ledger.systemAccountId(c, SystemAccount.feesRevenue), direction: 'C', amount: fee },
            ],
          });
          ledgerTransactionId = posted.transactionId;
          await c.query('release savepoint authorize');
        } catch (err) {
          if (!isOverdraftError(err)) throw err;
          await c.query('rollback to savepoint authorize');
          decline = 'insufficient_funds';
        }
      }

      await c.query(
        `insert into card_authorizations (card_id, issuer_card_id, issuer_authorization_id, merchant_name, merchant_country, mcc,
                                          original_amount, original_currency, amount_xof, fee_xof, decision, decline_reason,
                                          ledger_transaction_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          card?.id ?? null, req.issuerCardId, req.issuerAuthorizationId, req.merchantName ?? null, req.merchantCountry ?? null,
          req.mcc ?? null, req.amount, req.currency, req.billingAmountXof, decline ? 0 : fee,
          decline ? 'declined' : 'approved', decline, ledgerTransactionId,
        ],
      );
      return { decision: decline ? { approved: false, reason: decline } : { approved: true }, card: card ?? null };
    });

    // Carte à usage unique : résiliée après le premier paiement accepté, le reste revient au portefeuille.
    if (result.decision.approved && result.card?.type === 'single_use') {
      await this.terminateCard(result.card).catch((err) =>
        this.logger.error(`résiliation après usage unique échouée ${result.card!.id} : ${(err as Error).message}`),
      );
    }
    return result.decision;
  }

  /** Annulation ou remboursement : le montant et les frais de change reviennent à l'utilisateur. */
  async reverse(evt: ReversalEvent): Promise<{ reversed: boolean }> {
    return this.db.tx(async (c) => {
      const res = await c.query<{
        id: string;
        card_id: string;
        decision: string;
        amount_xof: number;
        fee_xof: number;
        reversed_at: Date | null;
      }>('select * from card_authorizations where issuer_authorization_id = $1 for update', [evt.issuerAuthorizationId]);
      const auth = res.rows[0];
      if (!auth || auth.decision !== 'approved' || auth.reversed_at) return { reversed: false };

      const card = await c.query<{ user_id: string; status: string; ledger_account_id: string }>(
        'select user_id, status, ledger_account_id from cards where id = $1',
        [auth.card_id],
      );
      const { user_id: userId, status, ledger_account_id: cardAccount } = card.rows[0];
      // Carte résiliée entre-temps : on rembourse directement le portefeuille.
      const destination = status === 'terminated' ? await this.ledger.walletAccountId(c, userId) : cardAccount;
      await this.ledger.post(c, {
        kind: 'card_reversal',
        idempotencyKey: `reversal:${auth.id}`,
        userId,
        referenceId: auth.card_id,
        postings: [
          { accountId: await this.ledger.systemAccountId(c, SystemAccount.issuerPayable), direction: 'D', amount: auth.amount_xof },
          { accountId: await this.ledger.systemAccountId(c, SystemAccount.feesRevenue), direction: 'D', amount: auth.fee_xof },
          { accountId: destination, direction: 'C', amount: auth.amount_xof + auth.fee_xof },
        ],
      });
      await c.query('update card_authorizations set reversed_at = now() where id = $1', [auth.id]);
      return { reversed: true };
    });
  }

  async authorizations(userId: string, cardId: string, limit = 50) {
    await this.owned(this.db.pool, userId, cardId);
    const rows = await this.db.query(
      `select id, merchant_name, merchant_country, original_amount, original_currency, amount_xof, fee_xof,
              decision, decline_reason, reversed_at, created_at
         from card_authorizations where card_id = $1 order by created_at desc limit $2`,
      [cardId, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      merchant: r.merchant_name,
      merchantCountry: r.merchant_country,
      originalAmount: r.original_amount,
      originalCurrency: r.original_currency,
      amountXof: r.amount_xof,
      feeXof: r.fee_xof,
      status: r.decision === 'declined' ? 'declined' : r.reversed_at ? 'reversed' : 'approved',
      declineReason: r.decline_reason,
      createdAt: r.created_at,
    }));
  }

  // --- interne ---------------------------------------------------------------

  private async terminateCard(card: CardRow) {
    await this.issuer.setStatus(card.issuer_card_id, 'terminated');
    await this.db.tx(async (c) => {
      const locked = await c.query<{ status: string }>('select status from cards where id = $1 for update', [card.id]);
      if (locked.rows[0].status === 'terminated') return;
      await c.query(`update cards set status = 'terminated', terminated_at = now(), updated_at = now() where id = $1`, [card.id]);
      const balance = await this.ledger.balance(c, card.ledger_account_id);
      if (balance > 0) {
        await this.ledger.post(c, {
          kind: 'card_unload',
          idempotencyKey: `card-close:${card.id}`,
          userId: card.user_id,
          referenceId: card.id,
          metadata: { reason: 'terminated' },
          postings: [
            { accountId: card.ledger_account_id, direction: 'D', amount: balance },
            { accountId: await this.ledger.walletAccountId(c, card.user_id), direction: 'C', amount: balance },
          ],
        });
      }
    });
  }

  private async owned(c: Queryable, userId: string, cardId: string): Promise<CardRow> {
    const res = await c.query<CardRow>(`select ${CARD_COLUMNS} from cards c where c.id = $1 and c.user_id = $2`, [cardId, userId]);
    if (!res.rows[0]) throw Errors.notFound('Carte');
    return res.rows[0];
  }

  private async present(c: Queryable, card: CardRow) {
    return present(card, await this.ledger.balance(c, card.ledger_account_id));
  }
}

function present(card: CardRow, balance: number) {
  return {
    id: card.id,
    type: card.type,
    label: card.label,
    last4: card.last4,
    expiry: `${String(card.expiry_month).padStart(2, '0')}/${String(card.expiry_year).slice(-2)}`,
    status: card.status,
    balance,
    monthlyLimit: card.monthly_limit,
    createdAt: card.created_at,
    terminatedAt: card.terminated_at,
  };
}

function toDecision(decision: string, reason: string | null): Decision {
  return decision === 'approved' ? { approved: true } : { approved: false, reason: reason ?? 'declined' };
}
