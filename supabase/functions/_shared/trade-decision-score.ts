import type { RegimeResult, VolatilityState } from "./regime.ts";
import type { GateReason } from "./reasons.ts";

export type TradeDecisionState =
  | "WATCHING"
  | "SETUP_FORMING"
  | "ENTRY_CANDIDATE"
  | "TRADE_ALLOWED"
  | "RISK_BLOCKED";

export interface RsiContext {
  now?: number | null;
  previous?: number | null;
  recent?: Array<number | null | undefined>;
}

export interface EmaContext {
  fast?: number | null;
  slow?: number | null;
  slowRising?: boolean | null;
  pullback?: boolean | null;
}

export interface MarketIntelligenceContext {
  momentum1h?: string | null;
  momentum4h?: string | null;
  momentumAgeMinutes?: number | null;
  maxAgeMinutes?: number | null;
  volumeRatio?: number | null;
  volumeTrend?: "rising" | "falling" | "flat" | string | null;
  stale?: boolean | null;
  summary?: string | null;
}

export interface OpenPositionContext {
  hasOpenPosition?: boolean | null;
  openPositionCount?: number | null;
  hasPendingSignal?: boolean | null;
}

export interface PortfolioAccountContext {
  equityUsd?: number | null;
  dailyRealizedPnlUsd?: number | null;
  dailyTradeCount?: number | null;
  bookExposureUsd?: number | null;
  killSwitchEngaged?: boolean | null;
  botStatus?: string | null;
}

export interface TradeDecisionScoreInput {
  regime: RegimeResult;
  rsi?: RsiContext;
  ema?: EmaContext;
  marketIntelligence?: MarketIntelligenceContext | null;
  volatility?: VolatilityState | null;
  riskGates?: GateReason[];
  openPosition?: OpenPositionContext | null;
  portfolio?: PortfolioAccountContext | null;
}

