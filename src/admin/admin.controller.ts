import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import { DomainError, Errors } from '../common/errors';
import { AdminGuard } from '../auth/guards';
import { DbService } from '../db/db.service';

const KycList = z.object({ status: z.enum(['pending', 'approved', 'rejected']).default('pending') });
const Review = z.object({
  reviewer: z.string().trim().min(2).max(80),
  reason: z.string().trim().max(300).optional(),
});
const UserStatus = z.object({ reviewer: z.string().trim().min(2).max(80), status: z.enum(['active', 'frozen']), reason: z.string().max(300) });

/** Back-office minimal du MVP (validation KYC, gel de compte, contrôle du grand livre). */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly db: DbService) {}

  @Get('kyc')
  kyc(@Query(new ZodPipe(KycList)) q: z.infer<typeof KycList>) {
    return this.db.query(
      `select k.id, k.user_id, u.phone, u.first_name, u.last_name, k.tier, k.document_type, k.provider_reference,
              k.status, k.rejection_reason, k.created_at
         from kyc_submissions k join users u on u.id = k.user_id
        where k.status = $1 order by k.created_at limit 200`,
      [q.status],
    );
  }

  @Post('kyc/:id/approve')
  approve(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Review)) body: z.infer<typeof Review>) {
    return this.review(id, true, body);
  }

  @Post('kyc/:id/reject')
  reject(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Review)) body: z.infer<typeof Review>) {
    if (!body.reason) throw new DomainError('reason_required', 'Motif de refus obligatoire', 400);
    return this.review(id, false, body);
  }

  @Post('users/:id/status')
  async setUserStatus(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(UserStatus)) body: z.infer<typeof UserStatus>) {
    return this.db.tx(async (c) => {
      const res = await c.query('update users set status = $2, updated_at = now() where id = $1 returning id, status', [id, body.status]);
      if (!res.rows[0]) throw Errors.notFound('Utilisateur');
      await c.query(
        `insert into audit_log (actor, action, target_type, target_id, details) values ($1, $2, 'user', $3, $4)`,
        [body.reviewer, `user_${body.status}`, id, JSON.stringify({ reason: body.reason })],
      );
      return res.rows[0];
    });
  }

  /** Rapprochement : soldes en cache contre écritures, et total des débits contre total des crédits. */
  @Get('ledger/check')
  async ledgerCheck() {
    const mismatches = await this.db.query('select * from ledger_balance_check where cached_balance <> computed_balance');
    const totals = await this.db.one<{ debits: number; credits: number }>(
      `select coalesce(sum(amount) filter (where direction = 'D'), 0)::bigint as debits,
              coalesce(sum(amount) filter (where direction = 'C'), 0)::bigint as credits
         from ledger_entries`,
    );
    const system = await this.db.query(`select code, balance from ledger_accounts where code like 'system:%' order by code`);
    return { ok: mismatches.length === 0 && totals!.debits === totals!.credits, mismatches, totals, systemAccounts: system };
  }

  private review(id: string, approved: boolean, body: z.infer<typeof Review>) {
    return this.db.tx(async (c) => {
      const res = await c.query<{ user_id: string; tier: number }>(
        `update kyc_submissions set status = $2, rejection_reason = $3, reviewed_by = $4, reviewed_at = now()
          where id = $1 and status = 'pending' returning user_id, tier`,
        [id, approved ? 'approved' : 'rejected', approved ? null : body.reason, body.reviewer],
      );
      const sub = res.rows[0];
      if (!sub) throw new DomainError('not_pending', 'Dossier introuvable ou déjà traité', 409);
      if (approved) {
        await c.query('update users set kyc_tier = greatest(kyc_tier, $2), updated_at = now() where id = $1', [sub.user_id, sub.tier]);
      }
      await c.query(
        `insert into audit_log (actor, action, target_type, target_id, details) values ($1, $2, 'kyc_submission', $3, $4)`,
        [body.reviewer, approved ? 'kyc_approved' : 'kyc_rejected', id, JSON.stringify({ tier: sub.tier, reason: body.reason ?? null })],
      );
      return { id, status: approved ? 'approved' : 'rejected', userId: sub.user_id, tier: sub.tier };
    });
  }
}

@Module({ controllers: [AdminController] })
export class AdminModule {}
