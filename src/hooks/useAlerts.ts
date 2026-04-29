import { useEffect, useState } from "react";
import { useTableChanges } from "@/hooks/useRealtimeSubscriptions";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { Alert, AlertSeverity } from "@/lib/domain-types";

function mapRow(r: any): Alert {
  return {
    id: r.id,
    severity: r.severity as AlertSeverity,
    title: r.title,
    message: r.message ?? "",
    timestamp: r.created_at,
  };
}

export function useAlerts() {
  const { user } = useAuth();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = async () => {
    if (!user) return;
    const { data } = await supabase
      .from("alerts")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(20);
    setAlerts((data ?? []).map(mapRow));
    setLoading(false);
  };

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    refetch();
    useTableChanges("alerts", refetch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const create = async (input: { severity: AlertSeverity; title: string; message: string }) => {
    if (!user) throw new Error("Not signed in");
    const { error } = await supabase.from("alerts").insert({ user_id: user.id, ...input });
    if (error) throw error;
  };

  const dismiss = async (id: string) => {
    if (!user) return;
    const { error } = await supabase.from("alerts").delete().eq("id", id).eq("user_id", user.id);
    if (error) throw error;
  };

  return { alerts, loading, create, dismiss, refetch };
}
