// ============================================================
// Lifecycle FSM (Signals + Trades + Strategies)
// ------------------------------------------------------------
// Authoritative. Browser reads from this; never forks.
// Ported and unified from decdec420/Trader →
// StrategyRegistry + TradeLifecycleEngine. Every write to
// trade_signals.status, trades.lifecycle_phase, or
// strategies.status must go through transition() so illegal
// jumps fail loudly instead of silently corrupting state.
// ============================================================

// ─── Signal phases ─────────────────────────────────────────────
export type SignalLifecyclePhase =
  | "proposed"
  | "approved"
  | "rejected"
  | "expired"
  | "executed";

const SIGNAL_TRANSITIONS: Record<SignalLifecyclePhase, SignalLifecyclePhase[]> =
  {
    proposed: ["approved", "rejected", "expired"],
    approved: ["executed", "rejected"],
    rejected: [],
    expired: [],
    executed: [],
  };

// ─── Trade phases ─────────────────────────────────────────────
export type TradeLifecyclePhase =
  | "entered"
  | "monitored"
  | "tp1_hit"
  | "exited"
  | "archived";

const TRADE_TRANSITIONS: Record<TradeLifecyclePhase, TradeLifecyclePhase[]> = {
  entered: ["monitored", "tp1_hit", "exited"],
  monitored: ["tp1_hit", "exited"],
  tp1_hit: ["exited"],
  exited: ["archived"],
  archived: [],
};

// ─── Strategy stages ─────────────────────────────────────────────
export type StrategyStage =
  | "seeded"
  | "candidate"
  | "approved"
  | "live"
  | "archived"
  | "retired";

const STRATEGY_TRANSITIONS: Record<StrategyStage, StrategyStage[]> = {
  seeded: ["candidate", "retired", "archived"],
  candidate: ["approved", "retired", "archived"],
  approved: ["live", "candidate", "retired", "archived"],
  live: ["approved", "retired", "archived"],
  retired: [],
  archived: [],
};

// ─── Transition API ─────────────────────────────────────────────
export interface LifecycleTransition {
  phase: string;
  at: string;
  by?: string;
  reason?: string;
  meta?: Record<string, unknown>;
}

export interface TransitionResult<P> {
  ok: boolean;
  next: P;
  from: P;
  transition?: LifecycleTransition;
  error?: string;
}

function transitionGeneric<P extends string>(
  kind: "signal" | "trade" | "strategy",
  table: Record<P, P[]>,
  current: P,
  next: P,
  opts: { actor?: string; reason?: string; meta?: Record<string, unknown> } = {},
): TransitionResult<P> {
  const allowed = table[current];
  if (!allowed) {
    return {
      ok: false,
      from: current,
      next,
      error: `Unknown ${kind} phase: ${current}`,
    };
  }
  if (!allowed.includes(next)) {
    return {
      ok: false,
      from: current,
      next,
      error: `Illegal ${kind} transition: ${current} → ${next}. Allowed: [${allowed.join(", ")}]`,
    };
  }
  return {
    ok: true,
    from: current,
    next,
    transition: {
      phase: next,
      at: new Date().toISOString(),
      by: opts.actor,
      reason: opts.reason,
      meta: opts.meta,
    },
  };
}

export function transitionSignal(
  current: SignalLifecyclePhase,
  next: SignalLifecyclePhase,
  opts: { actor?: string; reason?: string; meta?: Record<string, unknown> } = {},
): TransitionResult<SignalLifecyclePhase> {
  return transitionGeneric("signal", SIGNAL_TRANSITIONS, current, next, opts);
}

export function transitionTrade(
  current: TradeLifecyclePhase,
  next: TradeLifecyclePhase,
  opts: { actor?: string; reason?: string; meta?: Record<string, unknown> } = {},
): TransitionResult<TradeLifecyclePhase> {
  return transitionGeneric("trade", TRADE_TRANSITIONS, current, next, opts);
}

export function transitionStrategy(
  current: StrategyStage,
  next: StrategyStage,
  opts: { actor?: string; reason?: string; meta?: Record<string, unknown> } = {},
): TransitionResult<StrategyStage> {
  return transitionGeneric("strategy", STRATEGY_TRANSITIONS, current, next, opts);
}

// Append a transition to an existing jsonb[] column and return the new array.
export function appendTransition(
  prev: LifecycleTransition[] | null | undefined,
  t: LifecycleTransition,
): LifecycleTransition[] {
  return Array.isArray(prev) ? [...prev, t] : [t];
}

// ─── In-candle lifecycle evaluation (stop / TP1 / TP2) ──────────
// Ported from decdec420/Trader → TradeLifecycleEngine.ts, upgraded
// to understand the TP1 ladder (half-close at 1R, stop → BE) and
// runner-phase enhancements (trailing stop, regime-flip exit).
export interface InCandleInputs {
  side: "long" | "short";
  entryPrice: number;
  stopPrice: number;
  tp1Price: number | null;
  tp2Price: number | null;
  originalSize: number;
  remainingSize: number;
  tp1Filled: boolean;
  candle: { high: number; low: number; close: number };
  /**
   * If true, the stop was already moved to breakeven after TP1.
   * The caller should track this; we read it to prevent moving twice.
   */
  stopAtBreakeven?: boolean;
  /**
   * Current market regime. When provided and the trade is in the runner
   * phase (tp1Filled=true), a regime flip against the trade direction
   * triggers an immediate exit at the candle close.
   */
  currentRegime?: string | null;
  /** R-multiple threshold before trailing begins (default 1.5). */
  trailActivationR?: number;
  /** R-multiple distance behind price the trail follows (default 0.5). */
  trailDistanceR?: number;
}

