import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format a base-currency quantity (e.g. BTC, ETH, SOL) with adaptive
 * precision so $10 accounts and $10,000 accounts both show meaningful
 * digits. The number of fractional digits scales to whatever's needed
 * to display ~5 significant figures, capped at 8 (Coinbase precision).
 *
 *   formatBaseQty(0.000011)  → "0.000011"
 *   formatBaseQty(0.0042)    → "0.00420"
 *   formatBaseQty(1.234)     → "1.2340"
 *   formatBaseQty(125.6)     → "125.60"
 */
export function formatBaseQty(qty: number, sigFigs = 5): string {
  if (!Number.isFinite(qty)) return "—";
  if (qty === 0) return "0";
  const abs = Math.abs(qty);
  // For numbers >= 1, use a fixed 4 decimals (matches old behavior).
  if (abs >= 1) return qty.toFixed(4);
  // For sub-unit numbers, scale digits so we always show `sigFigs` of them.
  // e.g. 0.000011 → magnitude -5 → 5 + 5 - 1 = 9 (capped at 8) decimals.
  const magnitude = Math.floor(Math.log10(abs)); // negative for sub-1
  const decimals = Math.min(8, Math.max(2, sigFigs - magnitude - 1));
  return qty.toFixed(decimals);
}

/**
 * Format a USD notional value with cents for sub-$1000 amounts and
 * whole-dollar grouping for larger ones. Always prefixed with `$`.
 *
 *   formatUsd(0.86)    → "$0.86"
 *   formatUsd(12.5)    → "$12.50"
 *   formatUsd(1234.5)  → "$1,235"
 */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return "—";
  const abs = Math.abs(usd);
  if (abs < 1000) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString("en-US")}`;
}