export interface TradeDecisionScoreResult {
  score: number;
  state: TradeDecisionState;
  reasons: string[];
  blockers: string[];
  riskBlocked: boolean;
  nextLikelyTrigger: string | null;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatScore(value: number): string {
  return String(Math.round(value));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function isHardRiskGate(gate: GateReason): boolean {
  return gate.severity === "halt" || gate.severity === "block";
}

function deriveMappedState(score: number): Exclude<TradeDecisionState, "RISK_BLOCKED"> {
  if (score < 40) return "WATCHING";
  if (score < 60) return "SETUP_FORMING";
  if (score < 75) return "ENTRY_CANDIDATE";
  return "TRADE_ALLOWED";
}

function deriveNextLikelyTrigger(
  state: TradeDecisionState,
  score: number,
  blockers: string[],
  regime: RegimeResult,
): string | null {
  if (state === "RISK_BLOCKED") {
    return blockers.length > 0 ? `Clear blocker: ${blockers[0]}` : "Clear hard risk gate.";
  }
  if (state === "TRADE_ALLOWED") return null;

  const remaining = state === "WATCHING"
    ? Math.max(0, 40 - score)
    : state === "SETUP_FORMING"
    ? Math.max(0, 60 - score)
    : Math.max(0, 75 - score);

  if (regime.volatility === "extreme") return "Volatility must cool below extreme.";
  if (regime.regime === "range" && regime.rsiNow > 30 && regime.rsiNow < 70) {
    return "Range setup needs RSI at an extreme (≤30 or ≥70).";
  }
  if (state === "ENTRY_CANDIDATE") {
    return `Need about ${formatScore(remaining)} more decision point(s) for TRADE_ALLOWED.`;
  }
  return `Need about ${formatScore(remaining)} more decision point(s) for the next setup state.`;
}

export function computeTradeDecisionScore(input: TradeDecisionScoreInput): TradeDecisionScoreResult {
  const { regime } = input;
  const reasons: string[] = [];
  const blockers: string[] = [];

  const setupScore = Math.max(0, Math.min(1, finiteNumber(regime.setupScore) ?? 0));
  const confidence = Math.max(0, Math.min(1, finiteNumber(regime.confidence) ?? 0));
  let score = setupScore * 100;

  reasons.push(`Setup score ${setupScore.toFixed(2)} contributes ${formatScore(setupScore * 100)} point(s).`);
  reasons.push(`Regime ${regime.regime} with confidence ${confidence.toFixed(2)}.`);

  const rsiNow = finiteNumber(input.rsi?.now) ?? finiteNumber(regime.rsiNow);
  const rsiPrev = finiteNumber(input.rsi?.previous) ?? finiteNumber(regime.rsiPrev);
  if (rsiNow !== null) {
    const rsiDirection = rsiPrev === null
      ? "flat"
      : rsiNow > rsiPrev
      ? "rising"
      : rsiNow < rsiPrev
      ? "falling"
      : "flat";
    reasons.push(`RSI ${rsiNow.toFixed(1)} (${rsiDirection}).`);
  }

  const emaFast = finiteNumber(input.ema?.fast) ?? finiteNumber(regime.emaFast);
  const emaSlow = finiteNumber(input.ema?.slow) ?? finiteNumber(regime.emaSlow);
  const slowRising = input.ema?.slowRising ?? regime.slowRising;
  const pullback = input.ema?.pullback ?? regime.pullback;
  if (emaFast !== null && emaSlow !== null && emaSlow > 0) {
    const emaSpreadPct = ((emaFast - emaSlow) / emaSlow) * 100;
    reasons.push(`EMA fast/slow spread ${emaSpreadPct.toFixed(2)}%; slow EMA ${slowRising ? "rising" : "not rising"}.`);
  }
  if (pullback) reasons.push("Pullback context is present.");

  const volatility = input.volatility ?? regime.volatility;
  reasons.push(`Volatility state ${volatility}.`);
  if (volatility === "extreme") {
    score -= 15;
    reasons.push("Extreme volatility reduced decision score by 15 point(s).");
  } else if (volatility === "elevated") {
    score -= 5;
    reasons.push("Elevated volatility reduced decision score by 5 point(s).");
  }

  const intel = input.marketIntelligence;
  if (intel) {
    const age = finiteNumber(intel.momentumAgeMinutes);
    const maxAge = finiteNumber(intel.maxAgeMinutes);
    if (intel.summary) reasons.push(`Market intelligence: ${intel.summary}`);
    if (intel.momentum1h || intel.momentum4h) {
      reasons.push(`Momentum context 1h=${intel.momentum1h ?? "unknown"}, 4h=${intel.momentum4h ?? "unknown"}.`);
    }
    if (age !== null) {
      reasons.push(`Market intelligence age ${Math.round(age)}m${maxAge !== null ? ` (max ${Math.round(maxAge)}m)` : ""}.`);
    }
    if (intel.stale === true) reasons.push("Market intelligence is stale; hard gates may block separately.");
    const volumeRatio = finiteNumber(intel.volumeRatio);
    if (volumeRatio !== null) reasons.push(`Volume ratio ${volumeRatio.toFixed(2)}x.`);
    if (intel.volumeTrend) reasons.push(`Volume trend ${intel.volumeTrend}.`);
  }

  const hardGates = (input.riskGates ?? []).filter(isHardRiskGate);
  for (const hardGate of hardGates) blockers.push(hardGate.message || hardGate.code);

  if (input.openPosition?.hasOpenPosition) blockers.push("Position already open for this symbol.");
  if (input.openPosition?.hasPendingSignal) blockers.push("Signal already pending for this symbol.");
  if (input.portfolio?.killSwitchEngaged) blockers.push("Kill switch is engaged.");
  if (input.portfolio?.botStatus === "halted" || input.portfolio?.botStatus === "paused") {
    blockers.push(`Bot status is ${input.portfolio.botStatus}.`);
  }

  const finalScore = clampScore(score);
  const uniqueBlockers = unique(blockers);
  const riskBlocked = uniqueBlockers.length > 0;
  const state: TradeDecisionState = riskBlocked ? "RISK_BLOCKED" : deriveMappedState(finalScore);
  const nextLikelyTrigger = deriveNextLikelyTrigger(state, finalScore, uniqueBlockers, regime);

  return {
    score: finalScore,
    state,
    reasons: unique(reasons),
    blockers: uniqueBlockers,
    riskBlocked,
    nextLikelyTrigger,
  };
}
