import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export interface PendingDoctrineChange {
  id: string;
  field: string;
  fromValue: number | null;
  toValue: number;
  requestedAt: string;
  effectiveAt: string;
  status: "pending" | "activated" | "cancelled" | "superseded";
  reason: string | null;
}

function mapRow(r: any): PendingDoctrineChange {
  return {
    id: r.id,
    field: r.field,
    fromValue: r.from_value === null ? null : Number(r.from_value),
    toValue: Number(r.to_value),
    requestedAt: r.requested_at,
    effectiveAt: r.effective_at,
    status: r.status,
    reason: r.reason,
  };
}

export function usePendingDoctrineChanges() {
  const { user } = useAuth();
  const [pending, setPending] = useState<PendingDoctrineChange[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!user) return;
    const { data, error } = await supabase
      .from("pending_doctrine_changes")
      .select("*")
      .eq("user_id", user.id)
      .eq("status", "pending")
      .order("effective_at", { ascending: true });
    if (!error && data) setPending(data.map(mapRow));
    setLoading(false);
  }, [user]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    if (!user) return;
    const ch = supabase
      .channel("pending_doctrine_self")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "pending_doctrine_changes", filter: `user_id=eq.${user.id}` },
        () => void refetch(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [user, refetch]);

  const cancel = useCallback(
    async (id: string) => {
      const { error } = await supabase
        .from("pending_doctrine_changes")
        .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
      await refetch();
    },
    [refetch],
  );

  return { pending, loading, cancel, refetch };
}
