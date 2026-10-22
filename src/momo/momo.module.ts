import { Module } from '@nestjs/common';
import { MomoController, MomoWebhookController } from './momo.controller';
import { MOMO_PROVIDER, SandboxMomoProvider } from './momo.provider';
import { MomoService } from './momo.service';

@Module({
  controllers: [MomoController, MomoWebhookController],
  providers: [
    MomoService,
    // Remplacer par l'adaptateur de l'agrégateur choisi lors de l'intégration réelle.
    { provide: MOMO_PROVIDER, useClass: SandboxMomoProvider },
  ],
  exports: [MomoService, MOMO_PROVIDER],
})
export class MomoModule {}
