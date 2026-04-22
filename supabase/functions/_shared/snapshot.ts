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
