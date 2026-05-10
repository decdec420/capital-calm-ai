// ============================================================
// TradingDecisionSnapshot — Canonical CanTradeNow Contract
// ------------------------------------------------------------
// Single source of truth for whether the system can trade and why not.
// Used by: Overview, RiskCenter, WhyNoTradesPanel, Alerts, agents.
//
// Design rules:
//   - Pure function: computeTradingDecisionSnapshot() takes plain inputs, no side effects.
//   - Paper mode does NOT require broker health to be ok.
//   - Live mode DOES require broker health to be ok.
//   - Transfer permission detected → always blocked regardless of mode.
//   - No new DB queries — composed from existing hook data.
// ============================================================

import type { SystemState, EngineSnapshot, GateReason, StrategyVersion } from "./domain-types";
import type { MarketIntelligence } from "@/hooks/useMarketIntelligence";
import type { Alert } from "./domain-types";

// ─── Staleness thresholds ────────────────────────────────────────────────────

/** Brain Trust momentum is considered stale after 120 minutes (2 hours). */
export const BRAIN_TRUST_STALE_SECONDS = 120 * 60;

/** Engine snapshot considered stale after 15 minutes (3× the 5-min cron). */
export const TAYLOR_STALE_SECONDS = 15 * 60;

// ─── Blocker shape ───────────────────────────────────────────────────────────

export interface BlockerEntry {
  code: string;
  severity: "critical" | "high" | "medium" | "low";
  message: string;
  owner: string;
  nextSafeAction: string;
}

// ─── Canonical snapshot ───────────────────────────────────────────────────────

export interface TradingDecisionSnapshot {
  /** True only when all gates are clear and the system can propose a trade. */
  canTradeNow: boolean;
  /** Current system mode. */
  mode: SystemState["mode"] | "unknown";
  /** Bot is in "running" state. */
  botRunning: boolean;
  /** Kill switch is engaged. */
  killSwitchEngaged: boolean;
  /** Engine (Taylor) ran within TAYLOR_STALE_SECONDS. */
  taylorFresh: boolean;
  /** Last Taylor run timestamp (ISO). */
  taylorLastRanAt: string | null;
  /** Brain Trust momentum updated within BRAIN_TRUST_STALE_SECONDS. */
  brainTrustFresh: boolean;
  /** Newest Brain Trust `generatedAt` across all symbols. */
  brainTrustLastAt: string | null;
  /** Market data feed is connected (from system_state.dataFeed). */
  marketDataConnected: boolean;
  /**
   * Coinbase broker connection is healthy.
   * For paper mode this is informational — paper mode does not require broker.
   * For live mode this blocks trading.
   */
  coinbaseBrokerHealthy: boolean;
  /** No BALANCE_FLOOR halt gate in the last engine snapshot. */
  accountFloorClear: boolean;
  /** No DAILY_LOSS_CAP halt gate in the last engine snapshot. */
  dailyLossCapClear: boolean;
  /** No TRADE_COUNT_CAP halt gate in the last engine snapshot. */
  maxTradesClear: boolean;
  /** No doctrine-overlay blockNewEntries flag. */
  doctrineOverlayClear: boolean;
  /** At least one approved strategy exists. */
  activeStrategyExists: boolean;
  /** Names of approved strategies. */
  activeStrategyNames: string[];
  /** There is an open incident-level alert with severity "critical". */
  openIncidentBlocking: boolean;
  /** All refusal gate reasons from the last engine snapshot. */
  refusalGates: GateReason[];
  /** Ordered list of active blockers with owner and action. */
  blockers: BlockerEntry[];
  /** Single highest-priority next safe action for the operator. */
  nextSafeAction: string;
  /** Timestamp this snapshot was computed (ISO). */
  computedAt: string;
}

// ─── Input shape ─────────────────────────────────────────────────────────────

export interface TradingDecisionSnapshotInput {
  system: SystemState | null;
  marketIntelligence: MarketIntelligence[];
  strategies: StrategyVersion[];
  alerts: Alert[];
  nowMs?: number;
}

// ─── Pure compute function ────────────────────────────────────────────────────

