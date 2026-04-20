import { useEffect, useState } from "react";
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
  };
}

export function useAccountState() {
  const { user } = useAuth();
  const [data, setData] = useState<AccountState | null>(null);
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
    else setData(row ? mapRow(row) : null);
    setLoading(false);
  };

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    refetch();
    const channel = supabase
      .channel(`account_state:${user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "account_state", filter: `user_id=eq.${user.id}` },
        () => refetch(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const update = async (patch: Partial<AccountState>) => {
    if (!user || !data) return;
    const dbPatch: any = {};
    if (patch.equity !== undefined) dbPatch.equity = patch.equity;
    if (patch.cash !== undefined) dbPatch.cash = patch.cash;
    if (patch.startOfDayEquity !== undefined) dbPatch.start_of_day_equity = patch.startOfDayEquity;
    if (patch.balanceFloor !== undefined) dbPatch.balance_floor = patch.balanceFloor;
    if (patch.baseCurrency !== undefined) dbPatch.base_currency = patch.baseCurrency;
    const { error: err } = await supabase.from("account_state").update(dbPatch).eq("user_id", user.id);
    if (err) throw err;
    await refetch();
  };

  return { data, loading, error, refetch, update };
}
