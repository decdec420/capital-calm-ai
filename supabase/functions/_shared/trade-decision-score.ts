// ============================================================
// Trade Decision Score — _shared edition (Deno-compatible)
// ------------------------------------------------------------
// Canonical, deterministic decision context that Taylor, the UI,
// and learning systems can trust when explaining why a trade was
// or was not proposed.
// ============================================================

import type { GateReason } from "./reasons.ts";
import type { RegimeResult } from "./regime.ts";

export type TradeDecisionState =
  | "TRADE_READY"
  | "WATCHLIST_READY"
  | "LOW_SCORE"
  | "RISK_BLOCKED";

export interface TradeDecisionScoreInput {
  symbol: string;
  regime: RegimeResult;
  minSetupScore: number;
  tradeableRegime: boolean;
  lockGate?: GateReason | null;
  riskGates?: GateReason[];
  warningGates?: GateReason[];
  mode?: "paper" | "live" | "research" | string;
  // Optional short-horizon context from the engine's local timeframe summary.
  timeframeTrends?: {
    "15m"?: string;
    "1h"?: string;
    "4h"?: string;
  };
}

export interface TradeDecisionScore {
  schemaVersion: "1";
  symbol: string;
  currentDecisionState: TradeDecisionState;
  tradeScore: number;
  minSetupScore: number;
  topReasons: string[];
  blockers: string[];
  blockerCodes: string[];
  hardRiskGateCodes: string[];
  nextLikelyTrigger: string;
  mode: string;
  computedAt: string;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function describeRegime(regime: RegimeResult): string {
  if (regime.regime === "range") {
    return `range regime; RSI ${regime.rsiNow.toFixed(0)} ${regime.rsiNow >= 70 ? "overbought" : regime.rsiNow <= 30 ? "oversold" : "mid-band"}`;
  }
  return `${regime.regime} regime with ${(regime.confidence * 100).toFixed(0)}% regime confidence`;
}

function nextTrigger(input: TradeDecisionScoreInput, blockers: string[]): string {
  const { regime, minSetupScore, tradeableRegime, lockGate, riskGates = [] } = input;
  const hardGate = [lockGate, ...riskGates].find((g): g is GateReason => !!g && (g.severity === "halt" || g.severity === "block"));
  if (hardGate) return hardGate.message;
  if (!tradeableRegime) return `Wait for regime to become tradeable; current regime is ${regime.regime}.`;
  if (regime.setupScore < minSetupScore) {
    const gap = Math.max(0, minSetupScore - regime.setupScore);
    if (regime.regime === "range" && regime.rsiNow > 30 && regime.rsiNow < 70) {
      return `Wait for RSI to reach a fade extreme (≥70 short or ≤30 long); current RSI is ${regime.rsiNow.toFixed(0)}.`;
    }
    return `Need setup score +${gap.toFixed(2)} to reach ${minSetupScore.toFixed(2)} via stronger confluence, cleaner pullback, or better liquidity.`;
  }
  if (blockers.length > 0) return blockers[0];
  if (regime.pullback) return "Pullback is active; next trigger is Taylor confirming entry, stop, target, and side without violating risk gates.";
  return "Next trigger is stronger near-term timing confirmation or a clean pullback/key-level reaction.";
}

export function computeTradeDecisionScore(input: TradeDecisionScoreInput): TradeDecisionScore {
  const { symbol, regime, minSetupScore, tradeableRegime, lockGate, riskGates = [], warningGates = [], mode = "unknown" } = input;
  const hardGates = [lockGate, ...riskGates].filter((g): g is GateReason => !!g && (g.severity === "halt" || g.severity === "block"));
  const blockers = uniq([
    ...hardGates.map((g) => g.message),
    ...(!tradeableRegime ? [`${regime.regime} is not an approved tradeable regime.`] : []),
    ...(regime.setupScore < minSetupScore ? [`Setup score ${regime.setupScore.toFixed(2)} is below ${minSetupScore.toFixed(2)}.`] : []),
    ...regime.noTradeReasons,
  ]);
  const hardRiskGateCodes = uniq(hardGates.map((g) => g.code));
  const warningCodes = warningGates.map((g) => g.code);

  const currentDecisionState: TradeDecisionState = hardGates.length > 0
    ? "RISK_BLOCKED"
    : !tradeableRegime || regime.setupScore < minSetupScore
    ? "LOW_SCORE"
    : warningGates.length > 0 || regime.setupScore < Math.min(1, minSetupScore + 0.10)
    ? "WATCHLIST_READY"
    : "TRADE_READY";

  // setupScore remains the primary score, but canonical hard gates crush it
  // to zero so downstream consumers cannot mistake a blocked setup for a trade.
  const baseScore = clamp01(regime.setupScore);
  const tradeScore = currentDecisionState === "RISK_BLOCKED"
    ? 0
    : currentDecisionState === "LOW_SCORE"
    ? Math.min(baseScore, minSetupScore - 0.01)
    : baseScore;

  const timeframeReasons = input.timeframeTrends
    ? [
      input.timeframeTrends["4h"] ? `4h trend: ${input.timeframeTrends["4h"]}` : "",
      input.timeframeTrends["1h"] ? `1h trend: ${input.timeframeTrends["1h"]}` : "",
      input.timeframeTrends["15m"] ? `15m timing: ${input.timeframeTrends["15m"]}` : "",
    ].filter(Boolean)
    : [];

  const topReasons = uniq([
    describeRegime(regime),
    `setup score ${regime.setupScore.toFixed(2)} vs threshold ${minSetupScore.toFixed(2)}`,
    regime.pullback ? "pullback detected near fast EMA" : "no qualifying pullback boost",
    `volatility ${regime.volatility}; liquidity score ${regime.todScore.toFixed(2)}`,
    ...timeframeReasons,
    ...warningCodes.map((code) => `warning gate active: ${code}`),
  ]).slice(0, 8);

  return {
    schemaVersion: "1",
    symbol,
    currentDecisionState,
    tradeScore: Number(tradeScore.toFixed(4)),
    minSetupScore,
    topReasons,
    blockers,
    blockerCodes: uniq([...hardRiskGateCodes, ...(!tradeableRegime ? ["NO_TRADE_REGIME"] : []), ...(regime.setupScore < minSetupScore ? ["LOW_SETUP_SCORE"] : [])]),
    hardRiskGateCodes,
    nextLikelyTrigger: nextTrigger(input, blockers),
    mode,
    computedAt: new Date().toISOString(),
  };
}

export function summarizeTradeDecisionForReplay(score: TradeDecisionScore) {
  return {
    currentDecisionState: score.currentDecisionState,
    tradeScore: score.tradeScore,
    topReasons: score.topReasons,
    blockers: score.blockers,
    blockerCodes: score.blockerCodes,
    nextLikelyTrigger: score.nextLikelyTrigger,
    computedAt: score.computedAt,
  };
}
