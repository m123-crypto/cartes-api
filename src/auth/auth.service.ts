import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { AppConfig, CONFIG } from '../config/config';
import { DbService, Queryable } from '../db/db.service';
import { LedgerService } from '../ledger/ledger.service';
import { DomainError } from '../common/errors';
import { normalizePhone } from '../common/phone';
import { pinWeakness } from './pin';
import { SMS_PROVIDER, SmsProvider } from './sms.provider';

const OTP_TTL_SECONDS = 300;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_REQUESTS_PER_10_MIN = 3;
const PIN_MAX_FAILURES = 5;
const PIN_LOCK_MINUTES = 15;

interface OtpTokenPayload {
  sub: string; // téléphone
  typ: 'otp';
  dev: string; // identifiant de l'appareil
  jti: string; // id du défi OTP
}

interface AccessTokenPayload {
  sub: string; // id utilisateur
  typ: 'access';
  did: string; // id de la ligne devices
}

export interface Tokens {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
}

const invalidCredentials = () => new DomainError('invalid_credentials', 'Numéro ou code PIN incorrect', 401);

/**
 * Parcours d'authentification :
 *  1. requestOtp(téléphone)            -> SMS avec un code à 6 chiffres
 *  2. verifyOtp(défi, code, appareil)  -> jeton OTP (10 min, usage unique)
 *  3a. nouvel utilisateur ou PIN oublié : setPin(jeton OTP, PIN)  -> jetons de session
 *  3b. nouvel appareil : login(téléphone, PIN, appareil, jeton OTP) -> jetons de session
 *  Ensuite, sur un appareil connu : login(téléphone, PIN, appareil).
 */
