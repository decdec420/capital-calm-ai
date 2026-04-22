// ============================================================
// Position Sizing (Authoritative Clamp)
// ------------------------------------------------------------
// Authoritative. Browser reads from this; never forks.
// The AI is free to propose any size. This module clamps it to
// the capital-preservation doctrine before a signal row is
// written. If the clamp produces an un-tradable result (e.g.
// equity below the kill-switch floor), the signal is blocked.
// ============================================================

import {
  KILL_SWITCH_FLOOR_USD,
  MAX_ORDER_USD,
  isWhitelistedSymbol,
} from "./doctrine.ts";
import { GATE_CODES, gate, type GateReason } from "./reasons.ts";

export interface ClampSizeInput {
  /** What the AI proposed, in quote currency (USD) */
  proposedQuoteUsd: number;
  /** Current account equity (USD) */
  equityUsd: number;
  /** Last known symbol price (USD) */
  symbolPrice: number;
  /** Symbol pair, e.g. "BTC-USD" */
  symbol: string;
  /**
   * Smallest order the exchange will accept, in quote currency.
   * Coinbase Advanced Trade minimums are tiny for BTC/ETH/SOL
   * ($0.01–$1 depending on pair). We default to $0.25 which
   * comfortably clears all three while keeping us honest about
   * un-tradable residuals.
   */
  minOrderUsd?: number;
}

export interface ClampSizeResult {
  /** Final USD notional to send to the broker */
  sizeUsd: number;
  /** Qty in base currency (e.g. BTC) */
  qty: number;
  /** Non-blocking warnings + blocking reasons */
  clampedBy: GateReason[];
  /** If true, the signal must NOT execute */
  blocked: boolean;
}

export function clampSize(input: ClampSizeInput): ClampSizeResult {
  const {
    proposedQuoteUsd,
    equityUsd,
    symbolPrice,
    symbol,
    minOrderUsd = 0.25,
  } = input;

  const reasons: GateReason[] = [];

  // 1. Symbol must be whitelisted — enforced even if AI is confused.
  if (!isWhitelistedSymbol(symbol)) {
    return {
      sizeUsd: 0,
      qty: 0,
      blocked: true,
      clampedBy: [
        gate(
          GATE_CODES.DOCTRINE_SYMBOL_NOT_ALLOWED,
          "block",
          `Symbol ${symbol} is not on the doctrine whitelist.`,
          { symbol },
        ),
      ],
    };
  }

  // 2. Sanity check inputs — non-positive proposed / price / equity are rejected.
  if (!Number.isFinite(proposedQuoteUsd) || proposedQuoteUsd <= 0) {
    return {
      sizeUsd: 0,
      qty: 0,
      blocked: true,
      clampedBy: [
        gate(
          GATE_CODES.DOCTRINE_INVALID_SIZE,
          "block",
          "Proposed size is non-positive or not finite.",
          { proposedQuoteUsd },
        ),
      ],
    };
  }
  if (!Number.isFinite(symbolPrice) || symbolPrice <= 0) {
    return {
      sizeUsd: 0,
      qty: 0,
      blocked: true,
      clampedBy: [
        gate(
          GATE_CODES.DOCTRINE_INVALID_SIZE,
          "block",
          "Symbol price is non-positive or not finite.",
          { symbolPrice },
        ),
      ],
    };
  }

  // 3. Kill-switch floor: equity minus this order must stay above the floor.
  //    If it wouldn't, block outright.
  if (equityUsd - proposedQuoteUsd < KILL_SWITCH_FLOOR_USD) {
    return {
      sizeUsd: 0,
      qty: 0,
      blocked: true,
      clampedBy: [
        gate(
          GATE_CODES.DOCTRINE_KILL_SWITCH_FLOOR,
          "block",
          `Order would drop equity below the $${KILL_SWITCH_FLOOR_USD} kill-switch floor.`,
          { equityUsd, proposedQuoteUsd, floor: KILL_SWITCH_FLOOR_USD },
        ),
      ],
    };
  }

  // 4. Hard cap: clamp to $1 per order. Informational if clamped.
  let sizeUsd = proposedQuoteUsd;
  if (sizeUsd > MAX_ORDER_USD) {
    reasons.push(
      gate(
        GATE_CODES.DOCTRINE_MAX_ORDER,
        "info",
        `Proposed $${proposedQuoteUsd.toFixed(2)} clamped to $${MAX_ORDER_USD} per-order cap.`,
        { proposedQuoteUsd, cap: MAX_ORDER_USD },
      ),
    );
    sizeUsd = MAX_ORDER_USD;
  }

  // 5. Minimum viable order: if what's left rounds to below the exchange
  //    minimum, we refuse to execute.
  if (sizeUsd < minOrderUsd) {
    return {
      sizeUsd: 0,
      qty: 0,
      blocked: true,
      clampedBy: [
        ...reasons,
        gate(
          GATE_CODES.DOCTRINE_QTY_TOO_SMALL,
          "block",
          `Clamped size $${sizeUsd.toFixed(2)} is below the $${minOrderUsd} minimum.`,
          { sizeUsd, minOrderUsd },
        ),
      ],
    };
  }

  // Round to 2 decimals for USD notional, 8 for qty — standard Coinbase precision.
  sizeUsd = Math.round(sizeUsd * 100) / 100;
  const qty = Math.floor((sizeUsd / symbolPrice) * 1e8) / 1e8;

  if (qty <= 0) {
    return {
      sizeUsd: 0,
      qty: 0,
      blocked: true,
      clampedBy: [
        ...reasons,
        gate(
          GATE_CODES.DOCTRINE_QTY_TOO_SMALL,
          "block",
          "Computed qty rounds to zero at current price.",
          { sizeUsd, symbolPrice },
        ),
      ],
    };
  }

  return { sizeUsd, qty, clampedBy: reasons, blocked: false };
}
