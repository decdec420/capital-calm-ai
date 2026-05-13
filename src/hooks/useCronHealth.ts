import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { mapCronHealthResponse, type CronHealthResponse, type CronHealthRow, type CronHealthSummary } from "@/lib/cron-health";

export interface UseCronHealthResult {
  loading: boolean;
  error: string | null;
  rows: CronHealthRow[];
  summary: CronHealthSummary;
  lastCheckedAt: string | null;
  refetch: () => void;
}

const EMPTY_SUMMARY: CronHealthSummary = { critical: 0, warning: 0, ok: 0, unknown: 0 };

export function useCronHealth(): UseCronHealthResult {
  const { user } = useAuth();
  const [health, setHealth] = useState<CronHealthResponse>({ rows: [], summary: EMPTY_SUMMARY, lastCheckedAt: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!user) {
      setHealth({ rows: [], summary: EMPTY_SUMMARY, lastCheckedAt: null });
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const { data, error: invokeError } = await supabase.functions.invoke("cron-health", {
        body: {},
      });

      if (invokeError) throw invokeError;

      setHealth(mapCronHealthResponse(data));
      setError(null);
    } catch (e) {
      setHealth({ rows: [], summary: EMPTY_SUMMARY, lastCheckedAt: null });
      setError(e instanceof Error ? e.message : "Failed to load cron health");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return {
    ...health,
    loading,
    error,
    refetch,
  };
}
