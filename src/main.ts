import 'reflect-metadata';
import { INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { join } from 'node:path';
import { AppModule } from './app.module';
import { AppConfig, loadConfig, loadEnvFile } from './config/config';
import { AllExceptionsFilter } from './common/http-exception.filter';

/** Dossier de l'interface web, valable depuis src/ (ts-node) comme depuis dist/ (build). */
export const WEB_DIR = join(__dirname, '..', 'web');

/** En-têtes de sécurité communs à l'API et à l'interface web. */
function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com',
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
  );
  next();
}

/** Configuration commune au serveur et aux tests e2e. */
export function configureApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  const http = app.getHttpAdapter().getInstance();
  http.disable('x-powered-by');
  http.set('trust proxy', 1);
  http.use(securityHeaders);
  // Interface web (fichiers statiques de web/), servie à la racine ; l'API reste sous /v1.
  (app as NestExpressApplication).useStaticAssets(WEB_DIR, { index: 'index.html', maxAge: '1h' });
  return app;
}

export async function createApp(cfg: AppConfig): Promise<INestApplication> {
  // rawBody : nécessaire pour vérifier la signature des webhooks sur le corps exact reçu.
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(cfg), { rawBody: true, logger: ['error', 'warn', 'log'] });
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
