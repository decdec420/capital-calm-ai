import { useEffect, useState } from "react";
import { useTableChanges } from "@/hooks/useRealtimeSubscriptions";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { Tables } from "@/integrations/supabase/types";

type BobbyDirective = Tables<"bobby_directives">;

export function useBobbyDirectives() {
  const { user } = useAuth();
  const [directives, setDirectives] = useState<BobbyDirective[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = async () => {
    if (!user) return;
    const { data } = await supabase
      .from("bobby_directives")
      .select("*")
      .eq("user_id", user.id)
      .order("issued_at", { ascending: false });
    setDirectives(data ?? []);
    setLoading(false);
  };

  useEffect(() => {
    if (!user) { setLoading(false); return; }
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useTableChanges("bobby_directives", refetch);

  const pending = directives.filter((d) => d.status === "pending");
  const active = directives.filter((d) => d.status === "active");
  const completed = directives.filter((d) => d.status === "completed");

  return { directives, pending, active, completed, loading, refetch };
}
