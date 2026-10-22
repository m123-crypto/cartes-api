import { Controller, DynamicModule, Get, Inject, Module } from '@nestjs/common';
import { AppConfig, CONFIG } from './config/config';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { DbService } from './db/db.service';
import { LedgerModule } from './ledger/ledger.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { WalletModule } from './wallet/wallet.controller';
import { MomoModule } from './momo/momo.module';
import { CardsModule } from './cards/cards.module';
import { AdminModule } from './admin/admin.controller';
import { SandboxModule } from './sandbox/sandbox.controller';

@Controller('health')
class HealthController {
  constructor(
    private readonly db: DbService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** État du service ; sandbox indique à l'interface d'afficher les simulateurs. */
  @Get()
  async health() {
    await this.db.query('select 1');
    return { status: 'ok', sandbox: this.cfg.SANDBOX };
  }
}

@Module({})
export class AppModule {
  static forRoot(cfg: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(cfg),
        DbModule,
        LedgerModule,
        AuthModule,
        UsersModule,
        WalletModule,
        MomoModule,
        CardsModule,
        AdminModule,
        ...(cfg.SANDBOX ? [SandboxModule] : []),
      ],
      controllers: [HealthController],
    };
  }
}
