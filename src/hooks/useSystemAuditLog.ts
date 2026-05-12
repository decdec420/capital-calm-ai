import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { Tables } from "@/integrations/supabase/types";

type AuditEntry = Tables<"system_audit_log">;

export function useSystemAuditLog(limit = 200) {
  const { user } = useAuth();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = async () => {
    if (!user) return;
    const { data } = await supabase
      .from("system_audit_log")
      .select("*")
      .eq("user_id", user.id)
      .order("seq", { ascending: false })
      .limit(limit);
    setEntries(data ?? []);
    setLoading(false);
  };

  useEffect(() => {
    if (!user) { setLoading(false); return; }
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  return { entries, loading, refetch };
}
