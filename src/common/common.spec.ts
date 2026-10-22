import { normalizePhone, maskPhone } from './phone';
import { bps, fxFee, topupFee, withdrawalFee, tierLimits } from './pricing';
import { sign, signedHeaders, verifySignature } from './hmac';
import { pinWeakness } from '../auth/pin';
import { validatePostings } from '../ledger/ledger.service';
import { ageInYears } from '../users/users.service';

describe('normalizePhone', () => {
  it.each([
    ['77 123 45 67', '+221771234567'],
    ['+221 77 123 45 67', '+221771234567'],
    ['00221781234567', '+221781234567'],
    ['+2250712345678', '+2250712345678'],
    ['+22376123456', '+22376123456'],
  ])('%s -> %s', (input, expected) => expect(normalizePhone(input)).toBe(expected));

  it.each(['12345', '+221612345678', '+33612345678', '+2217712345678'])('refuse %s', (input) =>
    expect(normalizePhone(input)).toBeNull(),
  );

  it('masque les numéros', () => expect(maskPhone('+221771234567')).toBe('+22177*****67'));
});

describe('tarifs', () => {
  it('arrondit les frais au franc supérieur', () => {
    expect(bps(10_000, 100)).toBe(100);
    expect(bps(10_001, 100)).toBe(101);
    expect(topupFee(50_000)).toBe(500);
  });
  it('applique un minimum sur les retraits', () => {
    expect(withdrawalFee(1000)).toBe(100);
    expect(withdrawalFee(50_000)).toBe(500);
  });
  it('ne facture pas de change en FCFA', () => {
    expect(fxFee(6000, 'XOF')).toBe(0);
    expect(fxFee(6000, 'USD')).toBe(150);
  });
  it('palier inconnu = aucun droit', () => expect(tierLimits(9).maxActiveCards).toBe(0));
});

describe('signature des webhooks', () => {
  const secret = 'x'.repeat(32);
  const body = '{"reference":"abc","status":"succeeded"}';

  it('accepte une signature valide', () => {
    expect(verifySignature(secret, signedHeaders(secret, body), Buffer.from(body))).toBe(true);
  });
  it('refuse un corps modifié', () => {
    expect(verifySignature(secret, signedHeaders(secret, body), Buffer.from(body.replace('abc', 'abd')))).toBe(false);
  });
  it('refuse un mauvais secret', () => {
    expect(verifySignature(secret, signedHeaders('y'.repeat(32), body), Buffer.from(body))).toBe(false);
  });
  it('refuse un webhook trop ancien (rejeu)', () => {
    const old = Date.now() - 10 * 60_000;
    const ts = Math.floor(old / 1000);
    const headers = { 'x-timestamp': String(ts), 'x-signature': sign(secret, ts, body) };
    expect(verifySignature(secret, headers, Buffer.from(body))).toBe(false);
  });
});

describe('code PIN', () => {
  it.each(['000000', '111111', '123456', '654321', '12345', 'abcdef'])('refuse %s', (pin) => expect(pinWeakness(pin)).not.toBeNull());
  it('accepte un PIN correct', () => expect(pinWeakness('402817')).toBeNull());
});

describe('validatePostings', () => {
  const a = '00000000-0000-0000-0000-00000000000a';
  const b = '00000000-0000-0000-0000-00000000000b';
  it('accepte une transaction équilibrée', () => {
    expect(() => validatePostings([{ accountId: a, direction: 'D', amount: 10 }, { accountId: b, direction: 'C', amount: 10 }])).not.toThrow();
  });
  it('refuse une transaction déséquilibrée', () => {
    expect(() => validatePostings([{ accountId: a, direction: 'D', amount: 10 }, { accountId: b, direction: 'C', amount: 9 }])).toThrow();
  });
  it('refuse les montants non entiers ou négatifs', () => {
    expect(() => validatePostings([{ accountId: a, direction: 'D', amount: 1.5 }, { accountId: b, direction: 'C', amount: 1.5 }])).toThrow();
    expect(() => validatePostings([{ accountId: a, direction: 'D', amount: -5 }, { accountId: b, direction: 'C', amount: -5 }])).toThrow();
  });
});

describe('ageInYears', () => {
  const today = new Date('2026-10-22T12:00:00Z');
  it('compte l’anniversaire', () => {
    expect(ageInYears('2008-10-22', today)).toBe(18);
    expect(ageInYears('2008-10-23', today)).toBe(17);
  });
});
