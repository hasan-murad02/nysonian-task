// Single source of truth for dollars -> integer minor units (cents).
// Returns null on non-finite input rather than throwing, so callers at a
// trust boundary (the webhook payload) can turn it into a rejection instead
// of a 500. Callers decide their own positivity rules (e.g. shipping can be
// zero, a refund can't).
export function toMinorUnits(amount: number): number | null {
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}
