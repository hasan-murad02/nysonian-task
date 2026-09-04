// Single source of truth for dollars -> integer minor units (cents).
// Returns null on non-finite input rather than throwing, so callers at a
// trust boundary (the webhook payload) can turn it into a rejection instead
// of a 500. Callers decide their own positivity rules (e.g. shipping can be
// zero, a refund can't).
export function toMinorUnits(amount: number): number | null {
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

// Integer minor units -> a currency-formatted string (e.g. 3000 -> "$30.00",
// 3000 EUR -> "€30.00"). Orders carry USD/EUR/GBP, so this can't hardcode a
// symbol — an order shown in the wrong currency's symbol is exactly the kind
// of thing a human reviewer would notice and distrust.
export function formatMoney(minorUnits: number, currency: string = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minorUnits / 100);
}
