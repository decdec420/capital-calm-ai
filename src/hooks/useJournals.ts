import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { JournalEntry, JournalKind } from "@/lib/domain-types";

function mapRow(r: any): JournalEntry {
  return {
    id: r.id,
    kind: r.kind as JournalKind,
    title: r.title,
    summary: r.summary ?? "",
    timestamp: r.created_at,
    tags: r.tags ?? [],
    raw: r.raw,
    llmExplanation: r.llm_explanation,
  };
}

export interface NewJournalInput {
  kind: JournalKind;
  title: string;
  summary?: string;
  tags?: string[];
}

export function useJournals() {
  const { user } = useAuth();
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = async () => {
    if (!user) return;
    const { data } = await supabase
      .from("journal_entries")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    setEntries((data ?? []).map(mapRow));
    setLoading(false);
  };

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const create = async (input: NewJournalInput) => {
    if (!user) throw new Error("Not signed in");
    const { error } = await supabase.from("journal_entries").insert({
      user_id: user.id,
      kind: input.kind,
      title: input.title,
      summary: input.summary ?? "",
      tags: input.tags ?? [],
    });
    if (error) throw error;
    await refetch();
  };

  const update = async (id: string, patch: Partial<NewJournalInput> & { llmExplanation?: string | null }) => {
    if (!user) return;
    const dbPatch: any = {};
    if (patch.kind) dbPatch.kind = patch.kind;
    if (patch.title) dbPatch.title = patch.title;
    if (patch.summary !== undefined) dbPatch.summary = patch.summary;
    if (patch.tags) dbPatch.tags = patch.tags;
    if (patch.llmExplanation !== undefined) dbPatch.llm_explanation = patch.llmExplanation;
    const { error } = await supabase.from("journal_entries").update(dbPatch).eq("id", id).eq("user_id", user.id);
    if (error) throw error;
    await refetch();
  };

  const remove = async (id: string) => {
    if (!user) return;
    const { error } = await supabase.from("journal_entries").delete().eq("id", id).eq("user_id", user.id);
    if (error) throw error;
    await refetch();
  };

  return { entries, loading, create, update, remove, refetch };
}
