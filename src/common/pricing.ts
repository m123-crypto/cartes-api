/**
 * Grille tarifaire et plafonds par palier KYC.
 *
 * VALEURS DE TRAVAIL : à aligner sur le contrat du partenaire émetteur et sur la
 * réglementation BCEAO applicable aux comptes de monnaie électronique avant tout lancement.
 * Montants en FCFA, taux en points de base (100 = 1 %).
 */

export const CARD_TYPES = ['multi', 'single_use', 'subscription'] as const;
export type CardType = (typeof CARD_TYPES)[number];

export const OPERATORS = ['wave', 'orange_money', 'free_money', 'mtn', 'moov'] as const;
export type Operator = (typeof OPERATORS)[number];

export const FEES = {
  topupBps: 100,
  withdrawalBps: 100,
  withdrawalMin: 100,
  fxBps: 250,
  cardCreation: { multi: 1000, single_use: 300, subscription: 500 } as Record<CardType, number>,
};

export const AMOUNTS = {
  topupMin: 500,
  topupMax: 1_000_000,
  withdrawalMin: 1000,
  cardLoadMin: 100,
};

export interface TierLimits {
  /** Total détenu (portefeuille + cartes) après une recharge */
  maxHoldings: number;
  /** Total des recharges sur le mois civil */
  monthlyTopups: number;
  maxActiveCards: number;
  cardTypes: readonly CardType[];
}

export const TIERS: Record<0 | 1 | 2 | 3, TierLimits> = {
  0: { maxHoldings: 0, monthlyTopups: 0, maxActiveCards: 0, cardTypes: [] },
  1: { maxHoldings: 200_000, monthlyTopups: 500_000, maxActiveCards: 2, cardTypes: ['single_use'] },
  2: { maxHoldings: 2_000_000, monthlyTopups: 5_000_000, maxActiveCards: 5, cardTypes: CARD_TYPES },
  3: { maxHoldings: 10_000_000, monthlyTopups: 30_000_000, maxActiveCards: 50, cardTypes: CARD_TYPES },
};

export function tierLimits(tier: number): TierLimits {
  return TIERS[(tier in TIERS ? tier : 0) as 0 | 1 | 2 | 3];
}

/** Frais arrondis au franc supérieur : jamais de fraction de FCFA. */
export function bps(amount: number, rateBps: number): number {
  return Math.ceil((amount * rateBps) / 10_000);
}

export const topupFee = (amount: number) => bps(amount, FEES.topupBps);
export const withdrawalFee = (amount: number) => Math.max(FEES.withdrawalMin, bps(amount, FEES.withdrawalBps));
export const fxFee = (amountXof: number, currency: string) => (currency === 'XOF' ? 0 : bps(amountXof, FEES.fxBps));
