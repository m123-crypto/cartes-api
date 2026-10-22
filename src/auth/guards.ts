import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { AppConfig, CONFIG } from '../config/config';
import { DomainError } from '../common/errors';
import { AuthUser } from '../common/decorators';
import { AuthService } from './auth.service';

/** Exige un jeton d'accès valide (Authorization: Bearer …) et pose req.user. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const header = req.header('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw new DomainError('unauthorized', 'Authentification requise', 401);
    const { userId, deviceId } = await this.auth.verifyAccessToken(token);
    req.user = { id: userId, deviceId };
    return true;
  }
}

/**
 * Accès au back-office pour le MVP : clé partagée dans l'en-tête X-Admin-Key.
 * À remplacer en V1 par de vrais comptes administrateurs avec rôles et double validation.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const given = Buffer.from(req.header('x-admin-key') ?? '');
    const expected = Buffer.from(this.cfg.ADMIN_API_KEY);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new DomainError('forbidden', 'Accès administrateur refusé', 403);
    }
    return true;
  }
}
