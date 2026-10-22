import { DynamicModule, Global, Module } from '@nestjs/common';
import { AppConfig, CONFIG } from './config';

@Global()
@Module({})
export class ConfigModule {
  static forRoot(cfg: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: CONFIG, useValue: cfg }],
      exports: [CONFIG],
    };
  }
}
