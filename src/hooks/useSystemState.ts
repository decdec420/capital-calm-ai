import { useEffect, useState } from "react";
import { useTableChanges } from "@/hooks/useRealtimeSubscriptions";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type {
  SystemState,
  SystemMode,
  BotStatus,
  ConnectionState,
  AutonomyLevel,
  EngineSnapshot,
} from "@/lib/domain-types";

function parseSnapshot(raw: any): EngineSnapshot | null {
  if (!raw || typeof raw !== "object" || !raw.ranAt) return null;
  return {
    ranAt: String(raw.ranAt),
    gateReasons: Array.isArray(raw.gateReasons) ? raw.gateReasons : [],
    perSymbol: Array.isArray(raw.perSymbol) ? raw.perSymbol : [],
    chosenSymbol: raw.chosenSymbol ?? null,
  };
}

function mapRow(r: any): SystemState {
  const profile = r.active_profile;
  return {
    id: r.id,
    mode: r.mode as SystemMode,
    bot: r.bot as BotStatus,
    brokerConnection: r.broker_connection as ConnectionState,
    dataFeed: r.data_feed as ConnectionState,
    killSwitchEngaged: r.kill_switch_engaged,
    liveTradingEnabled: r.live_trading_enabled,
    uptimeHours: Number(r.uptime_hours),
    lastHeartbeat: r.last_heartbeat,
    latencyMs: r.latency_ms,
    autonomyLevel: (r.autonomy_level ?? "manual") as AutonomyLevel,
    lastEngineSnapshot: parseSnapshot(r.last_engine_snapshot),
    liveMoneyAcknowledgedAt: r.live_money_acknowledged_at ?? null,
    paperAccountBalance: Number(r.paper_account_balance ?? 1000),
    paramsWiredLive: !!r.params_wired_live,
    tradingPausedUntil: r.trading_paused_until ?? null,
    pauseReason: r.pause_reason ?? null,
    activeProfile:
      profile === "active" || profile === "aggressive" || profile === "sentinel"
        ? profile
        : "sentinel",
    lastJessicaDecision: r.last_jessica_decision ?? null,
    doctrineOverlayToday:
      r.doctrine_overlay_today && typeof r.doctrine_overlay_today === "object"
        ? r.doctrine_overlay_today
        : null,
  };
}

export function useSystemState() {
  const { user } = useAuth();
  const [data, setData] = useState<SystemState | null>(null);
  const [loading, setLoading] = useState(true);
  /** ISO timestamp of the most recent successful data refresh. Updated on
   *  every initial fetch and every Realtime push for system_state. Lets the
   *  Overview page show a "last updated X seconds ago" indicator. */
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);

  const refetch = async () => {
    if (!user) return;
    const { data: row } = await supabase.from("system_state").select("*").eq("user_id", user.id).maybeSingle();
    if (row) {
      setData(mapRow(row));
      setLastUpdatedAt(new Date().toISOString());
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useTableChanges("system_state", refetch);

  const update = async (patch: Partial<SystemState>) => {
    if (!user) return;
    const dbPatch: any = {};
    if (patch.mode) dbPatch.mode = patch.mode;
    if (patch.bot) dbPatch.bot = patch.bot;
    if (patch.killSwitchEngaged !== undefined) dbPatch.kill_switch_engaged = patch.killSwitchEngaged;
    if (patch.liveTradingEnabled !== undefined) dbPatch.live_trading_enabled = patch.liveTradingEnabled;
    if (patch.autonomyLevel) dbPatch.autonomy_level = patch.autonomyLevel;
    if (patch.tradingPausedUntil !== undefined) dbPatch.trading_paused_until = patch.tradingPausedUntil;
    if (patch.pauseReason !== undefined) dbPatch.pause_reason = patch.pauseReason;
    if (patch.paperAccountBalance !== undefined) dbPatch.paper_account_balance = patch.paperAccountBalance;
    if (patch.activeProfile) dbPatch.active_profile = patch.activeProfile;
    const { error } = await supabase.from("system_state").update(dbPatch).eq("user_id", user.id);
    if (error) throw error;

    // MED-6: Append to system_events audit trail for risk-posture changes.
    // Best-effort — never block the UI action on audit write failure.
    const auditKeys: (keyof typeof dbPatch)[] = [
      "kill_switch_engaged", "live_trading_enabled", "autonomy_level",
      "bot", "mode", "trading_paused_until",
    ];
    const auditPayload: Record<string, unknown> = {};
    for (const k of auditKeys) {
      if ((k as string) in dbPatch) auditPayload[k as string] = (dbPatch as Record<string, unknown>)[k as string];
    }
    if (Object.keys(auditPayload).length > 0) {
      (supabase as any)
        .from("system_events")
        .insert({ user_id: user.id, event_type: "state_changed", actor: "operator", payload: auditPayload })
        .then(({ error: evtErr }: { error: { message: string } | null }) => {
          if (evtErr) console.warn("[useSystemState] system_events insert failed:", evtErr.message);
        });
    }

    await refetch();
  };

  /** Sign the one-time live-money acknowledgment. Server stamps the row;
   * we just refresh so the UI sees the new timestamp. The RPC name is
   * cast because the generated `Database` type only refreshes after the
   * migration is deployed; once Lovable regenerates types we can drop
   * the cast. */
  const acknowledgeLiveMoney = async () => {
    if (!user) return;
    const { error } = await (supabase.rpc as any)("acknowledge_live_money");
    if (error) throw error;
    await refetch();
  };

  return { data, loading, update, refetch, acknowledgeLiveMoney, lastUpdatedAt };
}
