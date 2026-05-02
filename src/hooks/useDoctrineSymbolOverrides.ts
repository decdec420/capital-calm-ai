// ============================================================
// useDoctrineSymbolOverrides — CRUD over doctrine_symbol_overrides.
// Per-symbol caps that can ONLY tighten the global doctrine.
// ============================================================
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export interface SymbolOverride {
  id: string;
  symbol: string;
  enabled: boolean;
  max_order_pct: number | null;
  risk_per_trade_pct: number | null;
  daily_loss_pct: number | null;
  max_trades_per_day: number | null;
  updated_at: string;
}

export type SymbolOverrideInput = Omit<SymbolOverride, "id" | "updated_at">;

export function useDoctrineSymbolOverrides() {
  const { user } = useAuth();
  const [overrides, setOverrides] = useState<SymbolOverride[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!user) {
      setOverrides([]);
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from("doctrine_symbol_overrides")
      .select("*")
      .eq("user_id", user.id)
      .order("symbol", { ascending: true });
    if (!error && data) setOverrides(data as SymbolOverride[]);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const upsert = useCallback(
    async (input: SymbolOverrideInput & { id?: string }) => {
      if (!user) throw new Error("not authenticated");
      const payload = { ...input, user_id: user.id };
      const { error } = input.id
        ? await supabase.from("doctrine_symbol_overrides").update(payload).eq("id", input.id)
        : await supabase.from("doctrine_symbol_overrides").insert(payload);
      if (error) throw error;
      await refetch();
    },
    [user, refetch],
  );

  const remove = useCallback(
    async (id: string) => {
      const { error } = await supabase.from("doctrine_symbol_overrides").delete().eq("id", id);
      if (error) throw error;
      await refetch();
    },
    [refetch],
  );

  return { overrides, loading, refetch, upsert, remove };
}
