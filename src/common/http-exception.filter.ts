import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { DomainError, isOverdraftError, isUniqueViolation } from './errors';

/** Format d'erreur unique pour toute l'API : { error, message, details? }. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof DomainError) {
      res.status(exception.status).json({ error: exception.code, message: exception.message, details: exception.details });
      return;
    }
    if (isOverdraftError(exception)) {
      res.status(422).json({ error: 'insufficient_funds', message: 'Solde insuffisant' });
      return;
    }
    if (isUniqueViolation(exception)) {
      res.status(409).json({ error: 'conflict', message: 'Opération déjà enregistrée' });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null && 'error' in body && typeof (body as any).error === 'string' && 'issues' in body) {
        res.status(status).json(body);
        return;
      }
      res.status(status).json({ error: httpCode(status), message: exception.message });
      return;
    }

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    res.status(500).json({ error: 'internal_error', message: 'Erreur interne' });
  }
}

function httpCode(status: number): string {
  switch (status) {
    case 400: return 'bad_request';
    case 401: return 'unauthorized';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    case 429: return 'too_many_requests';
    default: return 'http_error';
  }
}
