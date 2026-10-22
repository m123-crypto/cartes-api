import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbService, Queryable } from '../db/db.service';
import { LedgerService, SystemAccount } from '../ledger/ledger.service';
import { DomainError, Errors } from '../common/errors';
import { AMOUNTS, Operator, tierLimits, topupFee, withdrawalFee } from '../common/pricing';
import { normalizePhone } from '../common/phone';
import { MOMO_PROVIDER, MomoProvider, MomoWebhookEvent } from './momo.provider';

interface OperationRow {
  id: string;
  user_id: string;
  direction: 'collection' | 'disbursement';
  operator: Operator;
  msisdn: string;
  amount: number;
  fee: number;
  status: 'pending' | 'succeeded' | 'failed';
  provider_reference: string | null;
  failure_reason: string | null;
  created_at: Date;
  completed_at: Date | null;
}

export interface MomoInput {
  operator: Operator;
  msisdn?: string;
  amount: number;
}

/**
 * Recharges (mobile money -> portefeuille) et retraits (portefeuille -> mobile money).
 *
 * Recharge : rien n'est crédité avant le webhook de succès de l'opérateur.
 * Retrait  : le montant est bloqué dans le grand livre AVANT l'appel à l'opérateur,
 *            puis réglé (succès) ou rendu à l'utilisateur (échec).
 */
