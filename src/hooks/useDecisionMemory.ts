import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { Tables } from "@/integrations/supabase/types";

type DecisionMemoryRow = Tables<"decision_memory">;

export function useDecisionMemory(limit = 200) {
  const { user } = useAuth();
  const [rows, setRows] = useState<DecisionMemoryRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = async () => {
    if (!user) return;
    const { data } = await supabase
      .from("decision_memory")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(limit);
    setRows(data ?? []);
    setLoading(false);
  };

  useEffect(() => {
    if (!user) { setLoading(false); return; }
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const blocked = rows.filter((r) => r.event_type === "blocked");
  const executed = rows.filter((r) => r.event_type === "executed");
  const unused = rows.filter((r) => !r.used_for_learning);

  return { rows, blocked, executed, unused, loading, refetch };
}
