/**
 * Erreur métier : un code stable que l'app mobile peut traduire, un message lisible,
 * et le statut HTTP correspondant.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const Errors = {
  insufficientFunds: () => new DomainError('insufficient_funds', 'Solde insuffisant', 422),
  notFound: (what: string) => new DomainError('not_found', `${what} introuvable`, 404),
  kycRequired: (tier: number) =>
    new DomainError('kyc_required', `Vérification d'identité de niveau ${tier} requise`, 403, { requiredTier: tier }),
  limitExceeded: (limit: string, max: number) =>
    new DomainError('limit_exceeded', `Plafond dépassé (${limit})`, 422, { limit, max }),
  providerUnavailable: () =>
    new DomainError('provider_unavailable', 'Service partenaire indisponible, réessayez plus tard', 503),
};

/** Erreur PostgreSQL de violation de la contrainte « pas de découvert » du grand livre. */
export function isOverdraftError(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23514' && e?.constraint === 'ledger_accounts_no_overdraft';
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && (!constraint || e.constraint === constraint);
}
