import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { RiskGuardrail, RiskLevel, GuardrailType } from "@/lib/domain-types";

function mapRow(r: any): RiskGuardrail {
  return {
    id: r.id,
    label: r.label,
    description: r.description ?? "",
    current: r.current_value ?? "",
    limit: r.limit_value ?? "",
    level: r.level as RiskLevel,
    utilization: Number(r.utilization),
    sortOrder: r.sort_order,
    guardrailType: (r.guardrail_type ?? "generic") as GuardrailType,
  };
}

export interface NewGuardrailInput {
  label: string;
  description?: string;
  current?: string;
  limit?: string;
  level?: RiskLevel;
  utilization?: number;
  sortOrder?: number;
}

export function useGuardrails() {
  const { user } = useAuth();
  const [guardrails, setGuardrails] = useState<RiskGuardrail[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = async () => {
    if (!user) return;
    const { data } = await supabase
      .from("guardrails")
      .select("*")
      .eq("user_id", user.id)
      .order("sort_order", { ascending: true });
    setGuardrails((data ?? []).map(mapRow));
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

  const create = async (input: NewGuardrailInput) => {
    if (!user) throw new Error("Not signed in");
    const { error } = await supabase.from("guardrails").insert({
      user_id: user.id,
      label: input.label,
      description: input.description ?? "",
      current_value: input.current ?? "",
      limit_value: input.limit ?? "",
      level: input.level ?? "safe",
      utilization: input.utilization ?? 0,
      sort_order: input.sortOrder ?? 99,
    });
    if (error) throw error;
    await refetch();
  };

  const update = async (id: string, patch: NewGuardrailInput) => {
    if (!user) return;
    const dbPatch: any = {};
    if (patch.label) dbPatch.label = patch.label;
    if (patch.description !== undefined) dbPatch.description = patch.description;
    if (patch.current !== undefined) dbPatch.current_value = patch.current;
    if (patch.limit !== undefined) dbPatch.limit_value = patch.limit;
    if (patch.level) dbPatch.level = patch.level;
    if (patch.utilization !== undefined) dbPatch.utilization = patch.utilization;
    const { error } = await supabase.from("guardrails").update(dbPatch).eq("id", id).eq("user_id", user.id);
    if (error) throw error;
    await refetch();
  };

  const remove = async (id: string) => {
    if (!user) return;
    const { error } = await supabase.from("guardrails").delete().eq("id", id).eq("user_id", user.id);
    if (error) throw error;
    await refetch();
  };

  return { guardrails, loading, create, update, remove, refetch };
}
