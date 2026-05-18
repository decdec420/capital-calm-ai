import { MIN_SETUP_SCORE_LIVE } from "@/lib/regime";
import type { MarketRegime } from "@/lib/domain-types";

export type TradeDecisionLabel = "WATCHING" | "SETUP FORMING" | "ENTRY CANDIDATE" | "RISK BLOCKED";

export interface TradeDecisionOutput {
  decision: TradeDecisionLabel;
  tradeScore: number;
  topReasons: string[];
  activeBlockers: string[];
  nextLikelyTrigger: string;
  tradeAllowed: boolean;
}

const SETUP_FORMING_SCORE = 40;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function titleizeRegime(regime: MarketRegime["regime"]): string {
  return regime.replace(/_/g, " ");
}

function isTradeableRegime(regime: MarketRegime): boolean {
  return (
    regime.regime === "trending_up" ||
    regime.regime === "trending_down" ||
    regime.regime === "breakout" ||
    (regime.regime === "range" && (regime.rsiOverbought || regime.rsiOversold))
  );
}

function hardRiskBlockers(regime: MarketRegime): string[] {
  const blockers: string[] = [];
  if (regime.volatility === "extreme") blockers.push("Extreme volatility — capital protection is active.");
  if (regime.regime === "chop") blockers.push("Choppy structure — no durable edge yet.");
  if (regime.timeOfDayScore < 0.4) blockers.push("Liquidity window is thin — wait for better execution quality.");
  return blockers;
}

function opportunityBlockers(regime: MarketRegime, tradeScore: number): string[] {
  const blockers: string[] = [];
  if (tradeScore < Math.round(MIN_SETUP_SCORE_LIVE * 100)) {
    blockers.push("Setup quality is still below the live-entry bar.");
  }
  if (regime.regime === "range" && !regime.rsiOverbought && !regime.rsiOversold) {
    blockers.push("Range context has not confirmed a clean mean-reversion edge.");
  }
  if (!isTradeableRegime(regime) && regime.regime !== "range" && regime.regime !== "chop") {
    blockers.push("Market structure is not tradeable yet.");
  }
  return blockers;
}

function nextTrigger(regime: MarketRegime, tradeScore: number, activeBlockers: string[]): string {
  if (regime.volatility === "extreme") return "Waiting for volatility to normalize before any entry is considered.";
  if (regime.regime === "chop") return "Waiting for price to leave chop and build a cleaner directional structure.";
  if (regime.timeOfDayScore < 0.4) return "Waiting for a higher-liquidity trading window.";
  if (regime.regime === "range" && !regime.rsiOverbought && !regime.rsiOversold) {
    return "Waiting for a confirmed range-reversion setup; RSI is only context, not the trigger.";
  }
  if (!regime.pullback && (regime.regime === "trending_up" || regime.regime === "breakout")) {
    return "Waiting for a controlled pullback or fresh momentum confirmation.";
  }
  if (tradeScore < Math.round(MIN_SETUP_SCORE_LIVE * 100)) {
    return "Waiting for high-quality entry: stronger structure, cleaner volatility, or better timing.";
  }
  if (activeBlockers.length > 0) return "Waiting for blockers to clear before risk can be deployed.";
  return "Entry candidate is live; confirm execution plan and risk limits before acting.";
}

function topReasons(regime: MarketRegime, tradeScore: number): string[] {
  const reasons: string[] = [
    `Trade score ${tradeScore}/100 from live structure, timing, and volatility inputs.`,
    `${titleizeRegime(regime.regime)} structure with ${(clamp01(regime.confidence) * 100).toFixed(0)}% confidence.`,
    `${regime.volatility} volatility at ${regime.annualizedVolPct.toFixed(0)}% annualized.`,
  ];

  if (regime.pullback) reasons.push("Controlled pullback structure is present.");
  else if (regime.regime === "trending_up" || regime.regime === "breakout") reasons.push("Trend is constructive, but entry quality still needs confirmation.");
  else if (regime.regime === "range" && (regime.rsiOverbought || regime.rsiOversold)) reasons.push("Range-reversion context is active; RSI remains supporting context.");
  else if (regime.timeOfDayScore >= 0.55) reasons.push("Liquidity timing is acceptable for monitoring.");

  return reasons.slice(0, 4);
}

/**
 * Browser-side equivalent of the trade-decision scoring layer used to translate
 * raw regime metrics into the unified product-facing decision model.
 */
export function scoreTradeDecision(regime: MarketRegime): TradeDecisionOutput {
  const tradeScore = Math.round(clamp01(regime.setupScore) * 100);
  const riskBlockers = hardRiskBlockers(regime);
  const softBlockers = opportunityBlockers(regime, tradeScore);
  const activeBlockers = [...riskBlockers, ...softBlockers];
  const tradeAllowed = riskBlockers.length === 0 && softBlockers.length === 0 && isTradeableRegime(regime);

  let decision: TradeDecisionLabel;
  if (riskBlockers.length > 0) decision = "RISK BLOCKED";
  else if (tradeAllowed) decision = "ENTRY CANDIDATE";
  else if (tradeScore >= SETUP_FORMING_SCORE || regime.confidence >= 0.45) decision = "SETUP FORMING";
  else decision = "WATCHING";

  return {
    decision,
    tradeScore,
    topReasons: topReasons(regime, tradeScore),
    activeBlockers,
    nextLikelyTrigger: nextTrigger(regime, tradeScore, activeBlockers),
    tradeAllowed,
  };
}
