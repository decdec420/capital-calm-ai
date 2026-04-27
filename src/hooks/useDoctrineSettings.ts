import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useAccountState } from "@/hooks/useAccountState";
import {
  resolveDoctrine,
  type DoctrineSettingsRow,
  type ResolvedDoctrine,
  DOCTRINE_FALLBACK,
} from "@/lib/doctrine-resolver";

function mapRow(r: any): DoctrineSettingsRow {
  return {
    starting_equity_usd: r.starting_equity_usd === null ? null : Number(r.starting_equity_usd),
    max_order_pct: Number(r.max_order_pct ?? DOCTRINE_FALLBACK.max_order_pct),
    max_order_abs_cap: Number(r.max_order_abs_cap ?? DOCTRINE_FALLBACK.max_order_abs_cap),
    max_order_abs_floor: Number(r.max_order_abs_floor ?? DOCTRINE_FALLBACK.max_order_abs_floor),
    daily_loss_pct: Number(r.daily_loss_pct ?? DOCTRINE_FALLBACK.daily_loss_pct),
    max_trades_per_day: Number(r.max_trades_per_day ?? DOCTRINE_FALLBACK.max_trades_per_day),
    floor_pct: Number(r.floor_pct ?? DOCTRINE_FALLBACK.floor_pct),
    floor_abs_min: Number(r.floor_abs_min ?? DOCTRINE_FALLBACK.floor_abs_min),
    consecutive_loss_limit: Number(r.consecutive_loss_limit ?? DOCTRINE_FALLBACK.consecutive_loss_limit),
    loss_cooldown_minutes: Number(r.loss_cooldown_minutes ?? DOCTRINE_FALLBACK.loss_cooldown_minutes),
    risk_per_trade_pct: Number(r.risk_per_trade_pct ?? DOCTRINE_FALLBACK.risk_per_trade_pct),
    scan_interval_seconds: Number(r.scan_interval_seconds ?? DOCTRINE_FALLBACK.scan_interval_seconds),
    max_correlated_positions: Number(r.max_correlated_positions ?? DOCTRINE_FALLBACK.max_correlated_positions),
  };
}

export interface UseDoctrineSettingsResult {
  settings: DoctrineSettingsRow | null;
  resolved: ResolvedDoctrine;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  needsOnboarding: boolean;
}

export function useDoctrineSettings(): UseDoctrineSettingsResult {
  const { user } = useAuth();
  const { data: account } = useAccountState();
  const [settings, setSettings] = useState<DoctrineSettingsRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!user) return;
    const { data, error: err } = await supabase
      .from("doctrine_settings")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();
    if (err) setError(err.message);
    else setSettings(data ? mapRow(data) : null);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Realtime so DoctrineEditSheet sees changes immediately + cron activations
  useEffect(() => {
    if (!user) return;
    const ch = supabase
      .channel("doctrine_settings_self")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "doctrine_settings", filter: `user_id=eq.${user.id}` },
        () => void refetch(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [user, refetch]);

  const equity = account?.equity ?? 0;
  const resolved = useMemo(() => resolveDoctrine(settings, equity), [settings, equity]);
  const needsOnboarding = !!user && !loading && (!settings || settings.starting_equity_usd === null);

  return { settings, resolved, loading, error, refetch, needsOnboarding };
}
