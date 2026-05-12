import { useEffect, useState } from "react";
import { useTableChanges } from "@/hooks/useRealtimeSubscriptions";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { Tables } from "@/integrations/supabase/types";

type BrokerFill = Tables<"broker_fills">;

export function useBrokerFills(tradeId?: string, limit = 200) {
  const { user } = useAuth();
  const [fills, setFills] = useState<BrokerFill[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = async () => {
    if (!user) return;
    let q = supabase
      .from("broker_fills")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (tradeId) q = q.eq("trade_id", tradeId);
    const { data } = await q;
    setFills(data ?? []);
    setLoading(false);
  };

  useEffect(() => {
    if (!user) { setLoading(false); return; }
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, tradeId]);

  useTableChanges("broker_fills", refetch);

  const totalFees = fills.reduce((sum, f) => sum + (f.fees_usd ?? 0), 0);

  return { fills, totalFees, loading, refetch };
}
