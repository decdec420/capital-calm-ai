// ============================================================
// Live Readiness — Pure Audit Model
// ------------------------------------------------------------
// Answers: "Is the system ready for live trading, and exactly
// what blocks it?" This panel makes live readiness visible,
// not easier to turn on.
//
// Design rules:
//   - Pure function: no side effects, no DB calls.
//   - Reads from TradingDecisionSnapshot + BrokerHealth.
//   - Transfer permission is always a critical fail.
//   - Paper mode does NOT require Trade permission.
//   - Missing data is "unknown" — never optimistically pass.
//   - Secrets are never included in the output.
// ============================================================

import type { TradingDecisionSnapshot } from "./trading-decision-snapshot";
import type { BrokerHealth } from "@/hooks/useBrokerHealth";

// ─── Status types ─────────────────────────────────────────────────────────────

/** Overall live-readiness verdict. */
export type LiveReadinessStatus =
  | "not_ready"          // Critical issues prevent even paper mode
  | "paper_only_ready"   // Paper mode is viable; live is blocked
  | "live_ready_blocked" // All paper checks pass; live has blockers
  | "live_ready_possible"; // All checks pass (live mode still must be explicitly armed)

export type CheckStatus = "pass" | "warn" | "fail" | "unknown";
export type CheckSeverity = "info" | "warning" | "critical";
export type CheckScope = "paper" | "live" | "both";

// ─── Check shape ──────────────────────────────────────────────────────────────

export interface ReadinessCheck {
  id: string;
  label: string;
  status: CheckStatus;
  severity: CheckSeverity;
  explanation: string;
  /** Which mode this check is required for. */
  requiredFor: CheckScope;
  safeAction: string;
}

// ─── Broker permission summary (no secrets) ──────────────────────────────────

/** Safe summary of Coinbase API key permissions. Never includes key values. */
export interface BrokerPermissionSummary {
  /** View/read permission — needed for account health checks. */
  viewPermission: "pass" | "fail" | "unknown";
  /** Trade permission — NOT required for paper mode; only for live. */
  tradePermission: "present" | "absent" | "unknown";
  /** Transfer permission — must always be absent. Present = critical fail. */
  transferPermission: "absent" | "detected" | "unknown";
  /** Overall broker auth is healthy. */
  authHealthy: boolean;
  /** Key name displayed for identification — never the key value or secret. */
  keyName: string | null;
  /** ISO timestamp of last successful broker check. */
  lastSuccessAt: string | null;
}

// ─── Report shape ─────────────────────────────────────────────────────────────

export interface LiveReadinessReport {
  overallStatus: LiveReadinessStatus;
  /** Paper mode is viable (kill switch clear, bot runnable, strategy exists). */
  paperReady: boolean;
  /** Live mode has no blocking issues (conservative — requires explicit arming). */
  liveReady: boolean;
  checks: ReadinessCheck[];
  /** Checks that are "fail" — ordered critical-first. */
  blockers: ReadinessCheck[];
  /** Checks that are "warn". */
  warnings: ReadinessCheck[];
  brokerPermissionSummary: BrokerPermissionSummary;
  nextSafeAction: string;
  computedAt: string;
}

// ─── Input shape ─────────────────────────────────────────────────────────────

