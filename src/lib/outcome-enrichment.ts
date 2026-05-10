// ============================================================
// Outcome Enrichment — browser-side + test edition (PR #38)
// ------------------------------------------------------------
// Contains all pure logic (types, classifiers, grade helpers,
// patch builders) plus a browser-compatible enrichDecisionMemorySimulation
// that uses globalThis.fetch.
//
// The Deno _shared edition mirrors this file and is kept in sync manually.
// Tests import from here. The edge function imports from _shared.
//
// Safety rules:
//   - No broker calls. No trade creation. No signal approval.
//   - Does not alter doctrine or risk gates.
//   - Does not enable live trading.
//   - Never stores or returns credentials.
// ============================================================

/** How far forward the simulation looked for price data. */
export type LookaheadWindow = "15m" | "1h" | "4h";

/** Canonical outcome of a forward-price simulation. */
export type SimulationResultLabel =
  | "would_have_won"     // price moved favorably for the given side
  | "would_have_lost"    // price moved adversely for the given side
  | "no_clear_edge"      // movement within the noise band
  | "insufficient_data"; // Coinbase data unavailable or side unknown

/**
 * Wendy's recommended learning action based on blocker + outcome.
 *
 * Safety: safety blocks (kill switch, daily cap, floor) always yield
 * reinforce_block regardless of what price did after the block.
 */
export type LearningAction =
  | "reinforce_block"
  | "question_block"
  | "tune_threshold"
  | "ignore_insufficient_data";

/**
 * Full simulation result stored in decision_memory_simulations.result JSONB.
 * All prices are USD. All percentages are fractions (0.05 = 5%).
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
   * Hypothetical PnL as a fraction of entry, direction-aware.
   * Long:  (exit - entry) / entry.
   * Short: (entry - exit) / entry.
   * Positive = favorable, negative = adverse.
   */
  hypothetical_pnl: number | null;
  /** Alias for hypothetical_pnl — explicit for UI clarity. */
  hypothetical_return_pct: number | null;
  /**
   * Max adverse excursion: worst intra-window move against the position.
   * Long:  (minLow  - entry) / entry  ≤ 0.
   * Short: (entry   - maxHigh) / entry ≤ 0.
   * Always ≤ 0.
   */
  max_adverse_excursion: number | null;
  /**
   * Max favorable excursion: best intra-window move in favour of the position.
   * Long:  (maxHigh - entry) / entry ≥ 0.
   * Short: (entry   - minLow) / entry ≥ 0.
   * Always ≥ 0.
   */
  max_favorable_excursion: number | null;
  /** Wendy's recommended learning action. */
  recommended_learning_action: LearningAction;
  /** ISO timestamp when enrichment ran. */
  enriched_at: string;
  /** Populated only when result_label = insufficient_data. */
  insufficient_data_reason: string | null;
  /**
   * The direction used to score this simulation.
   * Null when side was unknown — metrics are not direction-adjusted.
   */
  simulated_side: "long" | "short" | null;
}

/** Lifecycle status of a simulation row. */
export type SimulationStatus = "queued" | "running" | "completed" | "failed";

