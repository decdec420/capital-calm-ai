import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { Experiment, ExperimentStatus } from "@/lib/domain-types";

function mapRow(r: any): Experiment {
  return {
    id: r.id,
    title: r.title,
    status: r.status as ExperimentStatus,
    parameter: r.parameter ?? "",
    before: r.before_value ?? "",
    after: r.after_value ?? "",
    delta: r.delta ?? "",
    createdAt: r.created_at,
    notes: r.notes,
  };
}

export interface NewExperimentInput {
  title: string;
  parameter: string;
  before: string;
  after: string;
  delta?: string;
  status?: ExperimentStatus;
  notes?: string;
}

export function useExperiments() {
  const { user } = useAuth();
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = async () => {
    if (!user) return;
    const { data } = await supabase
      .from("experiments")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    setExperiments((data ?? []).map(mapRow));
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

  const create = async (input: NewExperimentInput) => {
    if (!user) throw new Error("Not signed in");
    const { error } = await supabase.from("experiments").insert({
      user_id: user.id,
      title: input.title,
      parameter: input.parameter,
      before_value: input.before,
      after_value: input.after,
      delta: input.delta ?? "",
      status: input.status ?? "queued",
      notes: input.notes ?? null,
    });
    if (error) throw error;
    await refetch();
  };

  const setStatus = async (id: string, status: ExperimentStatus) => {
    if (!user) return;
    const { error } = await supabase.from("experiments").update({ status }).eq("id", id).eq("user_id", user.id);
    if (error) throw error;
    await refetch();
  };

  const remove = async (id: string) => {
    if (!user) return;
    const { error } = await supabase.from("experiments").delete().eq("id", id).eq("user_id", user.id);
    if (error) throw error;
    await refetch();
  };

  return { experiments, loading, create, setStatus, remove, refetch };
}
