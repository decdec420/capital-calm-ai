// ============================================================
// Fill bookkeeping — Phase 5 (live execution plumbing)
// ------------------------------------------------------------
// Centralizes how every Coinbase fill becomes:
//   1. A row in `broker_fills` (audit + cost ledger)
//   2. Derived slippage_pct vs the proposed entry/exit
//   3. Aggregated fee/slippage updates on the parent `trades` row
//
// Every broker call site (signal-engine entry, trade-close,
// mark-to-market TP1/TP2/stop) MUST call recordFill() after
// getting a successful BrokerFill. Failing to do so leaves
// `live_execution_stats_v` blind and the cost-aware edge gate
// will keep using its hardcoded fallback assumptions.
// ============================================================

import type { BrokerFill } from "./broker.ts";

export type FillKind =
  | "entry"
  | "tp1"
  | "tp2"
  | "tp3"
  | "stop"
  | "manual_close"
  | "rebalance";

export interface RecordFillInput {
  userId: string;
  tradeId: string | null;
  symbol: string;
  fillKind: FillKind;
  /**
   * The price the engine *intended* to transact at (proposed_entry,
   * tp1_price, stop_loss, etc). Used to compute slippage. Pass null
   * if no proposal existed (e.g. emergency manual close).
   */
  proposedPrice: number | null;
  fill: BrokerFill;
}

/**
 * Compute slippage as a signed pct of the proposed price.
 * Positive = worse than expected (paid more on a buy or got less on a sell).
 * Negative = price improvement.
 */
export function computeSlippagePct(
  side: "BUY" | "SELL",
  proposedPrice: number | null,
  fillPrice: number,
): number | null {
  if (!proposedPrice || proposedPrice <= 0 || !Number.isFinite(fillPrice) || fillPrice <= 0) {
    return null;
  }
  const raw = (fillPrice - proposedPrice) / proposedPrice;
  // For SELL, getting a lower price is bad — flip the sign so positive = bad on both sides.
  return side === "BUY" ? raw : -raw;
}

/**
 * Persist a fill into broker_fills. Idempotent on
 * (user_id, client_order_id, fill_kind) — safe to call from retry-prone paths.
 */
// deno-lint-ignore no-explicit-any
export async function recordFill(admin: any, input: RecordFillInput): Promise<void> {
  const { userId, tradeId, symbol, fillKind, proposedPrice, fill } = input;
  const slippage_pct = computeSlippagePct(fill.side, proposedPrice, fill.fillPrice);

  const { error } = await admin
    .from("broker_fills")
    .upsert(
      {
        user_id: userId,
        trade_id: tradeId,
        symbol,
        side: fill.side,
        fill_kind: fillKind,
        client_order_id: fill.clientOrderId,
        broker_order_id: fill.orderId,
        fill_price: fill.fillPrice,
        base_size: fill.filledBaseSize,
        // Use absolute notional (price × size) for the cost-rate denominator;
        // Coinbase's `total_value_after_fees` is asymmetric across BUY/SELL.
        quote_size: Math.abs(fill.fillPrice * fill.filledBaseSize),
        fees_usd: Number.isFinite(fill.feesUsd) ? fill.feesUsd : 0,
        proposed_price: proposedPrice,
        slippage_pct,
        raw: fill.raw ?? {},
      },
      { onConflict: "user_id,client_order_id,fill_kind", ignoreDuplicates: true },
    );

  if (error) {
    // Logged but never thrown — bookkeeping must never break the trade flow.
    console.warn(`[fills] recordFill failed (${fillKind} ${symbol}): ${error.message}`);
  }
}

/**
 * Net realized PnL after deducting both legs of the round-trip cost.
 * Effective PnL is the only honest number to show the user.
 */
export function effectivePnl(
  grossPnl: number,
  entryFeesUsd: number,
  exitFeesUsd: number,
): number {
  return grossPnl - (entryFeesUsd ?? 0) - (exitFeesUsd ?? 0);
}
