/** Règles du code PIN : 6 chiffres, ni répétés ni en suite (000000, 123456, 987654…). */
export function pinWeakness(pin: string): string | null {
  if (!/^\d{6}$/.test(pin)) return 'Le code PIN doit contenir exactement 6 chiffres';
  if (/^(\d)\1{5}$/.test(pin)) return 'Le code PIN ne peut pas être un même chiffre répété';
  const digits = [...pin].map(Number);
  const steps = digits.slice(1).map((d, i) => d - digits[i]);
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) {
    return 'Le code PIN ne peut pas être une suite de chiffres';
  }
  return null;
}
