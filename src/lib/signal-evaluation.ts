// ============================================================
// Signal Evaluation Universe + Candidate Selection
// ------------------------------------------------------------
// Pure helpers for safely expanding signal-engine coverage beyond
// winner-takes-all single-symbol behavior. No DB calls, no broker calls,
// no trade creation, no signal approval, no doctrine mutation.
// ============================================================

import {
  computePortfolioRisk,
  type PortfolioRiskSummary,
} from "@/lib/portfolio-risk";
import type { AccountState, Trade } from "@/lib/domain-types";

export const SIGNAL_EVALUATION_SYMBOLS = ["BTC-USD", "ETH-USD", "SOL-USD"] as const;
export type SignalEvaluationSymbol = (typeof SIGNAL_EVALUATION_SYMBOLS)[number];

export const MAX_SYMBOLS_EVALUATED_PER_TICK = 2;
export const MAX_SYMBOLS_EVALUATED_PER_TICK_AGGRESSIVE = 3;

export type MultiSymbolMode = "disabled" | "canary" | "enabled";
export const MULTI_SYMBOL_MODE: MultiSymbolMode = "enabled";

export interface SignalEvaluationCandidateInput {
  symbol: string;
  setupScore: number;
  confidence: number;
  pullback?: boolean | null;
  momentumAgeMin?: number | null;
  brainTrustScore?: number | null;
  lockCode?: string | null;
  regime?: string | null;
  lastPrice?: number | null;
  proposedSide?: "long" | "short" | null;
  proposedNotionalUsd?: number | null;
}

export interface SignalEvaluationPortfolioContext {
  openTrades: Trade[];
  account: AccountState | null;
  mode: "paper" | "live" | "unknown";
  exposureUpdatedAt?: string | null;
  marketDataUpdatedAt?: string | null;
  accountStateUpdatedAt?: string | null;
  nowMs?: number;
}

export interface RankedSignalEvaluationCandidate extends SignalEvaluationCandidateInput {
  symbol: SignalEvaluationSymbol;
  rankScore: number;
  rankReasons: string[];
  portfolioRisk: PortfolioRiskSummary;
  skipped: boolean;
  skipCodes: string[];
}

export interface SignalEvaluationSelectionResult {
  mode: MultiSymbolMode;
  maxEvaluated: number;
  candidates: RankedSignalEvaluationCandidate[];
  evaluated: RankedSignalEvaluationCandidate[];
  skipped: RankedSignalEvaluationCandidate[];
}

export function isSignalEvaluationSymbol(symbol: string): symbol is SignalEvaluationSymbol {
  return (SIGNAL_EVALUATION_SYMBOLS as readonly string[]).includes(symbol);
}

export function maxSymbolsEvaluatedForMode(mode: MultiSymbolMode): number {
  if (mode === "disabled") return 1;
  if (mode === "canary") return MAX_SYMBOLS_EVALUATED_PER_TICK_AGGRESSIVE;
  return MAX_SYMBOLS_EVALUATED_PER_TICK;
}

function freshnessScore(ageMin: number | null | undefined): number {
  if (ageMin === null || ageMin === undefined || !Number.isFinite(ageMin)) return 0;
  if (ageMin <= 5) return 1;
  if (ageMin <= 15) return 0.85;
  if (ageMin <= 60) return 0.55;
  if (ageMin <= 120) return 0.2;
  return 0;
}

function momentumScore(value: string | number | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(-1, Math.min(1, value));
  if (typeof value !== "string") return 0;
  const v = value.toLowerCase();
  if (v.includes("strong") && (v.includes("up") || v.includes("long") || v.includes("bull"))) return 1;
  if (v.includes("up") || v.includes("long") || v.includes("bull")) return 0.7;
  if (v.includes("neutral") || v.includes("flat")) return 0.2;
  if (v.includes("down") || v.includes("short") || v.includes("bear")) return 0.35;
  return 0;
}

export function rankSignalEvaluationCandidate(candidate: SignalEvaluationCandidateInput): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const setup = Math.max(0, Math.min(1, Number(candidate.setupScore ?? 0)));
  const confidence = Math.max(0, Math.min(1, Number(candidate.confidence ?? 0)));
  const freshness = freshnessScore(candidate.momentumAgeMin);
  const momentum = momentumScore(candidate.brainTrustScore);
  const pullback = candidate.pullback ? 0.08 : 0;
  const lockPenalty = candidate.lockCode ? -1 : 0;

  reasons.push(`setup:${setup.toFixed(2)}`);
  reasons.push(`confidence:${confidence.toFixed(2)}`);
  reasons.push(`freshness:${freshness.toFixed(2)}`);
  reasons.push(`momentum:${momentum.toFixed(2)}`);
  if (candidate.pullback) reasons.push("pullback:+0.08");
  if (candidate.lockCode) reasons.push(`lock:${candidate.lockCode}`);

  return {
    score: setup * 0.5 + confidence * 0.2 + freshness * 0.2 + momentum * 0.1 + pullback + lockPenalty,
    reasons,
  };
}

export function selectSignalEvaluationCandidates(
  candidates: SignalEvaluationCandidateInput[],
  portfolio: SignalEvaluationPortfolioContext,
  mode: MultiSymbolMode = MULTI_SYMBOL_MODE,
): SignalEvaluationSelectionResult {
  const maxEvaluated = maxSymbolsEvaluatedForMode(mode);
  const ranked = candidates
    .filter((candidate) => isSignalEvaluationSymbol(candidate.symbol))
    .map((candidate) => {
      const rank = rankSignalEvaluationCandidate(candidate);
      const proposedTrade = candidate.proposedSide && candidate.proposedNotionalUsd && candidate.proposedNotionalUsd > 0
        ? {
            symbol: candidate.symbol,
            side: candidate.proposedSide,
            notionalUsd: candidate.proposedNotionalUsd,
          }
        : candidate.proposedSide && candidate.lastPrice && candidate.lastPrice > 0
          ? {
              symbol: candidate.symbol,
              side: candidate.proposedSide,
              notionalUsd: 0,
            }
          : null;
      const portfolioRisk = computePortfolioRisk({ ...portfolio, proposedTrade });
      const skipCodes = [
        ...(candidate.lockCode ? [candidate.lockCode] : []),
        ...portfolioRisk.blockCodes,
      ];
      return {
        ...candidate,
        symbol: candidate.symbol as SignalEvaluationSymbol,
        rankScore: rank.score,
        rankReasons: rank.reasons,
        portfolioRisk,
        skipped: skipCodes.length > 0,
        skipCodes,
      };
    })
    .sort((a, b) => {
      if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
      return SIGNAL_EVALUATION_SYMBOLS.indexOf(a.symbol) - SIGNAL_EVALUATION_SYMBOLS.indexOf(b.symbol);
    });

  const evaluated: RankedSignalEvaluationCandidate[] = [];
  const skipped: RankedSignalEvaluationCandidate[] = [];
  for (const candidate of ranked) {
    if (candidate.skipped) {
      skipped.push(candidate);
      continue;
    }
    if (evaluated.length < maxEvaluated) {
      evaluated.push(candidate);
    } else {
      skipped.push({ ...candidate, skipped: true, skipCodes: ["MULTI_SYMBOL_EVALUATION_CAP"] });
    }
  }

  return { mode, maxEvaluated, candidates: ranked, evaluated, skipped };
}
