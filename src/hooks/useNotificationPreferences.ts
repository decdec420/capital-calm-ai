import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { Tables, TablesUpdate } from "@/integrations/supabase/types";

type NotificationPrefs = Tables<"notification_preferences">;

export function useNotificationPreferences() {
  const { user } = useAuth();
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [loading, setLoading] = useState(true);

  const refetch = async () => {
    if (!user) return;
    const { data } = await supabase
      .from("notification_preferences")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();
    setPrefs(data ?? null);
    setLoading(false);
  };

  useEffect(() => {
    if (!user) { setLoading(false); return; }
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const update = async (patch: TablesUpdate<"notification_preferences">) => {
    if (!user) return;
    if (prefs) {
      const { error } = await supabase
        .from("notification_preferences")
        .update(patch)
        .eq("user_id", user.id);
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from("notification_preferences")
        .insert({ user_id: user.id, ...patch });
      if (error) throw error;
    }
    await refetch();
  };

  return { prefs, loading, refetch, update };
}
