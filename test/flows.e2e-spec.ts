/**
 * Parcours complets contre une vraie base PostgreSQL (TEST_DATABASE_URL, vidée à chaque lancement).
 *   docker compose up -d && npm run test:e2e
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/main';
import { loadConfig } from '../src/config/config';
import { migrate } from '../src/db/migrate';
import { signedHeaders } from '../src/common/hmac';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://cartes:cartes@localhost:5432/cartes_test';
const ADMIN_KEY = 'a'.repeat(40);
const cfg = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL,
  JWT_SECRET: 'j'.repeat(40),
  OTP_SECRET: 'o'.repeat(40),
  MOMO_WEBHOOK_SECRET: 'm'.repeat(40),
  ISSUER_WEBHOOK_SECRET: 'i'.repeat(40),
  ADMIN_API_KEY: ADMIN_KEY,
  OTP_DEV_ECHO: 'true',
  SANDBOX: 'true',
});

let app: INestApplication;
let http: ReturnType<typeof request>;
let phoneCounter = 1000000;

const key = () => randomUUID();

async function resetDatabase() {
  const c = new Client({ connectionString: DATABASE_URL });
  await c.connect();
  await c.query('drop schema public cascade; create schema public;');
  await c.end();
  await migrate(DATABASE_URL, undefined, () => undefined);
}

/** Inscription complète : OTP, PIN, identité (palier 1), éventuellement palier 2 validé par le back-office. */
async function signUp(tier: 1 | 2 = 2) {
  const phone = `+22177${phoneCounter++}`;
  const deviceId = `device-${randomUUID()}`;
  const otp = await http.post('/v1/auth/otp/request').send({ phone }).expect(200);
  const verified = await http
    .post('/v1/auth/otp/verify')
    .send({ challengeId: otp.body.challengeId, code: otp.body.devCode, deviceId })
    .expect(200);
  expect(verified.body.hasAccount).toBe(false);
  const session = await http.post('/v1/auth/pin').send({ otpToken: verified.body.otpToken, pin: '402817', deviceId }).expect(200);
  const auth = { Authorization: `Bearer ${session.body.accessToken}` };
  await http.post('/v1/kyc/tier1').set(auth).send({ firstName: 'Awa', lastName: 'Diop', birthDate: '1995-04-12' }).expect(200);
  if (tier === 2) {
    const sub = await http.post('/v1/kyc/submissions').set(auth).send({ tier: 2, documentType: 'cni', providerReference: 'kyc-ref-1234' }).expect(201);
    await http.post(`/v1/admin/kyc/${sub.body.submissionId}/approve`).set('x-admin-key', ADMIN_KEY).send({ reviewer: 'ops-test' }).expect(201);
  }
  return { phone, deviceId, auth, session: session.body, userId: session.body.userId as string };
}

async function topUp(auth: Record<string, string>, amount: number) {
  const op = await http.post('/v1/topups').set(auth).set('Idempotency-Key', key()).send({ operator: 'wave', amount }).expect(201);
  await http.post(`/v1/sandbox/momo/${op.body.reference}/complete`).send({ status: 'succeeded' }).expect(200);
  return op.body;
}

async function wallet(auth: Record<string, string>) {
  return (await http.get('/v1/wallet').set(auth).expect(200)).body;
}

async function ledgerOk() {
  const res = await http.get('/v1/admin/ledger/check').set('x-admin-key', ADMIN_KEY).expect(200);
  expect(res.body.mismatches).toEqual([]);
  expect(res.body.totals.debits).toBe(res.body.totals.credits);
}

beforeAll(async () => {
  await resetDatabase();
  app = await createApp(cfg);
  await app.init();
  http = request(app.getHttpServer());
});

afterAll(async () => {
  await app?.close();
});

