import { Controller, Get, Module, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { JwtAuthGuard } from '../auth/guards';
import { DbService } from '../db/db.service';
import { LedgerService } from '../ledger/ledger.service';

const History = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /** Pagination : id de la dernière écriture reçue. */
  before: z.coerce.number().int().positive().optional(),
});

@Controller('wallet')
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
  ) {}

  @Get()
  async balance(@CurrentUser() user: AuthUser) {
    const wallet = await this.ledger.walletAccountId(this.db.pool, user.id);
    const [balance, holdings] = await Promise.all([
      this.ledger.balance(this.db.pool, wallet),
      this.ledger.userHoldings(this.db.pool, user.id),
    ]);
    return { currency: 'XOF', balance, onCards: holdings - balance, total: holdings };
  }

  /** Historique du portefeuille, du plus récent au plus ancien. */
  @Get('transactions')
  async history(@CurrentUser() user: AuthUser, @Query(new ZodPipe(History)) q: z.infer<typeof History>) {
    const wallet = await this.ledger.walletAccountId(this.db.pool, user.id);
    const rows = await this.db.query<{
      id: number;
      direction: 'D' | 'C';
      amount: number;
      kind: string;
      reference_id: string | null;
      metadata: Record<string, unknown>;
      created_at: Date;
    }>(
      `select e.id, e.direction, e.amount, t.kind, t.reference_id, t.metadata, e.created_at
         from ledger_entries e join ledger_transactions t on t.id = e.transaction_id
        where e.account_id = $1 and ($2::bigint is null or e.id < $2)
        order by e.id desc limit $3`,
      [wallet, q.before ?? null, q.limit],
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        amount: r.direction === 'C' ? r.amount : -r.amount,
        referenceId: r.reference_id,
        details: r.metadata,
        createdAt: r.created_at,
      })),
      nextBefore: rows.length === q.limit ? rows[rows.length - 1].id : null,
    };
  }
}

@Module({ controllers: [WalletController] })
export class WalletModule {}
