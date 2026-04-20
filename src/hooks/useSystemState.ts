import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { SystemState, SystemMode, BotStatus, ConnectionState, AutonomyLevel } from "@/lib/domain-types";

function mapRow(r: any): SystemState {
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
      .channel(`system_state:${user.id}`)
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
    const { error } = await supabase.from("system_state").update(dbPatch).eq("user_id", user.id);
    if (error) throw error;
    await refetch();
  };

  return { data, loading, update, refetch };
}