export type InCandleAction =
  | {
      type: "hold";
      /**
       * Present when the trailing stop has activated (or advanced) this
       * candle but has not yet been hit. The caller must persist this
       * value to stop_loss so the next tick's stop check reflects it.
       */
      newTrailingStop?: number;
    }
  | {
      type: "tp1_fill";
      /** fill price = tp1 */
      fillPrice: number;
      /** half the original size closes at tp1 */
      closedQty: number;
      /** stop moves to breakeven (entry price) */
      newStop: number;
    }
  | { type: "stop_hit"; fillPrice: number; closedQty: number }
  | { type: "tp2_hit"; fillPrice: number; closedQty: number }
  | {
      type: "regime_exit";
      /** exit at candle close (market order equivalent) */
      fillPrice: number;
      closedQty: number;
    };

/**
 * Compute a new trailing stop price for the runner phase (after TP1).
 *
 * Returns the updated stop if the trail has activated (or advanced) this
 * candle, or null if the candle did not reach the activation level.
 *
 * The returned value is always ≥ currentStop for longs (trail never moves
 * down) and ≤ currentStop for shorts.
 *
 * riskPerUnit is assumed to be (tp1Price - entryPrice) for long /
 * (entryPrice - tp1Price) for short, which is correct when tp1_r_mult=1.0.
 */
export function computeNewTrailingStop(
  side: "long" | "short",
  entryPrice: number,
  riskPerUnit: number,
  currentStop: number,
  candleHigh: number,
  candleLow: number,
  activationR = 1.5,
  trailDistanceR = 0.5,
): number | null {
  if (riskPerUnit <= 0) return null;
  if (side === "long") {
    const activationPrice = entryPrice + activationR * riskPerUnit;
    if (candleHigh < activationPrice) return null;
    const candidate = candleHigh - trailDistanceR * riskPerUnit;
    const newStop = Math.max(currentStop, candidate);
    return newStop !== currentStop ? newStop : null;
  }
  // short
  const activationPrice = entryPrice - activationR * riskPerUnit;
  if (candleLow > activationPrice) return null;
  const candidate = candleLow + trailDistanceR * riskPerUnit;
  const newStop = Math.min(currentStop, candidate);
  return newStop !== currentStop ? newStop : null;
}

/**
 * Returns true when the current market regime is adverse for the trade
 * direction — i.e. the regime the strategy was designed for has flipped.
 *
 * Only intended to be called in the runner phase (after TP1).
 */
export function regimeFlippedAgainstTrade(
  side: "long" | "short",
  currentRegime: string | null,
): boolean {
  if (!currentRegime) return false;
  if (side === "long") {
    return currentRegime === "trending_down" || currentRegime === "chop";
  }
  return currentRegime === "trending_up" || currentRegime === "breakout";
}

export function evaluateTradeInCandle(input: InCandleInputs): InCandleAction {
  const {
    side,
    entryPrice,
    stopPrice,
    tp1Price,
    tp2Price,
    originalSize,
    remainingSize,
    tp1Filled,
    candle,
    currentRegime,
    trailActivationR = 1.5,
    trailDistanceR = 0.5,
  } = input;

  // Long semantics. Short is mirrored.
  const hitsStop = side === "long"
    ? candle.low <= stopPrice
    : candle.high >= stopPrice;

  const hitsTp1 =
    tp1Price !== null &&
    !tp1Filled &&
    (side === "long" ? candle.high >= tp1Price : candle.low <= tp1Price);

  const hitsTp2 =
    tp2Price !== null &&
    (side === "long" ? candle.high >= tp2Price : candle.low <= tp2Price);

  // Pessimistic order: if both stop and TP1 were hit in the same candle,
  // assume stop filled first (realistic on adverse spikes).
  if (hitsStop) {
    return { type: "stop_hit", fillPrice: stopPrice, closedQty: remainingSize };
  }

  if (hitsTp1) {
    const half = Math.min(remainingSize, originalSize * 0.5);
    return {
      type: "tp1_fill",
      fillPrice: tp1Price!,
      closedQty: half,
      newStop: entryPrice,
    };
  }

  if (hitsTp2) {
    return {
      type: "tp2_hit",
      fillPrice: tp2Price!,
      closedQty: remainingSize,
    };
  }

  // ── Runner-phase enhancements ─────────────────────────────────
  // Only applies after TP1: stop is at breakeven, runner is live.
  if (tp1Filled && tp1Price !== null) {
    // riskPerUnit derived from TP1 distance (assumes tp1_r_mult = 1.0).
    const riskPerUnit = Math.abs(entryPrice - tp1Price);

    // 1. Regime-flip exit — close at market when the regime that the
    //    strategy was built for has flipped against the trade direction.
    if (regimeFlippedAgainstTrade(side, currentRegime ?? null)) {
      return {
        type: "regime_exit",
        fillPrice: candle.close,
        closedQty: remainingSize,
      };
    }

    // 2. Trailing stop — advance the stop if price has moved enough.
    //    If the new trail stop is hit in the same candle (price wicked up
    //    then reversed), treat it as a stop_hit at the trail level.
    if (riskPerUnit > 0) {
      const newTrail = computeNewTrailingStop(
        side, entryPrice, riskPerUnit, stopPrice,
        candle.high, candle.low, trailActivationR, trailDistanceR,
      );
      if (newTrail !== null) {
        const trailHit = side === "long"
          ? candle.low <= newTrail
          : candle.high >= newTrail;
        if (trailHit) {
          return { type: "stop_hit", fillPrice: newTrail, closedQty: remainingSize };
        }
        return { type: "hold", newTrailingStop: newTrail };
      }
    }
  }

  return { type: "hold" };
}
