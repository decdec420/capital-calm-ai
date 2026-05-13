// ============================================================
// Quiet Mode — pure idle-throttle policy
// ------------------------------------------------------------
// Decides whether high-cost AI work may be deferred on genuinely idle
// paper-mode days. Safety checks, incidents, alerts, and heartbeats must
// continue regardless of this decision.
// ============================================================

export type QuietMode = "normal" | "quiet";

export interface QuietModeDecision {
  mode: QuietMode;
  reasonCodes: string[];
  recommendedCadenceSeconds: {
    bobby: number;
    signalEngine: number;
    marketIntelligence: number;
  };
  shouldSkipHeavyAi: boolean;
  shouldPreserveSafetyChecks: boolean;
  nextRecommendedCheckAt: string;
}

export interface QuietModeInputs {
  now?: Date | string | number;
  openPositionsCount: number;
  pendingSignalsCount: number;
  openCriticalIncidentsCount: number;
  criticalAlertsCount?: number;
  portfolioBlockersCount?: number;
  strategyLearningActiveCount?: number;
  bot?: string | null;
  activeProfile?: string | null;
  liveTradingEnabled: boolean;
  brokerExposureKnown?: boolean;
  marketDataStaleBlocksTrading?: boolean;
  killSwitchEngaged?: boolean;
  killSwitchChangedAt?: Date | string | number | null;
  recentSignalActivityAt?: Date | string | number | null;
  recentMarketMomentumAt?: Date | string | number | null;
  recentMarketMomentumMagnitude?: number | null;
  recentNewsAt?: Date | string | number | null;
}

export const QUIET_MODE_CADENCE_SECONDS = {
  normal: { bobby: 60, signalEngine: 60, marketIntelligence: 60 },
  quiet: { bobby: 300, signalEngine: 300, marketIntelligence: 900 },
} as const;

const RECENT_SIGNAL_MS = 30 * 60_000;
const RECENT_MOMENTUM_MS = 45 * 60_000;
const RECENT_NEWS_MS = 90 * 60_000;
const KILL_SWITCH_CHANGE_MS = 15 * 60_000;
const MOMENTUM_PRESSURE_ABS = 0.75;

function asTime(value: Date | string | number | null | undefined): number | null {
  if (value == null) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function isRecent(nowMs: number, value: Date | string | number | null | undefined, windowMs: number): boolean {
  const time = asTime(value);
  return time !== null && nowMs - time >= 0 && nowMs - time <= windowMs;
}

export function evaluateQuietMode(input: QuietModeInputs): QuietModeDecision {
  const now = input.now ? new Date(input.now) : new Date();
  const nowMs = now.getTime();
  const blockers: string[] = [];
  const idleReasons: string[] = [];

  if (input.liveTradingEnabled) blockers.push("live_mode_active");
  if (input.openPositionsCount > 0) blockers.push("open_positions");
  if (input.pendingSignalsCount > 0) blockers.push("pending_signals");
  if (input.openCriticalIncidentsCount > 0) blockers.push("critical_incidents_open");
  if ((input.criticalAlertsCount ?? 0) > 0) blockers.push("critical_alerts_open");
  if ((input.portfolioBlockersCount ?? 0) > 0) blockers.push("portfolio_blockers_active");
  if ((input.strategyLearningActiveCount ?? 0) > 0) blockers.push("strategy_learning_active");
  if (input.bot === "running" && input.brokerExposureKnown === false && input.liveTradingEnabled) blockers.push("broker_exposure_unknown_live");
  if (input.marketDataStaleBlocksTrading) blockers.push("market_data_stale_blocks_trading");
  if (input.killSwitchEngaged) blockers.push("kill_switch_engaged");
  if (isRecent(nowMs, input.killSwitchChangedAt, KILL_SWITCH_CHANGE_MS)) blockers.push("kill_switch_recently_changed");
  if (isRecent(nowMs, input.recentSignalActivityAt, RECENT_SIGNAL_MS)) blockers.push("recent_signal_activity");
  if (isRecent(nowMs, input.recentNewsAt, RECENT_NEWS_MS)) blockers.push("recent_news_pressure");

  const hasMomentumPressure =
    isRecent(nowMs, input.recentMarketMomentumAt, RECENT_MOMENTUM_MS) &&
    Math.abs(input.recentMarketMomentumMagnitude ?? 0) >= MOMENTUM_PRESSURE_ABS;
  if (hasMomentumPressure) blockers.push("recent_momentum_pressure");

  if (input.openPositionsCount === 0) idleReasons.push("no_open_positions");
  if (input.pendingSignalsCount === 0) idleReasons.push("no_pending_signals");
  if (input.openCriticalIncidentsCount === 0) idleReasons.push("no_critical_incidents");
  if (!input.liveTradingEnabled) idleReasons.push("paper_or_non_live_mode");
  if (!isRecent(nowMs, input.recentSignalActivityAt, RECENT_SIGNAL_MS)) idleReasons.push("no_recent_signal_activity");
  if (!hasMomentumPressure) idleReasons.push("no_fresh_momentum_pressure");
  if (!isRecent(nowMs, input.recentNewsAt, RECENT_NEWS_MS)) idleReasons.push("no_recent_news_pressure");

  const mode: QuietMode = blockers.length === 0 ? "quiet" : "normal";
  const cadence = mode === "quiet" ? QUIET_MODE_CADENCE_SECONDS.quiet : QUIET_MODE_CADENCE_SECONDS.normal;

  return {
    mode,
    reasonCodes: mode === "quiet" ? idleReasons : blockers,
    recommendedCadenceSeconds: cadence,
    shouldSkipHeavyAi: mode === "quiet",
    shouldPreserveSafetyChecks: true,
    nextRecommendedCheckAt: new Date(nowMs + cadence.signalEngine * 1000).toISOString(),
  };
}

export function shouldEmitQuietModeEvent(
  lastEventAt: Date | string | number | null | undefined,
  now: Date | string | number = new Date(),
  minIntervalMs = 15 * 60_000,
): boolean {
  const last = asTime(lastEventAt);
  const current = asTime(now) ?? Date.now();
  if (last === null) return true;
  return current - last >= minIntervalMs;
}
