import 'reflect-metadata';
import { INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfig, loadConfig, loadEnvFile } from './config/config';
import { AllExceptionsFilter } from './common/http-exception.filter';

/** Configuration commune au serveur et aux tests e2e. */
export function configureApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  const http = app.getHttpAdapter().getInstance();
  http.disable('x-powered-by');
  http.set('trust proxy', 1);
  return app;
}

export async function createApp(cfg: AppConfig): Promise<INestApplication> {
  // rawBody : nécessaire pour vérifier la signature des webhooks sur le corps exact reçu.
  const app = await NestFactory.create(AppModule.forRoot(cfg), { rawBody: true, logger: ['error', 'warn', 'log'] });
  return configureApp(app);
}

async function bootstrap() {
  loadEnvFile();
  const cfg = loadConfig();
  const app = await createApp(cfg);
  await app.listen(cfg.PORT);
  const logger = new Logger('Bootstrap');
  logger.log(`API démarrée sur http://localhost:${cfg.PORT}/v1 (${cfg.NODE_ENV})`);
  if (cfg.SANDBOX) logger.warn('Mode bac à sable actif : routes /v1/sandbox/* ouvertes');
}

if (require.main === module) {
  bootstrap().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