/** A single row from decision_memory_simulations. */
export interface DecisionMemorySimulationRow {
  id: string;
  decision_memory_id: string;
  user_id: string;
  simulation_type: string;
  lookahead_window: LookaheadWindow;
  status: SimulationStatus;
  result: SimulationResult | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** Wendy grade assigned to a completed trade's replay packet. */
export type WendyGrade = "A" | "B" | "C" | "D" | "F";

/**
 * Safe outcome fields patched into trade_signals.replay_packet after close.
 * Never contains credentials, broker IDs, or strategy internals.
 */
export interface ReplayPacketOutcomePatch {
  actualOutcome: "win" | "loss" | "breakeven";
  wendyGrade: WendyGrade;
  outcomeRecordedAt: string;
  realizedPnl: number | null;
  realizedPnlPct: number | null;
  exitReason: string | null;
  holdDurationHours: number | null;
}

// ─── Safety block registry ────────────────────────────────────────────────────

/**
 * Structural safety block codes that must NEVER be classified as
 * question_block or tune_threshold, regardless of market outcome.
 *
 * Critical invariant: a kill-switch block that "missed" an up-move is
 * still a correct block. The safety invariant was met regardless of
 * what price did after the block fired.
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
 * Matrix:
 *   ANY safety block            → reinforce_block (regardless of outcome)
 *   insufficient_data           → ignore_insufficient_data
 *   no_clear_edge               → ignore_insufficient_data
 *   COACH_PENALTY + won         → question_block
 *   COACH_PENALTY + lost        → reinforce_block
 *   LOW_CONFIDENCE + won        → tune_threshold
 *   LOW_CONFIDENCE + lost       → reinforce_block
 *   RISK_MANAGER_VETO + won     → question_block
 *   RISK_MANAGER_VETO + lost    → reinforce_block
 *   Other non-safety + won      → question_block
 *   Other non-safety + lost     → reinforce_block
 */
export function classifyLearningAction(
  blockerCodes: string[],
  resultLabel: SimulationResultLabel,
): LearningAction {
  // Safety blocks are ALWAYS reinforced. This is the most important invariant.
  if (hasSafetyBlock(blockerCodes)) {
    return "reinforce_block";
  }

  if (resultLabel === "insufficient_data" || resultLabel === "no_clear_edge") {
    return "ignore_insufficient_data";
  }

  if (resultLabel === "would_have_won") {
    const primary = blockerCodes[0] ?? "";
    if (primary === "LOW_CONFIDENCE") return "tune_threshold";
    return "question_block";
  }

  // would_have_lost → block was correct
  return "reinforce_block";
}

// ─── Lookahead configuration ──────────────────────────────────────────────────

/**
 * Minimum age a decision must be before enrichment is attempted.
 * We need at least one full lookahead window of historical data to exist.
 */
export const MIN_ENRICHMENT_AGE_SECONDS: Record<LookaheadWindow, number> = {
  "15m": 900,
  "1h":  3600,
  "4h":  14400,
};

const LOOKAHEAD_CONFIG: Record<
  LookaheadWindow,
  { windowSeconds: number; granularitySeconds: number }
> = {
  "15m": { windowSeconds: 900,   granularitySeconds: 900 },
  "1h":  { windowSeconds: 3600,  granularitySeconds: 3600 },
  "4h":  { windowSeconds: 14400, granularitySeconds: 3600 }, // 1h granularity aggregated
};

// ─── Candle type ──────────────────────────────────────────────────────────────

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

// ─── Coinbase historical candle fetch ─────────────────────────────────────────

const CB = "https://api.exchange.coinbase.com";

/**
 * Minimum price move (as fraction) to declare a win or loss.
 * Moves within this band are classified as no_clear_edge.
 * 0.3% ≈ rough estimate of round-trip fees + slippage for crypto.
 */
const EDGE_THRESHOLD = 0.003;

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
    if (!r.ok) return null;
    const raw = (await r.json()) as number[][];
    if (!Array.isArray(raw) || raw.length === 0) return null;
    // Coinbase returns [time, low, high, open, close, volume] newest-first.
    return [...raw]
      .sort((a, b) => a[0] - b[0])
      .map(([t, l, h, o, c, v]) => ({ t, l, h, o, c, v }));
  } catch {
    return null;
  }
}

// ─── Direction-aware hypothetical metrics ─────────────────────────────────────

interface HypotheticalMetrics {
  entryPrice: number;
  exitPrice: number;
  /** Direction-adjusted return: positive = favorable, negative = adverse. */
  returnPct: number;
  /** Max adverse excursion ≤ 0 (worst move against the position). */
  mae: number;
  /** Max favorable excursion ≥ 0 (best move in favour of the position). */
  mfe: number;
}

/**
 * Compute hypothetical metrics from candle data, direction-aware.
 *
 * Long:
 *   returnPct = (exit - entry) / entry
 *   MFE       = (maxHigh - entry) / entry  ≥ 0
 *   MAE       = (minLow  - entry) / entry  ≤ 0
 *
 * Short:
 *   returnPct = (entry - exit) / entry
 *   MFE       = (entry - minLow)  / entry  ≥ 0  (price fell — favorable)
 *   MAE       = (entry - maxHigh) / entry  ≤ 0  (price rose — adverse)
 */
