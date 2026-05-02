// ============================================================
// useDoctrineWindows — CRUD over doctrine_windows.
// Time-of-day rules (UTC) that force a tightening mode.
// ============================================================
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

export type DoctrineMode = "calm" | "choppy" | "storm" | "lockout";

export interface DoctrineWindow {
  id: string;
  label: string;
  days: number[];
  start_utc: string;
  end_utc: string;
  mode: DoctrineMode;
  enabled: boolean;
  updated_at: string;
}

export type DoctrineWindowInput = Omit<DoctrineWindow, "id" | "updated_at">;

export function useDoctrineWindows() {
  const { user } = useAuth();
  const [windows, setWindows] = useState<DoctrineWindow[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!user) {
      setWindows([]);
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from("doctrine_windows")
      .select("*")
      .eq("user_id", user.id)
      .order("start_utc", { ascending: true });
    if (!error && data) setWindows(data as DoctrineWindow[]);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const upsert = useCallback(
    async (input: DoctrineWindowInput & { id?: string }) => {
      if (!user) throw new Error("not authenticated");
      const payload = { ...input, user_id: user.id };
      const { error } = input.id
        ? await supabase.from("doctrine_windows").update(payload).eq("id", input.id)
        : await supabase.from("doctrine_windows").insert(payload);
      if (error) throw error;
      await refetch();
    },
    [user, refetch],
  );

  const remove = useCallback(
    async (id: string) => {
      const { error } = await supabase.from("doctrine_windows").delete().eq("id", id);
      if (error) throw error;
      await refetch();
    },
    [refetch],
  );

  return { windows, loading, refetch, upsert, remove };
}
