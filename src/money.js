import { check } from './errors.js';

export const CURRENCY = 'INR';
export const MAX_SUBTOTAL = 100_000_000_000_000n;

export function parseUnitPrice(value) {
  check(typeof value === 'string' && /^(0|[1-9]\d{0,9})$/.test(value)
    && BigInt(value) <= 1_000_000_000n,
  400, 'INVALID_INPUT', 'unitPriceMinor must be a decimal integer string from "0" to "1000000000".');
  return BigInt(value);
}

export function calculateTotals(items, discountPercent = 0) {
  const subtotal = items.reduce((sum, item) =>
    sum + BigInt(item.unitPriceMinor) * BigInt(item.quantity), 0n);
  check(subtotal <= MAX_SUBTOTAL, 422, 'CART_TOTAL_TOO_LARGE', 'Cart total exceeds the supported limit.');
  // Round the order-level discount once, to the nearest paise; half a paise rounds up.
  const discount = (subtotal * BigInt(discountPercent) + 50n) / 100n;
  return { subtotalMinor: subtotal.toString(), discountMinor: discount.toString(),
    totalMinor: (subtotal - discount).toString() };
}
