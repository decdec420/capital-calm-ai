// ============================================================
// Engine snapshot persistence
// ------------------------------------------------------------
// Authoritative. The browser reads `system_state.last_engine_snapshot`
// and renders it in MultiSymbolStrip / Overview / RiskCenter /
// Copilot. Writing it from one place keeps the shape honest.
// ============================================================

import type { GateReason } from "./reasons.ts";

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

export interface EngineSnapshotPayload {
  ranAt: string;
  gateReasons: GateReason[];
  perSymbol: PerSymbolSnapshot[];
  chosenSymbol: string | null;
}

export async function persistSnapshot(
  // deno-lint-ignore no-explicit-any
  admin: any,
  userId: string,
  snap: {
    gateReasons: GateReason[];
    perSymbol: PerSymbolSnapshot[];
    chosenSymbol: string | null;
  },
): Promise<void> {
  const payload: EngineSnapshotPayload = {
    ranAt: new Date().toISOString(),
    gateReasons: snap.gateReasons,
    perSymbol: snap.perSymbol,
    chosenSymbol: snap.chosenSymbol,
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
