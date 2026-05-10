// ============================================================
// Outcome Enrichment — _shared edition (Deno-compatible)
// ------------------------------------------------------------
// PR #38: Enriches decision_memory_simulations with forward
// price data so Wendy can learn from what would have happened
// if a blocked/vetoed/skipped signal had been executed.
//
// Safety invariants — this module NEVER:
//   - Calls the broker or places/approves orders.
//   - Stores credentials, API keys, or auth headers.
//   - Weakens risk gates or alters doctrine.
//   - Enables live trading or changes paper/live mode.
//   - Creates trade rows or modifies trade behavior.
//   - Approves signals.
//
// This is learning-only. All reads are from public Coinbase
// REST endpoints. All writes go to decision_memory_simulations.
// ============================================================

/** How far forward we look for price data after the decision time. */
export type LookaheadWindow = "15m" | "1h" | "4h";

/** Canonical outcome of running the simulation. */
export type SimulationResultLabel =
  | "would_have_won"    // price moved favorably beyond the edge threshold
  | "would_have_lost"   // price moved adversely beyond the edge threshold
  | "no_clear_edge"     // price movement within the noise band
  | "insufficient_data"; // Coinbase data unavailable for this time range

/**
 * Wendy's recommended learning action based on blocker + outcome.
 *
 * Safety: safety blocks (kill switch, daily cap, floor) always get
 * reinforce_block regardless of what price did — these blocks are
 * structurally correct even when "missed profit" occurred.
 */
export type LearningAction =
  | "reinforce_block"        // block was correct, reinforce
  | "question_block"         // market moved favorably — should we review this block?
  | "tune_threshold"         // block code is a threshold (conf, setup) — may need adjustment
  | "ignore_insufficient_data"; // not enough data to learn from

/**
 * Full simulation result stored in decision_memory_simulations.result JSONB.
 * All prices are in USD. All percentages are as fractions (0.05 = 5%).
 */
export interface SimulationResult {
  result_label: SimulationResultLabel;
  /** First-candle open price used as simulated entry (USD). */
  simulated_entry_price: number | null;
  /** Last-candle close price used as simulated exit (USD). */
  simulated_exit_price: number | null;
  /** Lookahead window used for this enrichment. */
  lookahead_window: LookaheadWindow;
  /**
   * Hypothetical PnL as a fraction of entry.
   * For a long bias: (exit - entry) / entry.
   * Positive = favorable, negative = adverse.
   */
  hypothetical_pnl: number | null;
  /** Same as hypothetical_pnl — explicit alias for clarity. */
  hypothetical_return_pct: number | null;
  /**
   * Max adverse excursion: worst intra-window drawdown from entry.
   * (minLow - entry) / entry — always <= 0 for a long bias.
   */
  max_adverse_excursion: number | null;
  /**
   * Max favorable excursion: best intra-window gain from entry.
   * (maxHigh - entry) / entry — always >= 0 for a long bias.
   */
  max_favorable_excursion: number | null;
  /** Wendy's recommended learning action. */
  recommended_learning_action: LearningAction;
  /** ISO timestamp when enrichment ran. */
  enriched_at: string;
  /** Populated only when result_label = insufficient_data. */
  insufficient_data_reason: string | null;
}

