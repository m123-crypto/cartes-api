import { Inject, Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { AppConfig, CONFIG } from '../config/config';
import { verifySignature } from '../common/hmac';
import { CardType } from '../common/pricing';

export const CARD_ISSUER = Symbol('CARD_ISSUER');

export interface IssuedCard {
  issuerCardId: string;
  last4: string;
  expiryMonth: number;
  expiryYear: number;
}

/** Demande d'autorisation envoyée en temps réel par l'émetteur quand un marchand débite la carte. */
export interface AuthorizationRequest {
  type: 'authorization';
  issuerAuthorizationId: string;
  issuerCardId: string;
  /** Montant dans la devise du marchand, en unités mineures (centimes pour USD/EUR). */
  amount: number;
  currency: string;
  /** Montant converti en FCFA par l'émetteur (taux du réseau). */
  billingAmountXof: number;
  merchantName?: string;
  merchantCountry?: string;
  mcc?: string;
}

/** Annulation ou remboursement d'une autorisation déjà accordée. */
export interface ReversalEvent {
  type: 'reversal';
  issuerAuthorizationId: string;
}

export type IssuerEvent = AuthorizationRequest | ReversalEvent;

/**
 * Point d'intégration unique avec l'émetteur agréé (banque sponsor ou plateforme d'émission).
 *
 * Modèle « financement en temps réel » : les fonds restent dans notre grand livre et
 * l'émetteur nous demande d'approuver chaque paiement. Les numéros de carte et CVV ne
 * transitent jamais par nos serveurs : l'app les affiche via la session sécurisée de l'émetteur.
 */
export interface CardIssuer {
  readonly name: string;
  createCard(input: { cardId: string; userId: string; type: CardType; holderName: string }): Promise<IssuedCard>;
  setStatus(issuerCardId: string, status: 'active' | 'frozen' | 'terminated'): Promise<void>;
  /** Session courte d'affichage sécurisé (iframe ou SDK de l'émetteur). */
  createRevealSession(issuerCardId: string): Promise<{ url: string; expiresAt: string }>;
  parseWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer | undefined): IssuerEvent | null;
}

/** Émetteur bac à sable : génère de fausses cartes, aucun appel réseau. */
@Injectable()
export class SandboxCardIssuer implements CardIssuer {
  readonly name = 'sandbox';

  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {}

  async createCard(input: { cardId: string }): Promise<IssuedCard> {
    const now = new Date();
    return {
      issuerCardId: `sbxcard_${input.cardId}`,
      last4: String(randomInt(0, 10_000)).padStart(4, '0'),
      expiryMonth: now.getUTCMonth() + 1,
      expiryYear: now.getUTCFullYear() + 3,
    };
  }

  async setStatus(): Promise<void> {
    // rien à faire en bac à sable
  }

  async createRevealSession(issuerCardId: string) {
    return {
      url: `https://sandbox.invalid/reveal/${encodeURIComponent(issuerCardId)}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  parseWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer | undefined): IssuerEvent | null {
    if (!verifySignature(this.cfg.ISSUER_WEBHOOK_SECRET, headers, rawBody)) return null;
    try {
      const b = JSON.parse(rawBody!.toString('utf8'));
      if (b.type === 'reversal' && typeof b.issuerAuthorizationId === 'string') {
        return { type: 'reversal', issuerAuthorizationId: b.issuerAuthorizationId };
      }
      if (
        b.type === 'authorization' &&
        typeof b.issuerAuthorizationId === 'string' &&
        typeof b.issuerCardId === 'string' &&
        Number.isSafeInteger(b.amount) && b.amount > 0 &&
        Number.isSafeInteger(b.billingAmountXof) && b.billingAmountXof > 0 &&
        typeof b.currency === 'string' && /^[A-Z]{3}$/.test(b.currency)
      ) {
        return {
          type: 'authorization',
          issuerAuthorizationId: b.issuerAuthorizationId,
          issuerCardId: b.issuerCardId,
          amount: b.amount,
          currency: b.currency,
          billingAmountXof: b.billingAmountXof,
          merchantName: typeof b.merchantName === 'string' ? b.merchantName.slice(0, 120) : undefined,
          merchantCountry: typeof b.merchantCountry === 'string' ? b.merchantCountry.slice(0, 2) : undefined,
          mcc: typeof b.mcc === 'string' ? b.mcc.slice(0, 4) : undefined,
        };
      }
      return null;
    } catch {
      return null;
    }
  }
}
