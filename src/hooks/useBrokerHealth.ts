import { useEffect, useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export type BrokerStatus = "not_connected" | "healthy" | "auth_failed" | "unknown";

export interface BrokerHealth {
  status: BrokerStatus;
  keyName: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
}

const EMPTY: BrokerHealth = {
  status: "not_connected",
  keyName: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  updatedAt: null,
};

export function useBrokerHealth() {
  const { user } = useAuth();
  const [health, setHealth] = useState<BrokerHealth>(EMPTY);
  const [loading, setLoading] = useState(true);
  const channelSuffixRef = useRef(crypto.randomUUID());

  const refetch = useCallback(async () => {
    if (!user) {
      setHealth(EMPTY);
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from("broker_health")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();
    if (data) {
      setHealth({
        status: (data.status as BrokerStatus) ?? "not_connected",
        keyName: data.key_name,
        lastSuccessAt: data.last_success_at,
        lastFailureAt: data.last_failure_at,
        lastError: data.last_error,
        updatedAt: data.updated_at,
      });
    } else {
      setHealth(EMPTY);
    }
    setLoading(false);
  }, [user]);

  useEffect(() => {
    refetch();
    if (!user) return;
    const channel = supabase
      .channel(`broker-health-${user.id}-${channelSuffixRef.current}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "broker_health", filter: `user_id=eq.${user.id}` },
        () => refetch(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, refetch]);

  return { health, loading, refetch };
}