@Injectable()
export class AuthService {
  /** Empreinte d'un PIN aléatoire, vérifiée quand le compte n'existe pas (temps de réponse égal). */
  private readonly dummyHash = argon2.hash(randomBytes(16).toString('hex'), { type: argon2.argon2id });

  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    private readonly db: DbService,
    private readonly ledger: LedgerService,
    private readonly jwt: JwtService,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
  ) {}

  async requestOtp(rawPhone: string) {
    const phone = this.phoneOrThrow(rawPhone);
    const recent = await this.db.one<{ n: number }>(
      `select count(*)::int as n from otp_challenges where phone = $1 and created_at > now() - interval '10 minutes'`,
      [phone],
    );
    if ((recent?.n ?? 0) >= OTP_MAX_REQUESTS_PER_10_MIN) {
      throw new DomainError('otp_rate_limited', 'Trop de demandes de code. Réessayez dans 10 minutes.', 429);
    }
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const row = await this.db.one<{ id: string }>(
      `insert into otp_challenges (phone, code_hash, expires_at)
       values ($1, $2, now() + make_interval(secs => $3)) returning id`,
      [phone, this.otpHash(phone, code), OTP_TTL_SECONDS],
    );
    await this.sms.send(phone, `Votre code de vérification : ${code}. Ne le communiquez à personne.`);
    return {
      challengeId: row!.id,
      expiresInSeconds: OTP_TTL_SECONDS,
      ...(this.cfg.OTP_DEV_ECHO ? { devCode: code } : {}),
    };
  }

  async verifyOtp(challengeId: string, code: string, deviceId: string) {
    // L'incrément de tentatives est enregistré même si le code est faux.
    const challenge = await this.db.one<{ phone: string; code_hash: string }>(
      `update otp_challenges set attempts = attempts + 1
        where id = $1 and consumed_at is null and expires_at > now() and attempts < $2
        returning phone, code_hash`,
      [challengeId, OTP_MAX_ATTEMPTS],
    );
    if (!challenge) throw new DomainError('otp_invalid', 'Code expiré ou trop de tentatives. Demandez un nouveau code.', 401);
    if (!safeEqualHex(challenge.code_hash, this.otpHash(challenge.phone, code))) {
      throw new DomainError('otp_invalid', 'Code incorrect', 401);
    }
    const consumed = await this.db.one(
      'update otp_challenges set consumed_at = now() where id = $1 and consumed_at is null returning id',
      [challengeId],
    );
    if (!consumed) throw new DomainError('otp_invalid', 'Code déjà utilisé', 401);

    const user = await this.db.one<{ id: string; pin_hash: string | null }>('select id, pin_hash from users where phone = $1', [
      challenge.phone,
    ]);
    const payload: OtpTokenPayload = { sub: challenge.phone, typ: 'otp', dev: deviceId, jti: challengeId };
    return {
      otpToken: await this.jwt.signAsync(payload, { expiresIn: '10m' }),
      hasAccount: Boolean(user?.pin_hash),
    };
  }

  /** Création du compte ou réinitialisation du PIN, après vérification par SMS. */
  async setPin(otpToken: string, pin: string, deviceId: string, deviceLabel?: string): Promise<Tokens & { userId: string }> {
    const weakness = pinWeakness(pin);
    if (weakness) throw new DomainError('weak_pin', weakness, 400);
    const otp = await this.consumeOtpToken(otpToken, deviceId);
    const pinHash = await argon2.hash(pin, { type: argon2.argon2id });

    return this.db.tx(async (c) => {
      const user = await c.query<{ id: string }>(
        `insert into users (phone, pin_hash) values ($1, $2)
         on conflict (phone) do update
           set pin_hash = excluded.pin_hash, pin_failed_attempts = 0, pin_locked_until = null, updated_at = now()
         returning id`,
        [otp.sub, pinHash],
      );
      const userId = user.rows[0].id;
      await this.ledger.walletAccountId(c, userId);
      // Un changement de PIN déconnecte toutes les autres sessions.
      await c.query('update refresh_tokens set revoked_at = now() where user_id = $1 and revoked_at is null', [userId]);
      const device = await this.trustDevice(c, userId, deviceId, deviceLabel);
      const tokens = await this.issueTokens(c, userId, device);
      return { userId, ...tokens };
    });
  }

  async login(rawPhone: string, pin: string, deviceId: string, otpToken?: string, deviceLabel?: string): Promise<Tokens> {
    const phone = this.phoneOrThrow(rawPhone);
    const user = await this.db.one<{
      id: string;
      pin_hash: string | null;
      status: string;
      locked: boolean;
    }>(
      `select id, pin_hash, status, coalesce(pin_locked_until > now(), false) as locked from users where phone = $1`,
      [phone],
    );
    if (!user?.pin_hash) {
      // Même coût qu'une vraie vérification pour ne pas révéler l'existence du compte.
      await argon2.verify(await this.dummyHash, pin).catch(() => false);
      throw invalidCredentials();
    }
    if (user.locked) {
      throw new DomainError('pin_locked', `Trop d'essais. Réessayez dans ${PIN_LOCK_MINUTES} minutes ou réinitialisez votre code.`, 423);
    }
    if (user.status !== 'active') throw new DomainError('account_inactive', 'Compte suspendu. Contactez le support.', 403);

    if (!(await argon2.verify(user.pin_hash, pin))) {
      await this.db.query(
        `update users set
           pin_failed_attempts = case when pin_failed_attempts + 1 >= $2 then 0 else pin_failed_attempts + 1 end,
           pin_locked_until = case when pin_failed_attempts + 1 >= $2 then now() + make_interval(mins => $3) else pin_locked_until end
         where id = $1`,
        [user.id, PIN_MAX_FAILURES, PIN_LOCK_MINUTES],
      );
      throw invalidCredentials();
    }

    const known = await this.db.one<{ id: string }>(
      'select id from devices where user_id = $1 and device_id = $2 and revoked_at is null',
      [user.id, deviceId],
    );
    if (!known && !otpToken) {
      throw new DomainError('device_not_trusted', 'Nouvel appareil : confirmez avec le code reçu par SMS', 403);
    }
    if (!known && otpToken) {
      const otp = await this.consumeOtpToken(otpToken, deviceId);
      if (otp.sub !== phone) throw new DomainError('otp_invalid', 'Code de vérification invalide pour ce numéro', 401);
    }

    return this.db.tx(async (c) => {
      await c.query('update users set pin_failed_attempts = 0, pin_locked_until = null where id = $1', [user.id]);
      const device = known ? { id: known.id } : await this.trustDevice(c, user.id, deviceId, deviceLabel);
      await c.query('update devices set last_seen_at = now() where id = $1', [device.id]);
      return this.issueTokens(c, user.id, device);
    });
  }

  /**
   * Rotation du jeton de rafraîchissement. Présenter un jeton déjà utilisé signale un vol
   * probable : toutes les sessions de l'appareil sont alors révoquées.
   */
  async refresh(refreshToken: string): Promise<Tokens> {
    const hash = sha256(refreshToken);
    return this.db.tx(async (c) => {
      const res = await c.query<{
        id: string;
        user_id: string;
        device_id: string;
        revoked_at: Date | null;
        expired: boolean;
      }>(
        `select id, user_id, device_id, revoked_at, expires_at <= now() as expired
           from refresh_tokens where token_hash = $1 for update`,
        [hash],
      );
      const row = res.rows[0];
      if (!row) throw new DomainError('invalid_refresh_token', 'Session expirée, reconnectez-vous', 401);
      if (row.revoked_at) {
        await c.query('update refresh_tokens set revoked_at = now() where device_id = $1 and revoked_at is null', [row.device_id]);
        // Le COMMIT doit avoir lieu pour que la révocation soit conservée : on renvoie une
        // erreur différée plutôt que de lever ici (ce qui annulerait la transaction).
        return null;
      }
      if (row.expired) throw new DomainError('invalid_refresh_token', 'Session expirée, reconnectez-vous', 401);
      const device = await c.query<{ revoked_at: Date | null }>('select revoked_at from devices where id = $1', [row.device_id]);
      if (device.rows[0]?.revoked_at) throw new DomainError('invalid_refresh_token', 'Appareil déconnecté', 401);

      const tokens = await this.issueTokens(c, row.user_id, { id: row.device_id });
      await c.query(
        `update refresh_tokens set revoked_at = now(), replaced_by = (select id from refresh_tokens where token_hash = $2)
          where id = $1`,
        [row.id, sha256(tokens.refreshToken)],
      );
      return tokens;
    }).then((tokens) => {
      if (!tokens) throw new DomainError('invalid_refresh_token', 'Session révoquée, reconnectez-vous', 401);
      return tokens;
    });
  }

  async logout(userId: string, deviceRowId: string): Promise<void> {
    await this.db.query('update refresh_tokens set revoked_at = now() where user_id = $1 and device_id = $2 and revoked_at is null', [
      userId,
      deviceRowId,
    ]);
  }

  async verifyAccessToken(token: string): Promise<{ userId: string; deviceId: string }> {
    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
    } catch {
      throw new DomainError('unauthorized', 'Session invalide ou expirée', 401);
    }
    if (payload.typ !== 'access') throw new DomainError('unauthorized', 'Session invalide', 401);
    const ok = await this.db.one(
      `select 1 from users u join devices d on d.user_id = u.id
        where u.id = $1 and d.id = $2 and u.status = 'active' and d.revoked_at is null`,
      [payload.sub, payload.did],
    );
    if (!ok) throw new DomainError('unauthorized', 'Session révoquée', 401);
    return { userId: payload.sub, deviceId: payload.did };
  }

  // ---------------------------------------------------------------------------

  private async consumeOtpToken(token: string, deviceId: string): Promise<OtpTokenPayload> {
    let payload: OtpTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<OtpTokenPayload>(token);
    } catch {
      throw new DomainError('otp_invalid', 'Vérification expirée, demandez un nouveau code', 401);
    }
    if (payload.typ !== 'otp' || payload.dev !== deviceId) {
      throw new DomainError('otp_invalid', 'Vérification invalide pour cet appareil', 401);
    }
    const used = await this.db.one(
      'update otp_challenges set token_used_at = now() where id = $1 and token_used_at is null returning id',
      [payload.jti],
    );
    if (!used) throw new DomainError('otp_invalid', 'Vérification déjà utilisée', 401);
    return payload;
  }

  private async trustDevice(c: Queryable, userId: string, deviceId: string, label?: string): Promise<{ id: string }> {
    const res = await c.query<{ id: string }>(
      `insert into devices (user_id, device_id, label) values ($1, $2, $3)
       on conflict (user_id, device_id) do update
         set revoked_at = null, trusted_at = now(), last_seen_at = now(), label = coalesce(excluded.label, devices.label)
       returning id`,
      [userId, deviceId, label ?? null],
    );
    return res.rows[0];
  }

  private async issueTokens(c: Queryable, userId: string, device: { id: string }): Promise<Tokens> {
    const payload: AccessTokenPayload = { sub: userId, typ: 'access', did: device.id };
    const accessToken = await this.jwt.signAsync(payload, { expiresIn: this.cfg.ACCESS_TOKEN_TTL_SECONDS });
    const refreshToken = randomBytes(32).toString('base64url');
    await c.query(
      `insert into refresh_tokens (user_id, device_id, token_hash, expires_at)
       values ($1, $2, $3, now() + make_interval(days => $4))`,
      [userId, device.id, sha256(refreshToken), this.cfg.REFRESH_TOKEN_TTL_DAYS],
    );
    return { accessToken, accessTokenExpiresIn: this.cfg.ACCESS_TOKEN_TTL_SECONDS, refreshToken };
  }

  private otpHash(phone: string, code: string): string {
    return createHmac('sha256', this.cfg.OTP_SECRET).update(`${phone}:${code}`).digest('hex');
  }

  private phoneOrThrow(raw: string): string {
    const phone = normalizePhone(raw);
    if (!phone) throw new DomainError('invalid_phone', 'Numéro de téléphone invalide', 400);
    return phone;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}