export interface LiveReadinessInput {
  snapshot: TradingDecisionSnapshot | null;
  brokerHealth: BrokerHealth;
  nowMs?: number;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function check(
  id: string,
  label: string,
  status: CheckStatus,
  severity: CheckSeverity,
  explanation: string,
  requiredFor: CheckScope,
  safeAction: string,
): ReadinessCheck {
  return { id, label, status, severity, explanation, requiredFor, safeAction };
}

/**
 * Derive transfer permission state from broker status and last_error.
 * When status = "healthy", the broker check succeeded → transfer was NOT detected
 * (CoinbaseBrokerHealth.ok = true always has canTransfer: false as a literal).
 * When status = "auth_failed" and error mentions TRANSFER_PERMISSION_DETECTED → detected.
 * Otherwise unknown.
 */
function detectTransferPermission(
  status: BrokerHealth["status"],
  lastError: string | null,
): "absent" | "detected" | "unknown" {
  if (status === "healthy") return "absent";
  if (lastError?.includes("TRANSFER_PERMISSION_DETECTED")) return "detected";
  return "unknown";
}

/** Infer broker permission summary from BrokerHealth. Never includes key value. */
function buildPermissionSummary(brokerHealth: BrokerHealth): BrokerPermissionSummary {
  const { status, lastError, keyName, lastSuccessAt } = brokerHealth;

  const authHealthy = status === "healthy";

  const viewPermission: BrokerPermissionSummary["viewPermission"] =
    status === "healthy" ? "pass"
    : status === "auth_failed" ? "fail"
    : "unknown";

  // Trade permission: we cannot determine from broker_health alone — mark unknown.
  // The system never requires Trade permission for paper mode.
  const tradePermission: BrokerPermissionSummary["tradePermission"] = "unknown";

  const transferPermission = detectTransferPermission(status, lastError);

  return {
    viewPermission,
    tradePermission,
    transferPermission,
    authHealthy,
    keyName: keyName ?? null,
    lastSuccessAt: lastSuccessAt ?? null,
  };
}

// ─── Main compute function ────────────────────────────────────────────────────

/**
 * Pure function: compute a live-readiness audit from existing state.
 * No DB calls. No side effects. Secrets are never included in output.
 */
export function computeLiveReadiness(input: LiveReadinessInput): LiveReadinessReport {
  const { snapshot, brokerHealth } = input;
  const nowMs = input.nowMs ?? Date.now();
  const computedAt = new Date(nowMs).toISOString();

  const permissionSummary = buildPermissionSummary(brokerHealth);
  const checks: ReadinessCheck[] = [];

  // ── 1. Live mode disabled (expected, this is safe) ────────────────────────
  const liveTradingEnabled = snapshot?.mode === "live";
  checks.push(
    check(
      "LIVE_MODE_DISABLED",
      "Live mode disabled",
      liveTradingEnabled ? "warn" : "pass",
      liveTradingEnabled ? "warning" : "info",
      liveTradingEnabled
        ? "Live mode is currently armed. Confirm this is intentional."
        : "Live mode is off. Paper mode is active. This is the safe default.",
      "both",
      liveTradingEnabled
        ? "Confirm live mode arming in Settings → Bot Controls is intentional."
        : "No action needed. Live mode can only be armed deliberately.",
    ),
  );

  // ── 2. Live money acknowledged ────────────────────────────────────────────
  // We need to infer this from snapshot.mode (live = might be acknowledged).
  // The full acknowledgement timestamp lives in SystemState.liveMoneyAcknowledgedAt
  // which is not forwarded to TradingDecisionSnapshot. We treat mode = "live"
  // as potential acknowledgement; we can only do a conservative unknown otherwise.
  const liveMoneyAckStatus: CheckStatus =
    snapshot === null ? "unknown"
    : liveTradingEnabled ? "warn"   // armed but we can't verify timestamp here
    : "pass";
  checks.push(
    check(
      "LIVE_MONEY_ACKNOWLEDGED",
      "Live money risk acknowledged",
      liveMoneyAckStatus,
      liveMoneyAckStatus === "warn" ? "warning" : "info",
      liveMoneyAckStatus === "unknown"
        ? "System state unavailable — cannot verify acknowledgement."
        : liveMoneyAckStatus === "warn"
          ? "Live mode is armed. Operator must have signed the live-money acknowledgement."
          : "Live mode is not armed. No acknowledgement required.",
      "live",
      "If arming live mode: explicitly confirm real-money risk in Settings before enabling.",
    ),
  );

  // ── 3. Kill switch ────────────────────────────────────────────────────────
  const killSwitchStatus: CheckStatus =
    snapshot === null ? "unknown"
    : snapshot.killSwitchEngaged ? "fail"
    : "pass";
  checks.push(
    check(
      "KILL_SWITCH_CLEAR",
      "Kill switch disarmed",
      killSwitchStatus,
      killSwitchStatus === "fail" ? "critical" : "info",
      killSwitchStatus === "unknown"
        ? "System state unavailable."
        : killSwitchStatus === "fail"
          ? "Kill switch is engaged — all trading halted."
          : "Kill switch is disarmed.",
      "both",
      "Disarm kill switch in Risk Center only when ready to resume.",
    ),
  );

  // ── 4. Broker auth health ─────────────────────────────────────────────────
  const brokerAuthStatus: CheckStatus =
    brokerHealth.status === "healthy" ? "pass"
    : brokerHealth.status === "auth_failed" ? "fail"
    : brokerHealth.status === "not_connected" ? "fail"
    : "unknown";
  checks.push(
    check(
      "BROKER_AUTH_HEALTHY",
      "Broker auth healthy",
      brokerAuthStatus,
      brokerAuthStatus === "fail" ? "critical" : brokerAuthStatus === "unknown" ? "warning" : "info",
      brokerAuthStatus === "pass"
        ? `Coinbase API key is authenticated.${permissionSummary.keyName ? ` Key: ${permissionSummary.keyName}` : ""}`
        : brokerAuthStatus === "fail"
          ? `Broker auth failed: ${brokerHealth.lastError ?? brokerHealth.status}.`
          : "Broker connection status is unknown.",
      "live",
      "Check Coinbase API credentials in Settings → Broker Connection.",
    ),
  );

  // ── 5. Transfer permission must be absent ─────────────────────────────────
  const transferStatus: CheckStatus =
    permissionSummary.transferPermission === "absent" ? "pass"
    : permissionSummary.transferPermission === "detected" ? "fail"
    : "unknown";
  checks.push(
    check(
      "TRANSFER_PERMISSION_ABSENT",
      "Transfer permission not granted",
      transferStatus,
      "critical", // always critical — Transfer permission is never acceptable
      transferStatus === "pass"
        ? "Transfer permission is not present on the API key. This is correct."
        : transferStatus === "fail"
          ? "Transfer permission is NOT allowed. Remove it before any live-readiness review. Your API key has transfer capability which creates withdrawal risk."
          : "Transfer permission status is unknown. Verify your API key scopes before going live.",
      "both",
      transferStatus === "fail"
        ? "Revoke the API key immediately. Create a new key with View (and optionally Trade) only — never Transfer."
        : "Verify your Coinbase API key has no Transfer scope. View-only is the minimum safe configuration.",
    ),
  );

  // ── 6. View permission (needed for read-only health checks) ───────────────
  const viewStatus: CheckStatus = permissionSummary.viewPermission;
  checks.push(
    check(
      "VIEW_PERMISSION_PRESENT",
      "View permission for account health checks",
      viewStatus,
      viewStatus === "fail" ? "warning" : "info",
      viewStatus === "pass"
        ? "API key has View permission — read-only account/health checks work."
        : viewStatus === "fail"
          ? "API key is missing View permission. Read-only health checks will fail."
          : "Cannot determine View permission — broker not connected.",
      "both",
      "Ensure your Coinbase API key includes View (read-only) scope.",
    ),
  );

  // ── 7. Trade permission — NOT required for paper, may be needed for live ──
  // This is "unknown" from broker_health alone — we surface this honestly.
  const tradePermStatus: CheckStatus =
    brokerHealth.status === "not_connected" ? "unknown"
    : brokerHealth.status === "healthy"
      ? liveTradingEnabled ? "unknown" : "pass" // paper: having it doesn't matter; live: unknown
      : "unknown";
  checks.push(
    check(
      "TRADE_PERMISSION_SAFE",
      "Trade permission — paper mode safe without it",
      tradePermStatus,
      "info",
      tradePermStatus === "pass"
        ? "Paper mode does not require Trade permission. Paper trades are simulated."
        : liveTradingEnabled
          ? "Trade permission status unknown. Live mode may require it."
          : "Paper mode does not require Trade permission. This is expected and safe.",
      "paper",
      "Paper mode never requires Trade permission. For live mode only: add Trade permission if intentionally arming live trading.",
    ),
  );

  // ── 8. Account state freshness ────────────────────────────────────────────
  const accountStateStatus: CheckStatus =
    snapshot === null ? "unknown"
    : snapshot.portfolioRisk === null ? "unknown"
    : snapshot.portfolioRisk.insufficientData ? "warn"
    : "pass";
  checks.push(
    check(
      "ACCOUNT_STATE_FRESH",
      "Account/equity state known",
      accountStateStatus,
      accountStateStatus === "warn" ? "warning" : accountStateStatus === "unknown" ? "warning" : "info",
      accountStateStatus === "pass"
        ? "Account equity state is available."
        : accountStateStatus === "warn"
          ? "Account state data is incomplete. Exposure calculations may be inaccurate."
          : "Account state is unavailable — equity unknown.",
      "live",
      "Ensure account state row exists and has been updated recently.",
    ),
  );

  // ── 9. Market data freshness ──────────────────────────────────────────────
  const marketDataStatus: CheckStatus =
    snapshot === null ? "unknown"
    : snapshot.marketDataConnected ? "pass"
    : "fail";
  checks.push(
    check(
      "MARKET_DATA_FRESH",
      "Market data feed connected",
      marketDataStatus,
      marketDataStatus === "fail" ? "critical" : "info",
      marketDataStatus === "pass"
        ? "Market data feed is connected."
        : marketDataStatus === "fail"
          ? "Market data feed is disconnected — no price data."
          : "Market data connection state unknown.",
      "both",
      "Check Coinbase API connectivity. Market data is required for signal generation.",
    ),
  );

  // ── 10. Brain Trust / signal freshness ────────────────────────────────────
  const brainTrustStatus: CheckStatus =
    snapshot === null ? "unknown"
    : snapshot.brainTrustFresh ? "pass"
    : "warn";
  checks.push(
    check(
      "BRAIN_TRUST_FRESH",
      "Brain Trust analysis current",
      brainTrustStatus,
      brainTrustStatus === "warn" ? "warning" : "info",
      brainTrustStatus === "pass"
        ? `Brain Trust last updated ${snapshot?.brainTrustLastAt ? new Date(snapshot.brainTrustLastAt).toLocaleTimeString() : "recently"}.`
        : brainTrustStatus === "warn"
          ? "Brain Trust analysis is stale. Market context may be outdated."
          : "Brain Trust freshness unknown.",
      "both",
      "Trigger a Brain Trust refresh from Market Intel page.",
    ),
  );

  // ── 11. Taylor (signal engine) freshness ──────────────────────────────────
  const taylorStatus: CheckStatus =
    snapshot === null ? "unknown"
    : snapshot.taylorFresh ? "pass"
    : "warn";
  checks.push(
    check(
      "TAYLOR_FRESH",
      "Signal engine (Taylor) recently ran",
      taylorStatus,
      taylorStatus === "warn" ? "warning" : "info",
      taylorStatus === "pass"
        ? `Signal engine last ran at ${snapshot?.taylorLastRanAt ? new Date(snapshot.taylorLastRanAt).toLocaleTimeString() : "recently"}.`
        : taylorStatus === "warn"
          ? "Signal engine cron may be stalled. Last run was too long ago."
          : "Signal engine run time unknown.",
      "both",
      "Check Hall/Ops Timeline for incidents. Signal engine runs every 5 minutes via cron.",
    ),
  );

  // ── 12. Portfolio risk known ───────────────────────────────────────────────
  const portfolioRiskKnownStatus: CheckStatus =
    snapshot === null ? "unknown"
    : snapshot.portfolioRisk === null ? "unknown"
    : snapshot.portfolioRisk.verdict === "block" ? "warn"
    : "pass";
  checks.push(
    check(
      "PORTFOLIO_RISK_KNOWN",
      "Portfolio risk computed",
      portfolioRiskKnownStatus,
      portfolioRiskKnownStatus === "unknown" ? "warning" : "info",
      portfolioRiskKnownStatus === "pass"
        ? `Portfolio risk: ${snapshot?.portfolioRisk?.verdict ?? "clear"}.`
        : portfolioRiskKnownStatus === "warn"
          ? `Portfolio risk verdict: ${snapshot?.portfolioRisk?.verdict ?? "unknown"}. Review before live arming.`
          : "Portfolio risk data is unavailable.",
      "live",
      "Portfolio risk is required before considering live mode. Check Risk Center → Portfolio Risk.",
    ),
  );

  // ── 13. No open critical incidents ────────────────────────────────────────
  const incidentStatus: CheckStatus =
    snapshot === null ? "unknown"
    : snapshot.openIncidentBlocking ? "fail"
    : "pass";
  checks.push(
    check(
      "NO_CRITICAL_INCIDENTS",
      "No open critical incidents",
      incidentStatus,
      incidentStatus === "fail" ? "critical" : "info",
      incidentStatus === "pass"
        ? "No unacknowledged critical incidents."
        : "There is an open critical incident. Do not proceed toward live trading.",
      "both",
      "Acknowledge and resolve the critical alert before considering live readiness.",
    ),
  );

  // ── 14. Doctrine and risk gates clear ────────────────────────────────────
  const doctrineStatus: CheckStatus =
    snapshot === null ? "unknown"
    : (!snapshot.doctrineOverlayClear || !snapshot.accountFloorClear || !snapshot.dailyLossCapClear) ? "fail"
    : "pass";
  checks.push(
    check(
      "DOCTRINE_GATES_CLEAR",
      "Doctrine and risk gates clear",
      doctrineStatus,
      doctrineStatus === "fail" ? "critical" : "info",
      doctrineStatus === "pass"
        ? "Doctrine overlay is clear. Balance floor and daily loss cap are clear."
        : doctrineStatus === "fail"
          ? `Risk gate active: ${!snapshot?.accountFloorClear ? "BALANCE_FLOOR" : !snapshot?.dailyLossCapClear ? "DAILY_LOSS_CAP" : "DOCTRINE_OVERLAY"}.`
          : "Doctrine/gate status unknown.",
      "both",
      "Review active gates in Risk Center. Resolve doctrine issues before live arming.",
    ),
  );

  // ── 15. Approved strategy exists ──────────────────────────────────────────
  const strategyStatus: CheckStatus =
    snapshot === null ? "unknown"
    : snapshot.activeStrategyExists ? "pass"
    : "fail";
  checks.push(
    check(
      "APPROVED_STRATEGY_EXISTS",
      "Approved trading strategy present",
      strategyStatus,
      strategyStatus === "fail" ? "critical" : "info",
      strategyStatus === "pass"
        ? `Approved strategies: ${snapshot?.activeStrategyNames.join(", ") ?? "present"}.`
        : "No approved strategy — signal engine has nothing to run.",
      "both",
      "Approve a strategy candidate in Strategy Lab.",
    ),
  );

  // ── Derive structured outputs ─────────────────────────────────────────────

  const blockers = checks.filter((c) => c.status === "fail");
  const warnings = checks.filter((c) => c.status === "warn");

  // Paper mode: only checks scoped to "paper" or "both" can block it.
  const paperBlockers = blockers.filter(
    (c) => (c.requiredFor === "paper" || c.requiredFor === "both") && c.severity === "critical",
  );
  const paperReady = paperBlockers.length === 0 && snapshot !== null;

  // Live mode: any "fail" on live or both checks blocks live readiness.
  const liveBlockers = blockers.filter(
    (c) => c.requiredFor === "live" || c.requiredFor === "both",
  );
  const liveReady = liveBlockers.length === 0 && warnings.filter(c => c.requiredFor === "live" || c.requiredFor === "both").length === 0 && snapshot !== null;

  // Transfer permission is always a live AND paper concern.
  const transferDetected = permissionSummary.transferPermission === "detected";

  const overallStatus: LiveReadinessStatus =
    transferDetected || (paperBlockers.length > 0)
      ? "not_ready"
      : !paperReady
        ? "not_ready"
        : liveBlockers.length > 0
          ? "live_ready_blocked"
          : liveReady
            ? "live_ready_possible"
            : "paper_only_ready";

  // Next safe action — highest priority blocker first.
  const criticalBlockers = blockers.filter((c) => c.severity === "critical");
  const nextSafeAction =
    criticalBlockers.length > 0
      ? criticalBlockers[0].safeAction
      : blockers.length > 0
        ? blockers[0].safeAction
        : warnings.length > 0
          ? warnings[0].safeAction
          : paperReady
            ? "Paper mode is viable. System is monitoring. Live trading requires explicit arming."
            : "Review blockers above before proceeding.";

  return {
    overallStatus,
    paperReady,
    liveReady,
    checks,
    blockers,
    warnings,
    brokerPermissionSummary: permissionSummary,
    nextSafeAction,
    computedAt,
  };
}
