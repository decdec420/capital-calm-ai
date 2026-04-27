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
  RISK_PER_TRADE_PCT,
  getProfile,
  isWhitelistedSymbol,
  type TradingProfile,
} from "./doctrine.ts";
import { GATE_CODES, gate, type GateReason } from "./reasons.ts";

/**
 * Compute notional from a fixed % of equity at risk per trade,
 * given the entry and stop distance. This is the textbook
 * professional sizing formula:
 *
 *     notional = (equity × riskPct) / (|entry − stop| / entry)
 *
 * The output still flows through clampSize() so doctrine caps
 * (per-order cap, kill-switch floor, min order) are always applied.
 *
 * @param equityUsd      Current account equity (USD)
 * @param entry          Proposed entry price
 * @param stop           Proposed stop-loss price
 * @param riskPct        Fraction of equity to risk (e.g. 0.01 = 1%)
 *                       Defaults to Sentinel RISK_PER_TRADE_PCT.
 * @returns              USD notional to send into clampSize(); 0 if inputs are invalid
 */
export function notionalFromRiskPct(
  equityUsd: number,
  entry: number,
  stop: number,
  riskPct: number = RISK_PER_TRADE_PCT,
): number {
  if (!Number.isFinite(equityUsd) || equityUsd <= 0) return 0;
  if (!Number.isFinite(entry) || entry <= 0) return 0;
  if (!Number.isFinite(stop) || stop <= 0) return 0;
  const stopDistPct = Math.abs(entry - stop) / entry;
  if (stopDistPct <= 0) return 0;
  const dollarRisk = equityUsd * Math.max(0, riskPct);
  // notional × stopDistPct = dollarRisk  ⇒  notional = dollarRisk / stopDistPct
  const notional = dollarRisk / stopDistPct;
  return Number.isFinite(notional) && notional > 0 ? notional : 0;
}

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
  /** Active trading profile id or object. Sentinel default. */
  profile?: string | TradingProfile;
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
    profile: profileInput,
  } = input;

  const activeProfile: TradingProfile =
    typeof profileInput === "object" && profileInput
      ? profileInput
      : getProfile(typeof profileInput === "string" ? profileInput : undefined);
  const orderCap = activeProfile.maxOrderUsdHardCap;

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

  // 4. Hard cap: clamp to per-order limit (depends on active profile).
  let sizeUsd = proposedQuoteUsd;
  if (sizeUsd > orderCap) {
    reasons.push(
      gate(
        GATE_CODES.DOCTRINE_MAX_ORDER,
        "info",
        `Proposed $${proposedQuoteUsd.toFixed(2)} clamped to $${orderCap} per-order cap (${activeProfile.label}).`,
        { proposedQuoteUsd, cap: orderCap, profile: activeProfile.id },
      ),
    );
    sizeUsd = orderCap;
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
