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
// to understand the TP1 ladder (half-close at 1R, stop → BE).
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
}

export type InCandleAction =
  | { type: "hold" }
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
  | { type: "tp2_hit"; fillPrice: number; closedQty: number };

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

  return { type: "hold" };
}