describe('authentification', () => {
  it('inscription, connexion, rotation et vol de jeton', async () => {
    const u = await signUp(1);
    await http.get('/v1/me').set(u.auth).expect(200);

    const login = await http.post('/v1/auth/login').send({ phone: u.phone, pin: '402817', deviceId: u.deviceId }).expect(200);
    const rotated = await http.post('/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(200);
    // Réutiliser l'ancien jeton = vol présumé : toutes les sessions de l'appareil tombent.
    await http.post('/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(401);
    await http.post('/v1/auth/refresh').send({ refreshToken: rotated.body.refreshToken }).expect(401);
  });

  it('refuse un appareil inconnu sans code SMS', async () => {
    const u = await signUp(1);
    const res = await http.post('/v1/auth/login').send({ phone: u.phone, pin: '402817', deviceId: 'unknown-device-123' }).expect(403);
    expect(res.body.error).toBe('device_not_trusted');
  });

  it('bloque le PIN après 5 erreurs', async () => {
    const u = await signUp(1);
    for (let i = 0; i < 5; i++) {
      await http.post('/v1/auth/login').send({ phone: u.phone, pin: '999990', deviceId: u.deviceId }).expect(401);
    }
    const res = await http.post('/v1/auth/login').send({ phone: u.phone, pin: '402817', deviceId: u.deviceId }).expect(423);
    expect(res.body.error).toBe('pin_locked');
  });

  it('refuse un PIN trop simple et un mauvais code OTP', async () => {
    const otp = await http.post('/v1/auth/otp/request').send({ phone: '+221770000999' }).expect(200);
    const wrong = otp.body.devCode === '000001' ? '000002' : '000001';
    await http.post('/v1/auth/otp/verify').send({ challengeId: otp.body.challengeId, code: wrong, deviceId: 'device-abcdef' }).expect(401);
    const ok = await http
      .post('/v1/auth/otp/verify')
      .send({ challengeId: otp.body.challengeId, code: otp.body.devCode, deviceId: 'device-abcdef' })
      .expect(200);
    const weak = await http.post('/v1/auth/pin').send({ otpToken: ok.body.otpToken, pin: '123456', deviceId: 'device-abcdef' }).expect(400);
    expect(weak.body.error).toBe('weak_pin');
  });
});

describe('recharge mobile money', () => {
  it('crédite le portefeuille seulement après confirmation, frais déduits', async () => {
    const u = await signUp();
    const op = await http.post('/v1/topups').set(u.auth).set('Idempotency-Key', key()).send({ operator: 'wave', amount: 50_000 }).expect(201);
    expect(op.body).toMatchObject({ status: 'pending', fee: 500, netAmount: 49_500 });
    expect((await wallet(u.auth)).balance).toBe(0);

    await http.post(`/v1/sandbox/momo/${op.body.reference}/complete`).send({ status: 'succeeded' }).expect(200);
    expect((await wallet(u.auth)).balance).toBe(49_500);

    // Webhook reçu une seconde fois : aucun double crédit.
    await http.post(`/v1/sandbox/momo/${op.body.reference}/complete`).send({ status: 'succeeded' }).expect(200);
    expect((await wallet(u.auth)).balance).toBe(49_500);
    await ledgerOk();
  });

  it('même clé d’idempotence = même opération', async () => {
    const u = await signUp();
    const k = key();
    const a = await http.post('/v1/topups').set(u.auth).set('Idempotency-Key', k).send({ operator: 'wave', amount: 1000 }).expect(201);
    const b = await http.post('/v1/topups').set(u.auth).set('Idempotency-Key', k).send({ operator: 'wave', amount: 1000 }).expect(201);
    expect(b.body.id).toBe(a.body.id);
  });

  it('refuse un webhook mal signé', async () => {
    const raw = JSON.stringify({ reference: 'x', status: 'succeeded' });
    await http
      .post('/v1/webhooks/momo')
      .set(signedHeaders('mauvais-secret-mauvais-secret-mauvais', raw))
      .send(raw)
      .expect(401);
  });

  it('applique le plafond du palier', async () => {
    const u = await signUp(1); // palier 1 : 200 000 FCFA détenus au maximum
    const res = await http.post('/v1/topups').set(u.auth).set('Idempotency-Key', key()).send({ operator: 'wave', amount: 300_000 }).expect(422);
    expect(res.body.error).toBe('limit_exceeded');
  });
});

describe('cartes', () => {
  it('création, chargement, paiement en dollars, annulation, résiliation', async () => {
    const u = await signUp();
    await topUp(u.auth, 100_000); // 99 000 crédités

    const card = await http.post('/v1/cards').set(u.auth).set('Idempotency-Key', key()).send({ type: 'multi', label: 'Meta Ads' }).expect(201);
    expect(card.body).toMatchObject({ type: 'multi', status: 'active', balance: 0 });
    expect((await wallet(u.auth)).balance).toBe(98_000); // 1 000 de frais de création

    await http.post(`/v1/cards/${card.body.id}/load`).set(u.auth).set('Idempotency-Key', key()).send({ amount: 30_000 }).expect(200);

    // 20 USD = 12 000 FCFA + 2,5 % de change = 12 300
    const ok = await http.post(`/v1/sandbox/cards/${card.body.id}/purchase`).send({ amount: 2000, currency: 'USD', merchantName: 'Meta' }).expect(200);
    expect(ok.body.approved).toBe(true);
    let detail = await http.get(`/v1/cards/${card.body.id}`).set(u.auth).expect(200);
    expect(detail.body.balance).toBe(30_000 - 12_300);

    // Achat trop cher : refusé, solde intact.
    const ko = await http.post(`/v1/sandbox/cards/${card.body.id}/purchase`).send({ amount: 5000, currency: 'USD' }).expect(200);
    expect(ko.body).toEqual(expect.objectContaining({ approved: false, reason: 'insufficient_funds' }));

    // Remboursement : montant + frais reviennent sur la carte.
    await http.post(`/v1/sandbox/authorizations/${ok.body.authorizationId}/reverse`).expect(200);
    detail = await http.get(`/v1/cards/${card.body.id}`).set(u.auth).expect(200);
    expect(detail.body.balance).toBe(30_000);

    // Carte gelée : paiement refusé.
    await http.post(`/v1/cards/${card.body.id}/freeze`).set(u.auth).expect(200);
    const frozen = await http.post(`/v1/sandbox/cards/${card.body.id}/purchase`).send({ amount: 1000 }).expect(200);
    expect(frozen.body.reason).toBe('card_frozen');

    // Résiliation : le solde revient au portefeuille.
    await http.delete(`/v1/cards/${card.body.id}`).set(u.auth).expect(200);
    expect((await wallet(u.auth)).balance).toBe(98_000);
    await ledgerOk();
  });

  it('carte à usage unique résiliée après le premier paiement', async () => {
    const u = await signUp();
    await topUp(u.auth, 10_000);
    const card = await http.post('/v1/cards').set(u.auth).set('Idempotency-Key', key()).send({ type: 'single_use' }).expect(201);
    await http.post(`/v1/cards/${card.body.id}/load`).set(u.auth).set('Idempotency-Key', key()).send({ amount: 5000 }).expect(200);
    await http.post(`/v1/sandbox/cards/${card.body.id}/purchase`).send({ amount: 3000 }).expect(200);
    const detail = await http.get(`/v1/cards/${card.body.id}`).set(u.auth).expect(200);
    expect(detail.body).toMatchObject({ status: 'terminated', balance: 0 });
    // 9 900 - 300 (création) - 5 000 + 2 000 rendus = 6 600
    expect((await wallet(u.auth)).balance).toBe(6600);
    await ledgerOk();
  });

  it('palier 1 : cartes multi-usage refusées', async () => {
    const u = await signUp(1);
    const res = await http.post('/v1/cards').set(u.auth).set('Idempotency-Key', key()).send({ type: 'multi' }).expect(403);
    expect(res.body.error).toBe('kyc_required');
  });

  it('chargements simultanés : jamais de solde négatif', async () => {
    const u = await signUp();
    await topUp(u.auth, 10_000); // 9 900
    const card = await http.post('/v1/cards').set(u.auth).set('Idempotency-Key', key()).send({ type: 'multi' }).expect(201); // 8 900
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        http.post(`/v1/cards/${card.body.id}/load`).set(u.auth).set('Idempotency-Key', key()).send({ amount: 2000 }),
      ),
    );
    const ok = results.filter((r) => r.status === 200).length;
    expect(ok).toBe(4); // 4 × 2 000 = 8 000 <= 8 900
    expect(results.filter((r) => r.status === 422)).toHaveLength(2);
    expect((await wallet(u.auth)).balance).toBe(900);
    await ledgerOk();
  });
});

