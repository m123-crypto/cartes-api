import { Module } from '@nestjs/common';
import { CardsController, IssuerWebhookController } from './cards.controller';
import { CardsService } from './cards.service';
import { CARD_ISSUER, SandboxCardIssuer } from './issuer.provider';

@Module({
  controllers: [CardsController, IssuerWebhookController],
  providers: [
    CardsService,
    // Remplacer par l'adaptateur du partenaire émetteur une fois le contrat signé.
    { provide: CARD_ISSUER, useClass: SandboxCardIssuer },
  ],
  exports: [CardsService, CARD_ISSUER],
})
export class CardsModule {}
