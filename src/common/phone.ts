/**
 * Numéros mobiles acceptés, au format national (sans l'indicatif).
 * Sénégal d'abord ; Côte d'Ivoire et Mali sont prêts pour l'extension.
 */
const MOBILE_PATTERNS: Record<string, RegExp> = {
  '221': /^7\d{8}$/, // Sénégal : 9 chiffres commençant par 7
  '225': /^0[157]\d{8}$/, // Côte d'Ivoire : 10 chiffres (01, 05, 07)
  '223': /^[5-9]\d{7}$/, // Mali : 8 chiffres
};

const DEFAULT_COUNTRY = '221';

/** Normalise un numéro au format E.164 (+221771234567) ou renvoie null s'il est invalide. */
export function normalizePhone(input: string): string | null {
  let s = input.replace(/[\s.()-]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!s.startsWith('+')) s = `+${DEFAULT_COUNTRY}${s}`;
  for (const [cc, pattern] of Object.entries(MOBILE_PATTERNS)) {
    if (s.startsWith(`+${cc}`) && pattern.test(s.slice(cc.length + 1))) return s;
  }
  return null;
}

/** Masque un numéro pour les journaux : +22177*****67 */
export function maskPhone(phone: string): string {
  return phone.length > 8 ? `${phone.slice(0, 6)}${'*'.repeat(phone.length - 8)}${phone.slice(-2)}` : '***';
}