// ─── Candle type (matches market.ts) ─────────────────────────────────────────
interface Candle {
  t: number; // unix seconds (candle open)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

// ─── Safety block registry ────────────────────────────────────────────────────

/**
 * Blocker codes that represent structural safety controls.
 *
 * Critical rule: these blocks must NEVER be classified as "question_block"
 * or "tune_threshold" just because price moved favorably afterward.
 * A kill-switch block that "missed" an up-move is still a correct block —
 * the safety invariant was met regardless of market outcome.
 */
const SAFETY_BLOCK_CODES = new Set([
  "KILL_SWITCH_ACTIVE",
  "DAILY_LOSS_CAP_REACHED",
  "ACCOUNT_FLOOR_BREACHED",
  "MAX_TRADES_REACHED",
  "COOLDOWN_ACTIVE",
  "DOCTRINE_BLOCK",
  "RISK_GATE_BLOCK",
]);

/** Returns true if ANY code in the array is a structural safety block. */
export function hasSafetyBlock(blockerCodes: string[]): boolean {
  return blockerCodes.some((c) => SAFETY_BLOCK_CODES.has(c));
}

// ─── Wendy learning classifier ────────────────────────────────────────────────

/**
 * Classify the recommended learning action from a simulation result.
 *
 * Classification matrix:
 *   ANY safety block code          → reinforce_block (regardless of outcome)
 *   insufficient_data              → ignore_insufficient_data
 *   COACH_PENALTY + won            → question_block
 *   COACH_PENALTY + lost           → reinforce_block
 *   LOW_CONFIDENCE + won           → tune_threshold
 *   LOW_CONFIDENCE + lost          → reinforce_block
 *   RISK_MANAGER_VETO + won        → question_block
 *   RISK_MANAGER_VETO + lost       → reinforce_block
 *   Other non-safety + won         → question_block
 *   Other non-safety + lost        → reinforce_block
 *   no_clear_edge                  → ignore_insufficient_data
 */
export function classifyLearningAction(
  blockerCodes: string[],
  resultLabel: SimulationResultLabel,
): LearningAction {
  // Safety blocks are ALWAYS reinforced regardless of price outcome.
  // This is the most important invariant in this entire module.
  if (hasSafetyBlock(blockerCodes)) {
    return "reinforce_block";
  }

  if (resultLabel === "insufficient_data" || resultLabel === "no_clear_edge") {
    return "ignore_insufficient_data";
  }

  if (resultLabel === "would_have_won") {
    // Which non-safety blocker caused this to be missed?
    const primary = blockerCodes[0] ?? "";
    if (primary === "LOW_CONFIDENCE") return "tune_threshold";
    // COACH_PENALTY, RISK_MANAGER_VETO, NO_TRADE_REGIME, etc.
    return "question_block";
  }

  // would_have_lost → the block was correct
  return "reinforce_block";
}

// ─── Lookahead configuration ──────────────────────────────────────────────────

const LOOKAHEAD_CONFIG: Record<
  LookaheadWindow,
  { windowSeconds: number; granularitySeconds: number }
> = {
  "15m": { windowSeconds: 900,  granularitySeconds: 900 },
  "1h":  { windowSeconds: 3600, granularitySeconds: 3600 },
  "4h":  { windowSeconds: 14400, granularitySeconds: 3600 }, // 1h candles aggregated to 4h
};

/**
 * Minimum age a decision must be before we can enrich it.
 * We need at least one full lookahead window of historical data.
 */
export const MIN_ENRICHMENT_AGE_SECONDS: Record<LookaheadWindow, number> = {
  "15m": 900,
  "1h":  3600,
  "4h":  14400,
};

// ─── Coinbase historical candle fetch ────────────────────────────────────────

const CB = "https://api.exchange.coinbase.com";

/**
 * Fetch historical candles from Coinbase Exchange for a specific time window.
 *
 * Uses public REST endpoint — no auth required.
 * Returns null if data is unavailable (network error, 4xx, empty response).
 * Never throws — callers treat null as insufficient_data.
 *
 * Security: this function is read-only. It cannot place orders, read account
 * data, or access any authenticated endpoint.
 */
async function fetchHistoricalCandles(
  symbol: string,
  startIso: string,
  endIso: string,
  granularitySeconds: number,
): Promise<Candle[] | null> {
  const url =
    `${CB}/products/${symbol}/candles` +
    `?granularity=${granularitySeconds}` +
    `&start=${encodeURIComponent(startIso)}` +
    `&end=${encodeURIComponent(endIso)}`;

  try {
    const r = await fetch(url);
    if (!r.ok) {
      console.warn(
        `[outcome-enrichment] Coinbase ${symbol} candles HTTP ${r.status}`,
      );
      return null;
    }
    const raw = (await r.json()) as number[][];
    if (!Array.isArray(raw) || raw.length === 0) return null;

    // Coinbase returns [time, low, high, open, close, volume] newest-first.
    return [...raw]
      .sort((a, b) => a[0] - b[0])
      .map(([t, l, h, o, c, v]) => ({ t, l, h, o, c, v }));
  } catch (e) {
    console.warn(
      `[outcome-enrichment] candle fetch error: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return null;
  }
}

// ─── Hypothetical metrics ─────────────────────────────────────────────────────

/**
 * Minimum price move (as fraction) to declare a win or loss.
 * Moves within this band are classified as no_clear_edge.
 * 0.3% ≈ rough estimate of round-trip fees + slippage for crypto.
 */
const EDGE_THRESHOLD = 0.003;

interface HypotheticalMetrics {
  entryPrice: number;
  exitPrice: number;
  returnPct: number;    // (exit - entry) / entry
  mae: number;          // max adverse excursion ≤ 0
  mfe: number;          // max favorable excursion ≥ 0
}

/**
 * Compute hypothetical long-bias metrics from candle data.
 * Uses first-candle open as entry, last-candle close as exit.
 * MAE/MFE scan all intra-window highs and lows.
 *
 * Long bias is the correct approximation for signals that were
 * blocked/vetoed in a trending or bullish regime. The direction
 * assumption is noted in the result so future PRs can refine with
 * explicit side data from the replay_packet.meta field.
 */
function computeHypotheticalMetrics(
  candles: Candle[],
): HypotheticalMetrics | null {
  if (candles.length === 0) return null;

  const entryPrice = candles[0].o;
  if (entryPrice <= 0) return null;

  const exitPrice = candles[candles.length - 1].c;

  let minLow = Infinity;
  let maxHigh = -Infinity;
  for (const c of candles) {
    if (c.l < minLow) minLow = c.l;
    if (c.h > maxHigh) maxHigh = c.h;
  }

  const returnPct = (exitPrice - entryPrice) / entryPrice;
  const mae = (minLow - entryPrice) / entryPrice;   // ≤ 0
  const mfe = (maxHigh - entryPrice) / entryPrice;  // ≥ 0

  return { entryPrice, exitPrice, returnPct, mae, mfe };
}

// ─── Main enrichment entry point ──────────────────────────────────────────────

/**
 * Parameters accepted by enrichDecisionMemorySimulation().
 * Extracted from the decision_memory row at enrichment time.
 */
export interface EnrichmentInput {
  /** Symbol being evaluated (e.g. "BTC-USD"). Null → insufficient_data. */
  symbol: string | null;
  /** All blocker codes that caused this non-trade. */
  blockerCodes: string[];
  /** ISO timestamp when the signal engine evaluated this decision. */
  decisionRanAt: string | null;
  /** How far forward to look for price data. */
  lookaheadWindow: LookaheadWindow;
}

/**
 * Enrich a single decision with forward price data.
 *
 * This is the core of PR #38. Given a blocked/vetoed/skipped decision,
 * fetch Coinbase candles starting at the decision time and compute:
 *   - What price would we have entered at?
 *   - What did price do in the lookahead window?
 *   - Should Wendy reinforce, question, or tune the threshold?
 *
 * Safety: this function is pure analysis. It cannot place trades,
 * approve signals, or alter doctrine.
 */
export async function enrichDecisionMemorySimulation(
  input: EnrichmentInput,
): Promise<SimulationResult> {
  const enrichedAt = new Date().toISOString();

  const insufficientResult = (reason: string): SimulationResult => ({
    result_label: "insufficient_data",
    simulated_entry_price: null,
    simulated_exit_price: null,
    lookahead_window: input.lookaheadWindow,
    hypothetical_pnl: null,
    hypothetical_return_pct: null,
    max_adverse_excursion: null,
    max_favorable_excursion: null,
    recommended_learning_action: "ignore_insufficient_data",
    enriched_at: enrichedAt,
    insufficient_data_reason: reason,
  });

  // ── Guard: symbol required ────────────────────────────────────────────────
  if (!input.symbol) {
    return insufficientResult("no symbol — account-level halts cannot be enriched");
  }

  // ── Guard: decision timestamp required ───────────────────────────────────
  if (!input.decisionRanAt) {
    return insufficientResult("no ranAt timestamp in replay_packet");
  }

  const decisionMs = Date.parse(input.decisionRanAt);
  if (isNaN(decisionMs)) {
    return insufficientResult(`invalid ranAt timestamp: ${input.decisionRanAt}`);
  }

  // ── Guard: decision must be old enough for forward data to exist ──────────
  const nowMs = Date.now();
  const ageSeconds = (nowMs - decisionMs) / 1000;
  const minAge = MIN_ENRICHMENT_AGE_SECONDS[input.lookaheadWindow];
  if (ageSeconds < minAge) {
    return insufficientResult(
      `decision is too recent (${ageSeconds.toFixed(0)}s old, need ${minAge}s) — ` +
        `forward price data not yet available`,
    );
  }

  // ── Compute time range ────────────────────────────────────────────────────
  const { windowSeconds, granularitySeconds } =
    LOOKAHEAD_CONFIG[input.lookaheadWindow];

  const startDate = new Date(decisionMs);
  const endDate = new Date(decisionMs + windowSeconds * 1000);
  const startIso = startDate.toISOString();
  const endIso = endDate.toISOString();

  // ── Fetch historical candles ──────────────────────────────────────────────
  const candles = await fetchHistoricalCandles(
    input.symbol,
    startIso,
    endIso,
    granularitySeconds,
  );

  if (!candles || candles.length === 0) {
    return insufficientResult(
      `Coinbase returned no candles for ${input.symbol} ` +
        `between ${startIso} and ${endIso} (granularity=${granularitySeconds}s)`,
    );
  }

  // ── Compute hypothetical metrics ──────────────────────────────────────────
  const metrics = computeHypotheticalMetrics(candles);
  if (!metrics) {
    return insufficientResult("could not compute metrics — invalid candle data");
  }

  // ── Classify outcome ──────────────────────────────────────────────────────
  let resultLabel: SimulationResultLabel;
  if (metrics.returnPct > EDGE_THRESHOLD) {
    resultLabel = "would_have_won";
  } else if (metrics.returnPct < -EDGE_THRESHOLD) {
    resultLabel = "would_have_lost";
  } else {
    resultLabel = "no_clear_edge";
  }

  // ── Classify Wendy learning action ────────────────────────────────────────
  const learningAction = classifyLearningAction(input.blockerCodes, resultLabel);

  return {
    result_label: resultLabel,
    simulated_entry_price: metrics.entryPrice,
    simulated_exit_price: metrics.exitPrice,
    lookahead_window: input.lookaheadWindow,
    hypothetical_pnl: metrics.returnPct,
    hypothetical_return_pct: metrics.returnPct,
    max_adverse_excursion: metrics.mae,
    max_favorable_excursion: metrics.mfe,
    recommended_learning_action: learningAction,
    enriched_at: enrichedAt,
    insufficient_data_reason: null,
  };
}

// ─── Replay packet patch helpers ─────────────────────────────────────────────

/**
 * Derive a Wendy grade for a completed trade's replay packet.
 *
 * Grades reflect decision quality (process), not just outcome:
 *   A — win, well-calibrated (calDelta ≤ 0.15)
 *   B — win, loosely calibrated or data unavailable
 *   C — breakeven, or loss + well-calibrated (calDelta ≤ 0.25)
 *   D — loss + moderately overconfident (0.25 < calDelta ≤ 0.5)
 *   F — loss + highly overconfident (calDelta > 0.5)
 *
 * calDelta = confidence - realized (1=win, 0=loss).
 * Positive calDelta = overconfident; negative = underconfident.
 */
export function deriveWendyGrade(
  outcome: "win" | "loss" | "breakeven",
  confidence: number | null,
): "A" | "B" | "C" | "D" | "F" {
  const realized = outcome === "win" ? 1 : outcome === "loss" ? 0 : 0.5;
  const calDelta =
    confidence != null ? confidence - realized : null;

  if (outcome === "win") {
    if (calDelta != null && Math.abs(calDelta) <= 0.15) return "A";
    return "B";
  }
  if (outcome === "breakeven") return "C";
  // loss:
  if (calDelta == null) return "C";
  if (calDelta <= 0.25) return "C";
  if (calDelta <= 0.5) return "D";
  return "F";
}

/**
 * Build the safe metadata patch for a replay packet after trade close.
 * Only non-sensitive outcome fields — no credentials, no PII, no strategy
 * internals that should not be stored.
 *
 * This patch is merged into the existing replay_packet JSONB by the caller.
 * It does NOT replace the full packet — it only adds the outcome fields.
 */
export interface ReplayPacketOutcomePatch {
  actualOutcome: "win" | "loss" | "breakeven";
  wendyGrade: "A" | "B" | "C" | "D" | "F";
  outcomeRecordedAt: string;
  realizedPnl: number | null;
  realizedPnlPct: number | null;
  exitReason: string | null;
  holdDurationHours: number | null;
}

export function buildReplayPacketOutcomePatch(params: {
  outcome: "win" | "loss" | "breakeven";
  confidence: number | null;
  pnl: number | null;
  pnlPct: number | null;
  openedAt: string | null;
  closedAt: string | null;
  notes: string | null;
}): ReplayPacketOutcomePatch {
  const holdDurationHours =
    params.openedAt && params.closedAt
      ? (Date.parse(params.closedAt) - Date.parse(params.openedAt)) /
        3_600_000
      : null;

  return {
    actualOutcome: params.outcome,
    wendyGrade: deriveWendyGrade(params.outcome, params.confidence),
    outcomeRecordedAt: new Date().toISOString(),
    realizedPnl: params.pnl,
    realizedPnlPct: params.pnlPct,
    exitReason: params.notes ?? null,
    holdDurationHours,
  };
}
