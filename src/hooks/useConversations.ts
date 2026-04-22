import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export interface ChatConversation {
  id: string;
  title: string;
  lastMessageAt: string;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

export function useConversations() {
  const { user } = useAuth();
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);

  // Load conversations list
  const refresh = useCallback(async () => {
    if (!user) {
      setConversations([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data, error } = await supabase
      .from("chat_conversations")
      .select("id, title, last_message_at, created_at")
      .order("last_message_at", { ascending: false });
    if (!error && data) {
      setConversations(
        data.map((c) => ({
          id: c.id,
          title: c.title,
          lastMessageAt: c.last_message_at,
          createdAt: c.created_at,
        })),
      );
    }
    setLoading(false);
  }, [user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Load messages for the active conversation
  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoadingMessages(true);
      const { data, error } = await supabase
        .from("chat_messages")
        .select("id, role, content, created_at")
        .eq("conversation_id", activeId)
        .order("created_at", { ascending: true });
      if (!cancelled && !error && data) {
        setMessages(
          data.map((m) => ({
            id: m.id,
            role: m.role as ChatMessage["role"],
            content: m.content,
            createdAt: m.created_at,
          })),
        );
      }
      if (!cancelled) setLoadingMessages(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  // Auto-select most recent conversation when list loads
  useEffect(() => {
    if (!activeId && conversations.length > 0) {
      setActiveId(conversations[0].id);
    }
  }, [conversations, activeId]);

  const createConversation = useCallback(async (): Promise<string | null> => {
    if (!user) return null;
    const { data, error } = await supabase
      .from("chat_conversations")
      .insert({ user_id: user.id })
      .select("id, title, last_message_at, created_at")
      .single();
    if (error || !data) return null;
    const fresh: ChatConversation = {
      id: data.id,
      title: data.title,
      lastMessageAt: data.last_message_at,
      createdAt: data.created_at,
    };
    setConversations((prev) => [fresh, ...prev]);
    setActiveId(fresh.id);
    setMessages([]);
    return fresh.id;
  }, [user]);

  const renameConversation = useCallback(async (id: string, title: string) => {
    const trimmed = title.trim().slice(0, 80);
    if (!trimmed) return;
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: trimmed } : c)));
    await supabase.from("chat_conversations").update({ title: trimmed }).eq("id", id);
  }, []);

  const deleteConversation = useCallback(
    async (id: string) => {
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeId === id) {
        setActiveId(null);
        setMessages([]);
      }
      await supabase.from("chat_conversations").delete().eq("id", id);
    },
    [activeId],
  );

  /** Optimistically append a message locally — used while streaming. */
  const appendLocalMessage = useCallback((m: Omit<ChatMessage, "id" | "createdAt"> & { id?: string }) => {
    setMessages((prev) => [
      ...prev,
      {
        id: m.id ?? `local-${crypto.randomUUID()}`,
        role: m.role,
        content: m.content,
        createdAt: new Date().toISOString(),
      },
    ]);
  }, []);

  /** Update the last assistant message in place — used for streaming chunks. */
  const updateLastAssistant = useCallback((content: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant") {
        return prev.map((m, i) => (i === prev.length - 1 ? { ...m, content } : m));
      }
      return [
        ...prev,
        {
          id: `local-${crypto.randomUUID()}`,
          role: "assistant",
          content,
          createdAt: new Date().toISOString(),
        },
      ];
    });
  }, []);

  /** After streaming completes, reload from server to get canonical IDs. */
  const reloadActiveMessages = useCallback(async () => {
    if (!activeId) return;
    const { data } = await supabase
      .from("chat_messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", activeId)
      .order("created_at", { ascending: true });
    if (data) {
      setMessages(
        data.map((m) => ({
          id: m.id,
          role: m.role as ChatMessage["role"],
          content: m.content,
          createdAt: m.created_at,
        })),
      );
    }
    // Bump the conversation in the sidebar (title may have been auto-set, last_message_at moved)
    refresh();
  }, [activeId, refresh]);

  return {
    conversations,
    activeId,
    setActiveId,
    messages,
    loading,
    loadingMessages,
    createConversation,
    renameConversation,
    deleteConversation,
    appendLocalMessage,
    updateLastAssistant,
    reloadActiveMessages,
  };
}
