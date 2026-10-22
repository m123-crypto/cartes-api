import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signature des webhooks partenaires : HMAC-SHA256 de "<timestamp>.<corps brut>".
 * Le timestamp limite le rejeu d'un webhook intercepté.
 */
export const SIGNATURE_HEADER = 'x-signature';
export const TIMESTAMP_HEADER = 'x-timestamp';
const TOLERANCE_SECONDS = 300;

export function sign(secret: string, timestamp: number, rawBody: string | Buffer): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

export function verifySignature(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer | string | undefined,
  now = Date.now(),
): boolean {
  const signature = single(headers[SIGNATURE_HEADER]);
  const timestamp = Number(single(headers[TIMESTAMP_HEADER]));
  if (!signature || !rawBody || !Number.isInteger(timestamp)) return false;
  if (Math.abs(now / 1000 - timestamp) > TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(sign(secret, timestamp, rawBody), 'hex');
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signedHeaders(secret: string, rawBody: string, now = Date.now()): Record<string, string> {
  const timestamp = Math.floor(now / 1000);
  return {
    'content-type': 'application/json',
    [TIMESTAMP_HEADER]: String(timestamp),
    [SIGNATURE_HEADER]: sign(secret, timestamp, rawBody),
  };
}

function single(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
