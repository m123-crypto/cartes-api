import { Inject, Injectable } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config/config';
import { verifySignature } from '../common/hmac';
import { Operator } from '../common/pricing';

export const MOMO_PROVIDER = Symbol('MOMO_PROVIDER');

export interface MomoRequest {
  operationId: string;
  operator: Operator;
  msisdn: string;
  amount: number;
}

export interface MomoWebhookEvent {
  providerReference: string;
  status: 'succeeded' | 'failed';
  /** Montant confirmé par l'opérateur, contrôlé contre le montant attendu. */
  amount?: number;
  failureReason?: string;
}

/**
 * Point d'intégration unique pour le mobile money. Un agrégateur agréé (une seule
 * intégration pour tous les opérateurs) ou les API directes de Wave / Orange Money
 * s'implémentent derrière cette interface sans toucher au reste du code.
 */
export interface MomoProvider {
  readonly name: string;
  /** Demande de paiement : l'utilisateur valide sur son téléphone (PIN opérateur). */
  initiateCollection(req: MomoRequest): Promise<{ providerReference: string; instructions?: string }>;
  /** Envoi d'argent vers le portefeuille mobile money de l'utilisateur. */
  initiateDisbursement(req: MomoRequest): Promise<{ providerReference: string }>;
  /** Vérifie la signature et traduit le webhook du fournisseur dans notre format. Renvoie null si invalide. */
  parseWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer | undefined): MomoWebhookEvent | null;
}

/**
 * Fournisseur bac à sable : ne contacte aucun opérateur. Les opérations restent en attente
 * jusqu'à un appel à POST /v1/sandbox/momo/:reference/complete (SANDBOX=true uniquement).
 */
@Injectable()
export class SandboxMomoProvider implements MomoProvider {
  readonly name = 'sandbox';

  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {}

  async initiateCollection(req: MomoRequest) {
    return {
      providerReference: `sbx_in_${req.operationId}`,
      instructions: 'Bac à sable : confirmez via POST /v1/sandbox/momo/{reference}/complete',
    };
  }

  async initiateDisbursement(req: MomoRequest) {
    return { providerReference: `sbx_out_${req.operationId}` };
  }

  parseWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer | undefined): MomoWebhookEvent | null {
    if (!verifySignature(this.cfg.MOMO_WEBHOOK_SECRET, headers, rawBody)) return null;
    try {
      const body = JSON.parse(rawBody!.toString('utf8'));
      if (typeof body.reference !== 'string' || !['succeeded', 'failed'].includes(body.status)) return null;
      return {
        providerReference: body.reference,
        status: body.status,
        amount: typeof body.amount === 'number' ? body.amount : undefined,
        failureReason: typeof body.failureReason === 'string' ? body.failureReason : undefined,
      };
    } catch {
      return null;
    }
  }
}
