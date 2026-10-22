import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentUser, IdempotencyKey } from '../common/decorators';
import { DomainError } from '../common/errors';
import { OPERATORS } from '../common/pricing';
import { ZodPipe } from '../common/zod.pipe';
import { JwtAuthGuard } from '../auth/guards';
import { MOMO_PROVIDER, MomoProvider } from './momo.provider';
import { MomoService } from './momo.service';

const MomoBody = z.object({
  operator: z.enum(OPERATORS),
  amount: z.number().int().positive(),
  /** Numéro mobile money ; par défaut celui du compte. */
  msisdn: z.string().min(6).max(20).optional(),
});

@Controller()
@UseGuards(JwtAuthGuard)
export class MomoController {
  constructor(private readonly momo: MomoService) {}

  @Post('topups')
  topup(
    @CurrentUser() user: AuthUser,
    @IdempotencyKey() key: string,
    @Body(new ZodPipe(MomoBody)) body: z.infer<typeof MomoBody>,
  ) {
    return this.momo.initiateTopup(user.id, body, key);
  }

  @Post('withdrawals')
  withdraw(
    @CurrentUser() user: AuthUser,
    @IdempotencyKey() key: string,
    @Body(new ZodPipe(MomoBody)) body: z.infer<typeof MomoBody>,
  ) {
    return this.momo.initiateWithdrawal(user.id, body, key);
  }

  @Get('momo-operations/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.momo.get(user.id, id);
  }
}

/** Webhooks du fournisseur mobile money : authentifiés par signature, pas par jeton utilisateur. */
@Controller('webhooks')
export class MomoWebhookController {
  constructor(
    private readonly momo: MomoService,
    @Inject(MOMO_PROVIDER) private readonly provider: MomoProvider,
  ) {}

  @Post('momo')
  @HttpCode(200)
  async receive(@Req() req: RawBodyRequest<Request>) {
    const event = this.provider.parseWebhook(req.headers, req.rawBody);
    if (!event) throw new DomainError('invalid_signature', 'Signature de webhook invalide', 401);
    return this.momo.handleWebhook(event);
  }
}
