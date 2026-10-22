import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const secret = z.string().min(32, 'doit contenir au moins 32 caractères');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: secret,
  OTP_SECRET: secret,
  MOMO_WEBHOOK_SECRET: secret,
  ISSUER_WEBHOOK_SECRET: secret,
  ADMIN_API_KEY: secret,
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  OTP_DEV_ECHO: bool,
  SANDBOX: bool,
});

export type AppConfig = z.infer<typeof schema>;

export const CONFIG = Symbol('CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuration invalide — ${details}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production' && (cfg.SANDBOX || cfg.OTP_DEV_ECHO)) {
    throw new Error('SANDBOX et OTP_DEV_ECHO doivent être à false en production');
  }
  return cfg;
}

/** Charge le fichier .env s'il existe (Node >= 21.7), sans dépendance externe. */
export function loadEnvFile(path = '.env'): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // pas de fichier .env : on utilise les variables d'environnement déjà définies
  }
}