@Injectable()
export class MomoService {
  private readonly logger = new Logger('MobileMoney');

  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
    @Inject(MOMO_PROVIDER) private readonly provider: MomoProvider,
  ) {}

  // --- Recharges -------------------------------------------------------------

  async initiateTopup(userId: string, input: MomoInput, idempotencyKey: string) {
    if (input.amount < AMOUNTS.topupMin || input.amount > AMOUNTS.topupMax) {
      throw new DomainError('invalid_amount', `Montant entre ${AMOUNTS.topupMin} et ${AMOUNTS.topupMax} FCFA`, 400);
    }
    const { op, isNew } = await this.db.tx(async (c) => {
      const existing = await this.findByIdempotencyKey(c, userId, idempotencyKey);
      if (existing) return { op: existing, isNew: false };

      const user = await this.lockUser(c, userId);
      const limits = tierLimits(user.kyc_tier);
      if (user.kyc_tier < 1) throw Errors.kycRequired(1);
      const monthTotal = await this.monthlyCollections(c, userId);
      if (monthTotal + input.amount > limits.monthlyTopups) {
        throw Errors.limitExceeded('monthly_topups', limits.monthlyTopups);
      }
      const holdings = await this.ledger.userHoldings(c, userId);
      if (holdings + input.amount > limits.maxHoldings) throw Errors.limitExceeded('max_holdings', limits.maxHoldings);

      const msisdn = this.msisdn(input.msisdn ?? user.phone);
      const res = await c.query<OperationRow>(
        `insert into momo_operations (user_id, direction, operator, msisdn, amount, fee, idempotency_key)
         values ($1, 'collection', $2, $3, $4, $5, $6) returning *`,
        [userId, input.operator, msisdn, input.amount, topupFee(input.amount), idempotencyKey],
      );
      return { op: res.rows[0], isNew: true };
    });
    if (!isNew) return present(op);

    try {
      const started = await this.provider.initiateCollection({
        operationId: op.id,
        operator: op.operator,
        msisdn: op.msisdn,
        amount: op.amount,
      });
      const updated = await this.setReference(op.id, started.providerReference);
      return { ...present(updated), instructions: started.instructions };
    } catch (err) {
      this.logger.error(`échec de la demande de paiement ${op.id} : ${(err as Error).message}`);
      await this.markFailed(this.db.pool, op.id, 'provider_error');
      throw Errors.providerUnavailable();
    }
  }

  // --- Retraits --------------------------------------------------------------

  async initiateWithdrawal(userId: string, input: MomoInput, idempotencyKey: string) {
    if (input.amount < AMOUNTS.withdrawalMin) {
      throw new DomainError('invalid_amount', `Retrait minimum : ${AMOUNTS.withdrawalMin} FCFA`, 400);
    }
    const { op, isNew } = await this.db.tx(async (c) => {
      const existing = await this.findByIdempotencyKey(c, userId, idempotencyKey);
      if (existing) return { op: existing, isNew: false };

      const user = await this.lockUser(c, userId);
      if (user.kyc_tier < 1) throw Errors.kycRequired(1);
      const msisdn = this.msisdn(input.msisdn ?? user.phone);
      const fee = withdrawalFee(input.amount);
      const res = await c.query<OperationRow>(
        `insert into momo_operations (user_id, direction, operator, msisdn, amount, fee, idempotency_key)
         values ($1, 'disbursement', $2, $3, $4, $5, $6) returning *`,
        [userId, input.operator, msisdn, input.amount, fee, idempotencyKey],
      );
      const op = res.rows[0];
      const wallet = await this.ledger.walletAccountId(c, userId);
      // Blocage : montant + frais quittent le portefeuille (refusé par la base si solde insuffisant).
      await this.ledger.post(c, {
        kind: 'withdrawal_hold',
        idempotencyKey: `withdrawal-hold:${op.id}`,
        userId,
        referenceId: op.id,
        metadata: { operator: op.operator, fee },
        postings: [
          { accountId: wallet, direction: 'D', amount: op.amount + fee },
          { accountId: await this.ledger.systemAccountId(c, SystemAccount.withdrawalsInFlight), direction: 'C', amount: op.amount },
          { accountId: await this.ledger.systemAccountId(c, SystemAccount.feesRevenue), direction: 'C', amount: fee },
        ],
      });
      return { op, isNew: true };
    });
    if (!isNew) return present(op);

    try {
      const started = await this.provider.initiateDisbursement({
        operationId: op.id,
        operator: op.operator,
        msisdn: op.msisdn,
        amount: op.amount,
      });
      return present(await this.setReference(op.id, started.providerReference));
    } catch (err) {
      this.logger.error(`échec de l'envoi ${op.id} : ${(err as Error).message}`);
      await this.db.tx((c) => this.releaseWithdrawal(c, op, 'provider_error'));
      throw Errors.providerUnavailable();
    }
  }

  // --- Webhooks --------------------------------------------------------------

  /** Traite un webhook déjà authentifié. Idempotent : un webhook reçu deux fois ne fait rien de plus. */
  async handleWebhook(event: MomoWebhookEvent): Promise<{ operationId: string; status: string }> {
    return this.db.tx(async (c) => {
      const res = await c.query<OperationRow>('select * from momo_operations where provider_reference = $1 for update', [
        event.providerReference,
      ]);
      const op = res.rows[0];
      if (!op) throw Errors.notFound('Opération');
      if (op.status !== 'pending') return { operationId: op.id, status: op.status };

      if (event.status === 'succeeded' && event.amount !== undefined && event.amount !== op.amount) {
        await c.query(
          `insert into audit_log (actor, action, target_type, target_id, details) values ('momo-webhook', 'amount_mismatch', 'momo_operation', $1, $2)`,
          [op.id, JSON.stringify({ expected: op.amount, received: event.amount })],
        );
        this.logger.warn(`montant différent pour ${op.id} : attendu ${op.amount}, reçu ${event.amount}`);
        await this.failOperation(c, op, 'amount_mismatch');
        return { operationId: op.id, status: 'failed' };
      }

      if (event.status === 'succeeded') {
        if (op.direction === 'collection') await this.creditTopup(c, op);
        else await this.settleWithdrawal(c, op);
        await c.query(
          `update momo_operations set status = 'succeeded', completed_at = now(), updated_at = now() where id = $1`,
          [op.id],
        );
        return { operationId: op.id, status: 'succeeded' };
      }

      await this.failOperation(c, op, event.failureReason ?? 'operator_declined');
      return { operationId: op.id, status: 'failed' };
    });
  }

  async get(userId: string, operationId: string) {
    const op = await this.db.one<OperationRow>('select * from momo_operations where id = $1 and user_id = $2', [operationId, userId]);
    if (!op) throw Errors.notFound('Opération');
    return present(op);
  }

  // --- interne ---------------------------------------------------------------

  private async creditTopup(c: Queryable, op: OperationRow) {
    const wallet = await this.ledger.walletAccountId(c, op.user_id);
    await this.ledger.post(c, {
      kind: 'topup',
      idempotencyKey: `topup:${op.id}`,
      userId: op.user_id,
      referenceId: op.id,
      metadata: { operator: op.operator, fee: op.fee },
      postings: [
        { accountId: await this.ledger.systemAccountId(c, SystemAccount.momoFloat(op.operator)), direction: 'D', amount: op.amount },
        { accountId: wallet, direction: 'C', amount: op.amount - op.fee },
        { accountId: await this.ledger.systemAccountId(c, SystemAccount.feesRevenue), direction: 'C', amount: op.fee },
      ],
    });
  }

  private async settleWithdrawal(c: Queryable, op: OperationRow) {
    await this.ledger.post(c, {
      kind: 'withdrawal_settle',
      idempotencyKey: `withdrawal-settle:${op.id}`,
      userId: op.user_id,
      referenceId: op.id,
      postings: [
        { accountId: await this.ledger.systemAccountId(c, SystemAccount.withdrawalsInFlight), direction: 'D', amount: op.amount },
        { accountId: await this.ledger.systemAccountId(c, SystemAccount.momoFloat(op.operator)), direction: 'C', amount: op.amount },
      ],
    });
  }

  /** Échec d'un retrait : montant et frais reviennent au portefeuille. */
  private async releaseWithdrawal(c: Queryable, op: OperationRow, reason: string) {
    const wallet = await this.ledger.walletAccountId(c, op.user_id);
    await this.ledger.post(c, {
      kind: 'withdrawal_release',
      idempotencyKey: `withdrawal-release:${op.id}`,
      userId: op.user_id,
      referenceId: op.id,
      metadata: { reason },
      postings: [
        { accountId: await this.ledger.systemAccountId(c, SystemAccount.withdrawalsInFlight), direction: 'D', amount: op.amount },
        { accountId: await this.ledger.systemAccountId(c, SystemAccount.feesRevenue), direction: 'D', amount: op.fee },
        { accountId: wallet, direction: 'C', amount: op.amount + op.fee },
      ],
    });
    await this.markFailed(c, op.id, reason);
  }

  private async failOperation(c: Queryable, op: OperationRow, reason: string) {
    if (op.direction === 'disbursement') await this.releaseWithdrawal(c, op, reason);
    else await this.markFailed(c, op.id, reason);
  }

  private async markFailed(c: Queryable, id: string, reason: string) {
    await c.query(
      `update momo_operations set status = 'failed', failure_reason = $2, completed_at = now(), updated_at = now()
        where id = $1 and status = 'pending'`,
      [id, reason],
    );
  }

  private async setReference(id: string, reference: string): Promise<OperationRow> {
    const op = await this.db.one<OperationRow>(
      'update momo_operations set provider_reference = $2, updated_at = now() where id = $1 returning *',
      [id, reference],
    );
    return op!;
  }

  private async findByIdempotencyKey(c: Queryable, userId: string, key: string) {
    const res = await c.query<OperationRow>('select * from momo_operations where user_id = $1 and idempotency_key = $2', [userId, key]);
    return res.rows[0];
  }

  /** Verrouille l'utilisateur : deux demandes simultanées ne peuvent pas contourner les plafonds. */
  private async lockUser(c: Queryable, userId: string) {
    const res = await c.query<{ kyc_tier: number; phone: string; status: string }>(
      'select kyc_tier, phone, status from users where id = $1 for update',
      [userId],
    );
    const user = res.rows[0];
    if (!user) throw Errors.notFound('Utilisateur');
    if (user.status !== 'active') throw new DomainError('account_inactive', 'Compte suspendu', 403);
    return user;
  }

  private async monthlyCollections(c: Queryable, userId: string): Promise<number> {
    const res = await c.query<{ total: number }>(
      `select coalesce(sum(amount), 0)::bigint as total from momo_operations
        where user_id = $1 and direction = 'collection' and status in ('pending', 'succeeded')
          and created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'`,
      [userId],
    );
    return res.rows[0].total;
  }

  private msisdn(raw: string): string {
    const phone = normalizePhone(raw);
    if (!phone) throw new DomainError('invalid_phone', 'Numéro mobile money invalide', 400);
    return phone;
  }
}

function present(op: OperationRow) {
  return {
    id: op.id,
    type: op.direction === 'collection' ? 'topup' : 'withdrawal',
    operator: op.operator,
    msisdn: op.msisdn,
    amount: op.amount,
    fee: op.fee,
    netAmount: op.direction === 'collection' ? op.amount - op.fee : op.amount,
    totalDebited: op.direction === 'disbursement' ? op.amount + op.fee : undefined,
    status: op.status,
    reference: op.provider_reference,
    failureReason: op.failure_reason,
    createdAt: op.created_at,
    completedAt: op.completed_at,
  };
}
