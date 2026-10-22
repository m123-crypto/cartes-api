import { Body, Controller, HttpCode, Inject, Module, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppConfig, CONFIG } from '../config/config';
import { signedHeaders } from '../common/hmac';
import { DomainError, Errors } from '../common/errors';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.service';
import { MomoModule } from '../momo/momo.module';
import { MOMO_PROVIDER, MomoProvider } from '../momo/momo.provider';
import { MomoService } from '../momo/momo.service';
import { CardsModule } from '../cards/cards.module';
import { CARD_ISSUER, CardIssuer } from '../cards/issuer.provider';
import { CardsService } from '../cards/cards.service';

const Complete = z.object({
  status: z.enum(['succeeded', 'failed']).default('succeeded'),
  failureReason: z.string().max(100).optional(),
});

const Purchase = z.object({
  /** Montant en unités mineures de la devise (centimes pour USD/EUR, francs pour XOF). */
  amount: z.number().int().positive(),
  currency: z.enum(['XOF', 'USD', 'EUR']).default('XOF'),
  merchantName: z.string().max(80).default('Marchand test'),
  merchantCountry: z.string().length(2).default('SN'),
});

/** Taux fixes du bac à sable (le vrai taux vient de l'émetteur). */
const SANDBOX_RATES: Record<string, number> = { XOF: 1, USD: 600, EUR: 655.957 };

/**
 * Simulateurs, montés seulement si SANDBOX=true. Ils fabriquent de vrais webhooks signés
 * et les font passer par le même chemin que ceux des partenaires (vérification de signature incluse).
 */
@Controller('sandbox')
export class SandboxController {
  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    private readonly db: DbService,
    private readonly momo: MomoService,
    @Inject(MOMO_PROVIDER) private readonly momoProvider: MomoProvider,
    private readonly cards: CardsService,
    @Inject(CARD_ISSUER) private readonly issuer: CardIssuer,
  ) {}

  /** Simule la validation (ou le refus) d'une recharge ou d'un retrait par l'opérateur. */
  @Post('momo/:reference/complete')
  @HttpCode(200)
  async completeMomo(@Param('reference') reference: string, @Body(new ZodPipe(Complete)) body: z.infer<typeof Complete>) {
    const raw = JSON.stringify({ reference, status: body.status, failureReason: body.failureReason });
    const event = this.momoProvider.parseWebhook(signedHeaders(this.cfg.MOMO_WEBHOOK_SECRET, raw), Buffer.from(raw));
    if (!event) throw new DomainError('invalid_event', 'Événement simulé invalide', 400);
    return this.momo.handleWebhook(event);
  }

  /** Simule un paiement chez un marchand avec la carte. */
  @Post('cards/:id/purchase')
  @HttpCode(200)
  async purchase(@Param('id', ParseUUIDPipe) cardId: string, @Body(new ZodPipe(Purchase)) body: z.infer<typeof Purchase>) {
    const card = await this.db.one<{ issuer_card_id: string }>('select issuer_card_id from cards where id = $1', [cardId]);
    if (!card) throw Errors.notFound('Carte');
    const units = body.currency === 'XOF' ? body.amount : body.amount / 100;
    const authorizationId = `sbxauth_${randomUUID()}`;
    const raw = JSON.stringify({
      type: 'authorization',
      issuerAuthorizationId: authorizationId,
      issuerCardId: card.issuer_card_id,
      amount: body.amount,
      currency: body.currency,
      billingAmountXof: Math.round(units * SANDBOX_RATES[body.currency]),
      merchantName: body.merchantName,
      merchantCountry: body.merchantCountry,
    });
    const event = this.issuer.parseWebhook(signedHeaders(this.cfg.ISSUER_WEBHOOK_SECRET, raw), Buffer.from(raw));
    if (event?.type !== 'authorization') throw new DomainError('invalid_event', 'Paiement simulé invalide (montant converti nul ?)', 400);
    const decision = await this.cards.authorize(event);
    return { authorizationId, ...decision };
  }

  /** Simule l'annulation ou le remboursement d'un paiement. */
  @Post('authorizations/:authorizationId/reverse')
  @HttpCode(200)
  async reverse(@Param('authorizationId') authorizationId: string) {
    const raw = JSON.stringify({ type: 'reversal', issuerAuthorizationId: authorizationId });
    const event = this.issuer.parseWebhook(signedHeaders(this.cfg.ISSUER_WEBHOOK_SECRET, raw), Buffer.from(raw));
    if (event?.type !== 'reversal') throw new DomainError('invalid_event', 'Annulation simulée invalide', 400);
    return this.cards.reverse(event);
  }
}

@Module({
  imports: [MomoModule, CardsModule],
  controllers: [SandboxController],
})
export class SandboxModule {}
