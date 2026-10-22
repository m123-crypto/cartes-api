import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentUser, IdempotencyKey } from '../common/decorators';
import { DomainError } from '../common/errors';
import { CARD_TYPES } from '../common/pricing';
import { ZodPipe } from '../common/zod.pipe';
import { JwtAuthGuard } from '../auth/guards';
import { CARD_ISSUER, CardIssuer } from './issuer.provider';
import { CardsService } from './cards.service';

const CreateCard = z.object({
  type: z.enum(CARD_TYPES),
  label: z.string().trim().min(1).max(40).optional(),
  monthlyLimit: z.number().int().positive().optional(),
});
const Amount = z.object({ amount: z.number().int().positive() });
const Limit = z.object({ monthlyLimit: z.number().int().positive().nullable() });

@Controller('cards')
@UseGuards(JwtAuthGuard)
export class CardsController {
  constructor(private readonly cards: CardsService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @IdempotencyKey() key: string, @Body(new ZodPipe(CreateCard)) body: z.infer<typeof CreateCard>) {
    return this.cards.create(user.id, body, key);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.cards.list(user.id);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.cards.get(user.id, id);
  }

  @Get(':id/authorizations')
  authorizations(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.cards.authorizations(user.id, id);
  }

  @Post(':id/load')
  @HttpCode(200)
  load(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string,
    @Body(new ZodPipe(Amount)) body: z.infer<typeof Amount>,
  ) {
    return this.cards.load(user.id, id, body.amount, key);
  }

  @Post(':id/unload')
  @HttpCode(200)
  unload(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string,
    @Body(new ZodPipe(Amount)) body: z.infer<typeof Amount>,
  ) {
    return this.cards.unload(user.id, id, body.amount, key);
  }

  @Post(':id/freeze')
  @HttpCode(200)
  freeze(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.cards.setFrozen(user.id, id, true);
  }

  @Post(':id/unfreeze')
  @HttpCode(200)
  unfreeze(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.cards.setFrozen(user.id, id, false);
  }

  @Patch(':id/limit')
  limit(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Limit)) body: z.infer<typeof Limit>) {
    return this.cards.updateLimit(user.id, id, body.monthlyLimit);
  }

  @Post(':id/reveal')
  @HttpCode(200)
  reveal(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.cards.revealSession(user.id, id);
  }

  @Delete(':id')
  terminate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.cards.terminate(user.id, id);
  }
}

/** Webhook temps réel de l'émetteur : autorisations et annulations, authentifiées par signature. */
@Controller('webhooks')
export class IssuerWebhookController {
  constructor(
    private readonly cards: CardsService,
    @Inject(CARD_ISSUER) private readonly issuer: CardIssuer,
  ) {}

  @Post('issuer')
  @HttpCode(200)
  async receive(@Req() req: RawBodyRequest<Request>) {
    const event = this.issuer.parseWebhook(req.headers, req.rawBody);
    if (!event) throw new DomainError('invalid_signature', 'Signature de webhook invalide', 401);
    return event.type === 'authorization' ? this.cards.authorize(event) : this.cards.reverse(event);
  }
}
