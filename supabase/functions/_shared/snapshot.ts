// ============================================================
// Engine snapshot persistence
// ------------------------------------------------------------
// Authoritative. The browser reads `system_state.last_engine_snapshot`
// and renders it in MultiSymbolStrip / Overview / RiskCenter /
// Copilot. Writing it from one place keeps the shape honest.
// ============================================================

import type { GateReason, GateSeverity } from "./reasons.ts";

export interface PerSymbolSnapshot {
  symbol: string;
  lastPrice: number;
  regime: string;
  confidence: number;
  setupScore: number;
  volatility: string;
  todScore: number;
  pullback: boolean;
  lockGate: GateReason | null;
  chosen: boolean;
}

export interface NormalizedBlocker {
  code: string;
  severity: "critical" | "high" | "medium" | "low";
  message: string;
  source: "gate" | "portfolio" | "position" | "account" | "doctrine" | "market" | "system";
  owner?: string;
  nextSafeAction?: string;
  meta?: Record<string, unknown>;
}

export interface UnifiedTradeDecisionSnapshot {
  status: "CLEAR" | "WARN" | "BLOCKED" | "RISK_BLOCKED" | "NO_TRADE";
  canTradeNow: boolean;
  riskBlocked: boolean;
  blockers: NormalizedBlocker[];
  scoreAdjustment: number;
  requiredScoreBump: number;
  reasonCodes: string[];
}

export interface EngineSnapshotPayload {
  ranAt: string;
  gateReasons: GateReason[];
  perSymbol: PerSymbolSnapshot[];
  chosenSymbol: string | null;
  /** Normalized concise reasons for UI "why not trading" panels. */
  blockers: NormalizedBlocker[];
  /** Unified trade-decision contract emitted by signal-engine. */
  tradeDecision: UnifiedTradeDecisionSnapshot;
}


function gateSeverityToBlockerSeverity(severity: GateSeverity): NormalizedBlocker["severity"] {
  switch (severity) {
    case "halt": return "critical";
    case "block": return "high";
    case "skip": return "medium";
    case "warn": return "low";
    case "info": return "low";
  }
}

function normalizeGateBlockers(gateReasons: GateReason[]): NormalizedBlocker[] {
  return gateReasons
    .filter((g) => g.severity === "halt" || g.severity === "block" || g.severity === "warn")
    .map((g) => ({
      code: g.code,
      severity: gateSeverityToBlockerSeverity(g.severity),
      message: g.message,
      source: "gate" as const,
      meta: g.meta,
    }));
}

function defaultTradeDecision(blockers: NormalizedBlocker[]): UnifiedTradeDecisionSnapshot {
  const riskBlocked = blockers.some((b) => b.severity === "critical" || b.severity === "high");
  const hasWarnings = blockers.length > 0;
  return {
    status: riskBlocked ? "RISK_BLOCKED" : hasWarnings ? "WARN" : "CLEAR",
    canTradeNow: !riskBlocked,
    riskBlocked,
    blockers,
    scoreAdjustment: 0,
    requiredScoreBump: 0,
    reasonCodes: blockers.map((b) => b.code),
  };
}

export async function persistSnapshot(
  // deno-lint-ignore no-explicit-any
  admin: any,
  userId: string,
  snap: {
    gateReasons: GateReason[];
    perSymbol: PerSymbolSnapshot[];
    chosenSymbol: string | null;
    blockers?: NormalizedBlocker[];
    tradeDecision?: UnifiedTradeDecisionSnapshot;
  },
): Promise<void> {
  const blockers = snap.blockers ?? normalizeGateBlockers(snap.gateReasons);
  const tradeDecision = snap.tradeDecision ?? defaultTradeDecision(blockers);
  const payload: EngineSnapshotPayload = {
    ranAt: new Date().toISOString(),
    gateReasons: snap.gateReasons,
    perSymbol: snap.perSymbol,
    chosenSymbol: snap.chosenSymbol,
    blockers,
    tradeDecision,
  };
  await admin
    .from("system_state")
    .update({ last_engine_snapshot: payload, last_heartbeat: payload.ranAt })
    .eq("user_id", userId);
}

// ─── Staleness contract ──────────────────────────────────────────
//
// signal-engine runs on a 5-minute pg_cron (`signal-engine-tick`).
// Consumers of the snapshot — signal-decide, future broker-execute
// paths — must refuse to act on a snapshot older than 3× the cron
// interval. If the engine cron stalls, gates can't be trusted.

/** Mirror of the pg_cron schedule for signal-engine. Centralised so
 * consumers can compute staleness without round-tripping cron.job. */
export const SIGNAL_ENGINE_CRON_INTERVAL_SECONDS = 300; // 5 min

/** Max acceptable age of `last_engine_snapshot` for any consumer
 * deciding to fire an order. */
export const STALE_SNAPSHOT_MAX_AGE_SECONDS =
  SIGNAL_ENGINE_CRON_INTERVAL_SECONDS * 3;

/** Returns snapshot age in seconds. Missing or malformed snapshots
 * return Infinity so callers naturally treat them as stale. */
export function snapshotAgeSeconds(
  snapshot: { ranAt?: string | null } | null | undefined,
  nowMs: number = Date.now(),
): number {
  if (!snapshot || !snapshot.ranAt) return Infinity;
  const t = Date.parse(snapshot.ranAt);
  if (Number.isNaN(t)) return Infinity;
  return Math.max(0, (nowMs - t) / 1000);
}

/** True when the snapshot is older than STALE_SNAPSHOT_MAX_AGE_SECONDS
 * (or missing/malformed entirely). */
export function isSnapshotStale(
  snapshot: { ranAt?: string | null } | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  return snapshotAgeSeconds(snapshot, nowMs) > STALE_SNAPSHOT_MAX_AGE_SECONDS;
}