function computeHypotheticalMetrics(
  candles: Candle[],
  side: "long" | "short",
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

  if (side === "short") {
    return {
      entryPrice,
      exitPrice,
      returnPct: (entryPrice - exitPrice) / entryPrice,
      mae: (entryPrice - maxHigh) / entryPrice, // ≤ 0 when price rose (adverse)
      mfe: (entryPrice - minLow)  / entryPrice, // ≥ 0 when price fell (favorable)
    };
  }

  // long
  return {
    entryPrice,
    exitPrice,
    returnPct: (exitPrice - entryPrice) / entryPrice,
    mae: (minLow  - entryPrice) / entryPrice, // ≤ 0
    mfe: (maxHigh - entryPrice) / entryPrice, // ≥ 0
  };
}

// ─── Main enrichment entry point ──────────────────────────────────────────────

export interface EnrichmentInput {
  symbol: string | null;
  blockerCodes: string[];
  decisionRanAt: string | null;
  lookaheadWindow: LookaheadWindow;
  /**
   * Trade direction for the hypothetical. Required for correct scoring.
   * When null: prices are fetched if possible but the result is marked
   * insufficient_data (missing_side) — no direction-dependent learning
   * actions (question_block / tune_threshold) are generated.
   */
  side: "long" | "short" | null;
}

/**
 * Enrich a single blocked/vetoed decision with forward price data.
 *
 * Fetches Coinbase candles starting at decisionRanAt, computes hypothetical
 * direction-aware outcome, and classifies Wendy's learning action.
 *
 * Direction math:
 *   Long  win  → price rises beyond threshold.
 *   Short win  → price falls beyond threshold.
 *   MFE/MAE always signed: MFE ≥ 0, MAE ≤ 0, from the position's perspective.
 *
 * Missing side:
 *   If side is null, entry/exit prices are recorded where available but
 *   result_label = "insufficient_data" with reason "missing_side".
 *   recommended_learning_action = "ignore_insufficient_data".
 *   No question_block or tune_threshold is generated without a known side.
 *
 * Safety: pure analysis. Cannot place trades, approve signals, or alter doctrine.
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
    simulated_side: null,
  });

  if (!input.symbol) {
    return insufficientResult("no symbol — account-level halts cannot be enriched");
  }
  if (!input.decisionRanAt) {
    return insufficientResult("no ranAt timestamp in replay_packet");
  }

  const decisionMs = Date.parse(input.decisionRanAt);
  if (isNaN(decisionMs)) {
    return insufficientResult(`invalid ranAt timestamp: ${input.decisionRanAt}`);
  }

  const ageSeconds = (Date.now() - decisionMs) / 1000;
  const minAge = MIN_ENRICHMENT_AGE_SECONDS[input.lookaheadWindow];
  if (ageSeconds < minAge) {
    return insufficientResult(
      `decision is too recent (${ageSeconds.toFixed(0)}s old, need ${minAge}s) — ` +
        `forward price data not yet available`,
    );
  }

  const { windowSeconds, granularitySeconds } = LOOKAHEAD_CONFIG[input.lookaheadWindow];
  const startIso = new Date(decisionMs).toISOString();
  const endIso = new Date(decisionMs + windowSeconds * 1000).toISOString();

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

  // Side is required for direction-aware scoring.
  // Record prices but refuse to produce a directional outcome without it.
  if (!input.side) {
    return {
      result_label: "insufficient_data",
      simulated_entry_price: candles[0].o,
      simulated_exit_price: candles[candles.length - 1].c,
      lookahead_window: input.lookaheadWindow,
      hypothetical_pnl: null,
      hypothetical_return_pct: null,
      max_adverse_excursion: null,
      max_favorable_excursion: null,
      recommended_learning_action: "ignore_insufficient_data",
      enriched_at: enrichedAt,
      insufficient_data_reason:
        "missing_side — direction unknown, cannot score hypothetical outcome",
      simulated_side: null,
    };
  }

  const metrics = computeHypotheticalMetrics(candles, input.side);
  if (!metrics) {
    return insufficientResult("could not compute metrics — invalid candle data");
  }

  let resultLabel: SimulationResultLabel;
  if (metrics.returnPct > EDGE_THRESHOLD) {
    resultLabel = "would_have_won";
  } else if (metrics.returnPct < -EDGE_THRESHOLD) {
    resultLabel = "would_have_lost";
  } else {
    resultLabel = "no_clear_edge";
  }

  return {
    result_label: resultLabel,
    simulated_entry_price: metrics.entryPrice,
    simulated_exit_price: metrics.exitPrice,
    lookahead_window: input.lookaheadWindow,
    hypothetical_pnl: metrics.returnPct,
    hypothetical_return_pct: metrics.returnPct,
    max_adverse_excursion: metrics.mae,
    max_favorable_excursion: metrics.mfe,
    recommended_learning_action: classifyLearningAction(input.blockerCodes, resultLabel),
    enriched_at: enrichedAt,
    insufficient_data_reason: null,
    simulated_side: input.side,
  };
}

// ─── Replay packet patch helpers ──────────────────────────────────────────────

/**
 * Derive a Wendy grade for a completed trade.
 * Reflects process quality, not raw outcome.
 *
 *   A — win, well-calibrated (|calDelta| ≤ 0.15)
 *   B — win (loosely calibrated or no confidence data)
 *   C — breakeven, or loss + well-calibrated (calDelta ≤ 0.25)
 *   D — loss + moderately overconfident (0.25 < calDelta ≤ 0.5)
 *   F — loss + severely overconfident (calDelta > 0.5)
 */
