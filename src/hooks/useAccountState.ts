import { useEffect, useState } from "react";
import { useTableChanges } from "@/hooks/useRealtimeSubscriptions";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { AccountState } from "@/lib/domain-types";

function mapRow(r: any): AccountState {
  return {
    id: r.id,
    equity: Number(r.equity),
    cash: Number(r.cash),
    startOfDayEquity: Number(r.start_of_day_equity),
    balanceFloor: Number(r.balance_floor),
    baseCurrency: r.base_currency,
    dailyAutoExecuteCapUsd: Number(r.daily_auto_execute_cap_usd ?? 2),
  };
}

export function useAccountState() {
  const { user } = useAuth();
  const [data, setData] = useState<AccountState | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = async () => {
    if (!user) return;
    const { data: row, error: err } = await supabase
      .from("account_state")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();
    if (err) setError(err.message);
    else {
      setData(row ? mapRow(row) : null);
      if (row) setLastUpdatedAt(Date.now());
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    refetch();
    useTableChanges("account_state", refetch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  /**
   * Update the settings fields on account_state.
   *
   * As of the Phase 0 truth-pass migration, `cash`, `equity`, and
   * `start_of_day_equity` are server-only — attempts to patch them
   * from a JWT'd client are silently reverted by the trigger. Those
   * values only move when `mark-to-market` or `trade-close` fire.
   *
   * Client-writable here: `balance_floor`, `base_currency`,
   * `daily_auto_execute_cap_usd`. The cap can be tightened from
   * the UI; the engine reads it server-side as a hard ceiling.
   */
  const update = async (
    patch: Pick<
      Partial<AccountState>,
      "balanceFloor" | "baseCurrency" | "dailyAutoExecuteCapUsd"
    >,
  ) => {
    if (!user || !data) return;
    const dbPatch: Record<string, unknown> = {};
    if (patch.balanceFloor !== undefined) dbPatch.balance_floor = patch.balanceFloor;
    if (patch.baseCurrency !== undefined) dbPatch.base_currency = patch.baseCurrency;
    if (patch.dailyAutoExecuteCapUsd !== undefined) {
      dbPatch.daily_auto_execute_cap_usd = patch.dailyAutoExecuteCapUsd;
    }
    if (Object.keys(dbPatch).length === 0) return;
    const { error: err } = await supabase
      .from("account_state")
      .update(dbPatch as never)
      .eq("user_id", user.id);
    if (err) throw err;
    await refetch();
  };

  return { data, lastUpdatedAt, loading, error, refetch, update };
}
