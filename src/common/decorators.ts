import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface AuthUser {
  id: string;
  deviceId: string;
}

/** Utilisateur authentifié (posé par JwtAuthGuard). */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
  if (!req.user) throw new Error('CurrentUser utilisé sans JwtAuthGuard');
  return req.user;
});

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * En-tête Idempotency-Key obligatoire sur toute opération qui déplace de l'argent :
 * l'app mobile le génère une fois par action et le renvoie tel quel en cas de nouvel essai,
 * pour qu'une coupure réseau ne débite jamais deux fois.
 */
export const IdempotencyKey = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<Request>();
  const key = req.header('idempotency-key');
  if (!key || !IDEMPOTENCY_KEY.test(key)) {
    throw new BadRequestException({
      error: 'validation_error',
      message: 'En-tête Idempotency-Key requis (8 à 64 caractères : lettres, chiffres, - ou _)',
      issues: [{ path: 'Idempotency-Key', message: 'requis' }],
    });
  }
  return key;
});
