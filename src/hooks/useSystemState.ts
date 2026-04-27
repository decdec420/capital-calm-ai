import { useEffect, useState } from "react";
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
    activeProfile:
      profile === "active" || profile === "aggressive" || profile === "sentinel"
        ? profile
        : "sentinel",
    lastJessicaDecision: r.last_jessica_decision ?? null,
  };
}

export function useSystemState() {
  const { user } = useAuth();
  const [data, setData] = useState<SystemState | null>(null);
  const [loading, setLoading] = useState(true);

  const refetch = async () => {
    if (!user) return;
    const { data: row } = await supabase.from("system_state").select("*").eq("user_id", user.id).maybeSingle();
    if (row) setData(mapRow(row));
    setLoading(false);
  };

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    refetch();
    const channel = supabase
      .channel(`system_state:${user.id}:${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "system_state", filter: `user_id=eq.${user.id}` },
        () => refetch(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const update = async (patch: Partial<SystemState>) => {
    if (!user) return;
    const dbPatch: any = {};
    if (patch.mode) dbPatch.mode = patch.mode;
    if (patch.bot) dbPatch.bot = patch.bot;
    if (patch.killSwitchEngaged !== undefined) dbPatch.kill_switch_engaged = patch.killSwitchEngaged;
    if (patch.liveTradingEnabled !== undefined) dbPatch.live_trading_enabled = patch.liveTradingEnabled;
    if (patch.autonomyLevel) dbPatch.autonomy_level = patch.autonomyLevel;
    if (patch.tradingPausedUntil !== undefined) dbPatch.trading_paused_until = patch.tradingPausedUntil;
    if (patch.paperAccountBalance !== undefined) dbPatch.paper_account_balance = patch.paperAccountBalance;
    if (patch.activeProfile) dbPatch.active_profile = patch.activeProfile;
    const { error } = await supabase.from("system_state").update(dbPatch).eq("user_id", user.id);
    if (error) throw error;
    await refetch();
  };

  /** Sign the one-time live-money acknowledgment. Server stamps the row;
   * we just refresh so the UI sees the new timestamp. The RPC name is
   * cast because the generated `Database` type only refreshes after the
   * migration is deployed; once Lovable regenerates types we can drop
   * the cast. */
  const acknowledgeLiveMoney = async () => {
    if (!user) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.rpc as any)("acknowledge_live_money");
    if (error) throw error;
    await refetch();
  };

  return { data, loading, update, refetch, acknowledgeLiveMoney };
}
