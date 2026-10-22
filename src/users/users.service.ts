import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { LedgerService } from '../ledger/ledger.service';
import { DomainError, Errors } from '../common/errors';
import { tierLimits } from '../common/pricing';

export interface UserRow {
  id: string;
  phone: string;
  first_name: string | null;
  last_name: string | null;
  birth_date: string | null;
  language: string;
  kyc_tier: number;
  status: string;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
  ) {}

  async get(userId: string): Promise<UserRow> {
    const user = await this.db.one<UserRow>(
      'select id, phone, first_name, last_name, birth_date, language, kyc_tier, status from users where id = $1',
      [userId],
    );
    if (!user) throw Errors.notFound('Utilisateur');
    return user;
  }

  async profile(userId: string) {
    const user = await this.get(userId);
    const pending = await this.db.query<{ tier: number; created_at: Date }>(
      `select tier, created_at from kyc_submissions where user_id = $1 and status = 'pending'`,
      [userId],
    );
    return {
      id: user.id,
      phone: user.phone,
      firstName: user.first_name,
      lastName: user.last_name,
      birthDate: user.birth_date,
      language: user.language,
      status: user.status,
      kyc: { tier: user.kyc_tier, pendingTiers: pending.map((p) => p.tier) },
      limits: tierLimits(user.kyc_tier),
      holdings: await this.ledger.userHoldings(this.db.pool, userId),
    };
  }

  async updateLanguage(userId: string, language: 'fr' | 'wo' | 'en') {
    await this.db.query('update users set language = $2, updated_at = now() where id = $1', [userId, language]);
    return this.profile(userId);
  }

  /** Palier 1 : identité déclarative, validée automatiquement (majeur uniquement). */
  async submitTier1(userId: string, input: { firstName: string; lastName: string; birthDate: string }) {
    if (ageInYears(input.birthDate) < 18) {
      throw new DomainError('underage', 'Le service est réservé aux personnes majeures', 422);
    }
    // Une identité vérifiée par pièce (palier 2 et plus) ne peut plus être modifiée par déclaration.
    const updated = await this.db.one(
      `update users set first_name = $2, last_name = $3, birth_date = $4,
              kyc_tier = greatest(kyc_tier, 1), updated_at = now()
        where id = $1 and kyc_tier < 2
        returning id`,
      [userId, input.firstName, input.lastName, input.birthDate],
    );
    if (!updated) {
      throw new DomainError('identity_locked', 'Identité déjà vérifiée : contactez le support pour la modifier', 409);
    }
    return this.profile(userId);
  }

  /**
   * Paliers 2 et 3 : les documents sont envoyés directement par l'app au fournisseur KYC
   * (lecture de pièce + vivacité) ; on ne reçoit que sa référence de dossier.
   */
  async submitDocuments(
    userId: string,
    input: { tier: 2 | 3; documentType: string; providerReference: string },
  ) {
    const user = await this.get(userId);
    if (user.kyc_tier < input.tier - 1) throw Errors.kycRequired(input.tier - 1);
    if (user.kyc_tier >= input.tier) throw new DomainError('already_verified', 'Ce niveau est déjà validé', 409);
    const personal = ['cni', 'passport', 'consular_card'];
    const business = ['ninea', 'rccm'];
    if ((input.tier === 2 && !personal.includes(input.documentType)) || (input.tier === 3 && !business.includes(input.documentType))) {
      throw new DomainError('invalid_document_type', 'Type de document non accepté pour ce niveau', 400);
    }
    const row = await this.db.one<{ id: string }>(
      `insert into kyc_submissions (user_id, tier, document_type, provider_reference)
       values ($1, $2, $3, $4)
       on conflict (user_id, tier) where status = 'pending' do nothing
       returning id`,
      [userId, input.tier, input.documentType, input.providerReference],
    );
    if (!row) throw new DomainError('kyc_pending', 'Une vérification est déjà en cours pour ce niveau', 409);
    return { submissionId: row.id, status: 'pending' };
  }
}

/** Vrai si 'AAAA-MM-JJ' désigne un jour qui existe (refuse 2001-02-30, 1995-13-01…). */
export function isRealDate(isoDate: string): boolean {
  const [y, m, d] = isoDate.split('-').map(Number);
  if (!y || y < 1900) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function ageInYears(isoDate: string, today = new Date()): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  let age = today.getUTCFullYear() - y;
  const beforeBirthday = today.getUTCMonth() + 1 < m || (today.getUTCMonth() + 1 === m && today.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return age;
}