describe('retraits', () => {
  it('bloque les fonds, puis règle ou rend selon la réponse de l’opérateur', async () => {
    const u = await signUp();
    await topUp(u.auth, 20_000); // 19 800

    const ok = await http.post('/v1/withdrawals').set(u.auth).set('Idempotency-Key', key()).send({ operator: 'orange_money', amount: 5000 }).expect(201);
    expect(ok.body).toMatchObject({ fee: 100, totalDebited: 5100, status: 'pending' });
    expect((await wallet(u.auth)).balance).toBe(14_700);
    await http.post(`/v1/sandbox/momo/${ok.body.reference}/complete`).send({ status: 'succeeded' }).expect(200);
    expect((await wallet(u.auth)).balance).toBe(14_700);

    const ko = await http.post('/v1/withdrawals').set(u.auth).set('Idempotency-Key', key()).send({ operator: 'wave', amount: 4000 }).expect(201);
    expect((await wallet(u.auth)).balance).toBe(10_600);
    await http.post(`/v1/sandbox/momo/${ko.body.reference}/complete`).send({ status: 'failed', failureReason: 'account_blocked' }).expect(200);
    expect((await wallet(u.auth)).balance).toBe(14_700);

    const tooMuch = await http.post('/v1/withdrawals').set(u.auth).set('Idempotency-Key', key()).send({ operator: 'wave', amount: 50_000 }).expect(422);
    expect(tooMuch.body.error).toBe('insufficient_funds');
    await ledgerOk();
  });
});