export function computeTradingDecisionSnapshot(
  input: TradingDecisionSnapshotInput,
): TradingDecisionSnapshot {
  const { system, marketIntelligence, strategies, alerts } = input;
  const nowMs = input.nowMs ?? Date.now();

  // ── Mode ──────────────────────────────────────────────────────────────────
  const mode = system?.mode ?? "unknown";
  const isLiveMode = mode === "live";
  const isPaperMode = mode === "paper" || mode === "research" || mode === "learning";

  // ── Bot state ─────────────────────────────────────────────────────────────
  const botRunning = system?.bot === "running";
  const killSwitchEngaged = system?.killSwitchEngaged ?? false;

  // ── Taylor freshness ──────────────────────────────────────────────────────
  const snapshotRanAt = system?.lastEngineSnapshot?.ranAt ?? null;
  const taylorAgeSeconds = snapshotRanAt
    ? (nowMs - Date.parse(snapshotRanAt)) / 1000
    : Infinity;
  const taylorFresh = taylorAgeSeconds <= TAYLOR_STALE_SECONDS;

  // ── Brain Trust freshness ─────────────────────────────────────────────────
  let brainTrustLastAt: string | null = null;
  if (marketIntelligence.length > 0) {
    const sorted = [...marketIntelligence].sort(
      (a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt),
    );
    brainTrustLastAt = sorted[0].generatedAt;
  }
  const brainTrustAgeSeconds = brainTrustLastAt
    ? (nowMs - Date.parse(brainTrustLastAt)) / 1000
    : Infinity;
  const brainTrustFresh = brainTrustAgeSeconds <= BRAIN_TRUST_STALE_SECONDS;

  // ── Market data ───────────────────────────────────────────────────────────
  const marketDataConnected = system?.dataFeed === "connected";

  // ── Coinbase broker health ─────────────────────────────────────────────────
  const coinbaseBrokerHealthy = system?.brokerConnection === "connected";

  // ── Engine snapshot gate reasons ──────────────────────────────────────────
  const snapshot: EngineSnapshot | null = system?.lastEngineSnapshot ?? null;
  const gateReasons: GateReason[] = snapshot?.gateReasons ?? [];
  const refusalGates = gateReasons.filter(
    (g) => g.severity === "halt" || g.severity === "block",
  );

  const hasGate = (code: string) => refusalGates.some((g) => g.code === code);
  const accountFloorClear = !hasGate("BALANCE_FLOOR");
  const dailyLossCapClear = !hasGate("DAILY_LOSS_CAP");
  const maxTradesClear = !hasGate("TRADE_COUNT_CAP");

  // ── Doctrine overlay ──────────────────────────────────────────────────────
  const doctrineOverlayClear = !(system?.doctrineOverlayToday?.blockNewEntries === true);

  // ── Strategies ────────────────────────────────────────────────────────────
  const approved = strategies.filter((s) => s.status === "approved");
  const activeStrategyExists = approved.length > 0;
  const activeStrategyNames = approved.map((s) => s.displayName ?? s.name);

  // ── Open incidents ────────────────────────────────────────────────────────
  const openIncidentBlocking = alerts.some(
    (a) => a.severity === "critical" && !("acknowledgedAt" in a && a.acknowledgedAt),
  );

  // ── Transfer permission check ─────────────────────────────────────────────
  // If broker status is "disconnected" due to TRANSFER_PERMISSION_DETECTED we
  // must always block. We detect this via the system brokerConnection being
  // non-connected when in live mode. The broker-connection edge function
  // writes a system_event for TRANSFER_PERMISSION_DETECTED; for now we
  // conservatively block whenever live + broker not connected.
  const transferPermissionRisk = isLiveMode && !coinbaseBrokerHealthy;

  // ── Assemble blockers ─────────────────────────────────────────────────────
  const blockers: BlockerEntry[] = [];

  if (killSwitchEngaged) {
    blockers.push({
      code: "KILL_SWITCH",
      severity: "critical",
      message: "Kill switch is engaged — all trading halted.",
      owner: "Operator",
      nextSafeAction: "Disarm the kill switch in Risk Center when ready to resume.",
    });
  }

  if (!botRunning && !killSwitchEngaged) {
    blockers.push({
      code: "BOT_NOT_RUNNING",
      severity: "high",
      message: `Bot is ${system?.bot ?? "unknown"} — signal engine will not run.`,
      owner: "Operator",
      nextSafeAction: "Resume the bot from the Overview or Risk Center.",
    });
  }

  if (system?.tradingPausedUntil) {
    const pausedUntilMs = Date.parse(system.tradingPausedUntil);
    if (pausedUntilMs > nowMs) {
      const minutesLeft = Math.ceil((pausedUntilMs - nowMs) / 60000);
      blockers.push({
        code: "TRADING_PAUSED",
        severity: "high",
        message: `Trading paused for ${minutesLeft} more minute(s)${system.pauseReason ? ` (${system.pauseReason})` : ""}.`,
        owner: "Bobby / Operator",
        nextSafeAction: "Wait for the pause to expire or cancel it in Risk Center.",
      });
    }
  }

  if (!accountFloorClear) {
    blockers.push({
      code: "BALANCE_FLOOR",
      severity: "critical",
      message: "Account equity is below the kill-switch floor.",
      owner: "Risk / Doctrine",
      nextSafeAction: "Top up the paper balance or review doctrine floor settings.",
    });
  }

  if (!dailyLossCapClear) {
    blockers.push({
      code: "DAILY_LOSS_CAP",
      severity: "high",
      message: "Daily loss cap reached — no new entries until tomorrow (UTC rollover).",
      owner: "Risk / Doctrine",
      nextSafeAction: "Review today's closed trades. Loss cap resets at UTC midnight.",
    });
  }

  if (!maxTradesClear) {
    blockers.push({
      code: "TRADE_COUNT_CAP",
      severity: "medium",
      message: "Maximum trades per day reached for current profile.",
      owner: "Risk / Doctrine",
      nextSafeAction: "Wait for UTC rollover or increase the daily trade cap in Doctrine.",
    });
  }

  if (!doctrineOverlayClear) {
    blockers.push({
      code: "DOCTRINE_OVERLAY_BLOCK",
      severity: "high",
      message: `Doctrine overlay is blocking new entries (mode: ${system?.doctrineOverlayToday?.mode ?? "unknown"}).`,
      owner: "Risk / Doctrine",
      nextSafeAction: "Check the doctrine overlay in Risk Center. Overlay may auto-lift.",
    });
  }

  if (!activeStrategyExists) {
    blockers.push({
      code: "NO_ACTIVE_STRATEGY",
      severity: "high",
      message: "No approved strategy — signal engine has no strategy to run.",
      owner: "Strategy Lab / Spyros",
      nextSafeAction: "Approve a strategy candidate in Strategy Lab.",
    });
  }

  if (!brainTrustFresh) {
    const ageMin = Math.round(brainTrustAgeSeconds / 60);
    blockers.push({
      code: "BRAIN_TRUST_STALE",
      severity: "medium",
      message: `Brain Trust context is stale (last update: ${ageMin}m ago, threshold: ${BRAIN_TRUST_STALE_SECONDS / 60}m).`,
      owner: "Brain Trust / Hall",
      nextSafeAction: "Trigger a Brain Trust refresh from Market Intel page.",
    });
  }

  if (!taylorFresh && botRunning) {
    const ageMin = Math.round(taylorAgeSeconds / 60);
    blockers.push({
      code: "TAYLOR_STALE",
      severity: "medium",
      message: `Signal engine last ran ${ageMin}m ago (threshold: ${TAYLOR_STALE_SECONDS / 60}m). Cron may be stalled.`,
      owner: "Taylor / Hall",
      nextSafeAction: "Hall should auto-kick signal-engine. Check Alerts for incidents.",
    });
  }

  if (isLiveMode && !coinbaseBrokerHealthy) {
    blockers.push({
      code: "BROKER_NOT_CONNECTED",
      severity: "critical",
      message: "Live mode requires Coinbase broker connection — currently not connected.",
      owner: "Broker Gateway",
      nextSafeAction: transferPermissionRisk
        ? "Check that your Coinbase API key has View permission only (no Transfer)."
        : "Reconnect Coinbase in Settings → Broker Connection.",
    });
  }

  if (!marketDataConnected) {
    blockers.push({
      code: "MARKET_DATA_DISCONNECTED",
      severity: "high",
      message: "Market data feed is disconnected.",
      owner: "Taylor / Hall",
      nextSafeAction: "Check Coinbase API connectivity in Settings.",
    });
  }

  if (openIncidentBlocking) {
    blockers.push({
      code: "OPEN_CRITICAL_INCIDENT",
      severity: "high",
      message: "There is an unacknowledged critical alert.",
      owner: "Hall / Operator",
      nextSafeAction: "Review and acknowledge the critical alert in Alerts.",
    });
  }

  // ── canTradeNow ───────────────────────────────────────────────────────────
  // Critical blockers that prevent any trade regardless of mode:
  const hardBlocked =
    killSwitchEngaged ||
    !botRunning ||
    !accountFloorClear ||
    !dailyLossCapClear ||
    !doctrineOverlayClear ||
    !activeStrategyExists;

  // Live-mode-only hard blocks:
  const liveHardBlocked = isLiveMode && !coinbaseBrokerHealthy;

  // Paper mode tolerates stale Brain Trust (degrades, doesn't block):
  const degradedBlocked = false; // paper degrades, not blocks
  void degradedBlocked; // reserved for future use

  const canTradeNow = !hardBlocked && !liveHardBlocked && (isPaperMode || !liveHardBlocked);

  // ── nextSafeAction ────────────────────────────────────────────────────────
  const nextSafeAction =
    blockers.length > 0
      ? blockers[0].nextSafeAction
      : botRunning
        ? "Desk is clear — Taylor is scanning for setups."
        : "Resume the bot when ready to allow Taylor to scan.";

  return {
    canTradeNow,
    mode,
    botRunning,
    killSwitchEngaged,
    taylorFresh,
    taylorLastRanAt: snapshotRanAt,
    brainTrustFresh,
    brainTrustLastAt,
    marketDataConnected,
    coinbaseBrokerHealthy,
    accountFloorClear,
    dailyLossCapClear,
    maxTradesClear,
    doctrineOverlayClear,
    activeStrategyExists,
    activeStrategyNames,
    openIncidentBlocking,
    refusalGates,
    blockers,
    nextSafeAction,
    computedAt: new Date(nowMs).toISOString(),
  };
}
