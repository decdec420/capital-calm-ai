import { useEffect, useState } from "react";
import { useTableChanges } from "@/hooks/useRealtimeSubscriptions";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { Tables } from "@/integrations/supabase/types";

type WarRoomMessage = Tables<"war_room_messages">;

export function useWarRoomMessages(limit = 100) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<WarRoomMessage[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = async () => {
    if (!user) return;
    const { data } = await supabase
      .from("war_room_messages")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(limit);
    setMessages(data ?? []);
    setLoading(false);
  };

  useEffect(() => {
    if (!user) { setLoading(false); return; }
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useTableChanges("war_room_messages", refetch);

  const unread = messages.filter((m) => !m.read_by_bobby);

  const markRead = async (id: string) => {
    if (!user) return;
    await supabase
      .from("war_room_messages")
      .update({ read_by_bobby: true })
      .eq("id", id)
      .eq("user_id", user.id);
    await refetch();
  };

  return { messages, unread, loading, refetch, markRead };
}