export function deriveWendyGrade(
  outcome: "win" | "loss" | "breakeven",
  confidence: number | null,
): WendyGrade {
  const realized = outcome === "win" ? 1 : outcome === "loss" ? 0 : 0.5;
  const calDelta = confidence != null ? confidence - realized : null;

  if (outcome === "win") {
    if (calDelta != null && Math.abs(calDelta) <= 0.15) return "A";
    return "B";
  }
  if (outcome === "breakeven") return "C";
  if (calDelta == null) return "C";
  if (calDelta <= 0.25) return "C";
  if (calDelta <= 0.5) return "D";
  return "F";
}

/**
 * Build the safe metadata patch for a replay packet after trade close.
 * Only non-sensitive outcome fields — no credentials, no PII.
 * Merge this into the existing replay_packet JSONB (additive patch).
 */
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
      ? (Date.parse(params.closedAt) - Date.parse(params.openedAt)) / 3_600_000
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

// ─── Display helpers (browser / UI) ──────────────────────────────────────────

export const RESULT_LABEL_DISPLAY: Record<SimulationResultLabel, string> = {
  would_have_won: "Would have won",
  would_have_lost: "Would have lost",
  no_clear_edge: "No clear edge",
  insufficient_data: "Insufficient data",
};

export const LEARNING_ACTION_DISPLAY: Record<LearningAction, string> = {
  reinforce_block: "Reinforce block",
  question_block: "Question this block",
  tune_threshold: "Tune threshold",
  ignore_insufficient_data: "Ignore (no data)",
};

export const WENDY_GRADE_DISPLAY: Record<WendyGrade, string> = {
  A: "A — Textbook process",
  B: "B — Good process",
  C: "C — Acceptable / breakeven",
  D: "D — Overconfident",
  F: "F — Severely overconfident",
};

/** Returns true when the simulation has an actionable win/loss outcome. */
export function isActionable(result: SimulationResult): boolean {
  return (
    result.result_label === "would_have_won" ||
    result.result_label === "would_have_lost"
  );
}

/** Returns true when the result suggests the block should be reviewed. */
export function suggestsReview(result: SimulationResult): boolean {
  return (
    result.recommended_learning_action === "question_block" ||
    result.recommended_learning_action === "tune_threshold"
  );
}

/** Human-readable one-liner for the Learning page. */
export function simulationSummary(result: SimulationResult): string {
  if (result.result_label === "insufficient_data") {
    return `No data: ${result.insufficient_data_reason ?? "unknown reason"}`;
  }
  if (result.result_label === "no_clear_edge") {
    const pct =
      result.hypothetical_return_pct != null
        ? ` (${(result.hypothetical_return_pct * 100).toFixed(2)}%)`
        : "";
    return `No clear edge${pct} in ${result.lookahead_window} window`;
  }
  const dir = result.result_label === "would_have_won" ? "▲" : "▼";
  const pct =
    result.hypothetical_return_pct != null
      ? ` ${(Math.abs(result.hypothetical_return_pct) * 100).toFixed(2)}%`
      : "";
  return `${dir}${pct} in ${result.lookahead_window} — ${LEARNING_ACTION_DISPLAY[result.recommended_learning_action]}`;
}
