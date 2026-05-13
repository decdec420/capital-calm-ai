import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useTableChanges } from "@/hooks/useRealtimeSubscriptions";
import {
  emptyQuietModeStatus,
  mapQuietModeStatusRow,
  type QuietModeStatus,
  type QuietModeStatusRpcRow,
} from "@/lib/quiet-mode-status";

export interface UseQuietModeStatusResult extends QuietModeStatus {
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useQuietModeStatus(): UseQuietModeStatusResult {
  const { user } = useAuth();
  const [status, setStatus] = useState<QuietModeStatus>(() => emptyQuietModeStatus());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!user) {
      setStatus(emptyQuietModeStatus());
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    try {
      const { data, error: rpcError } = await supabase.rpc("get_current_quiet_mode_status", {
        p_user_id: user.id,
      });

      if (rpcError) throw rpcError;

      const row = Array.isArray(data) ? data[0] : data;
      setStatus(mapQuietModeStatusRow(row as QuietModeStatusRpcRow | null | undefined));
      setError(null);
    } catch (e) {
      setStatus(emptyQuietModeStatus());
      setError(e instanceof Error ? e.message : "Failed to load Quiet Mode status");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useTableChanges("system_events", refetch);

  return {
    ...status,
    loading,
    error,
    refetch,
  };
}
