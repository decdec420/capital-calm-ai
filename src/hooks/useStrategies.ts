import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { StrategyVersion, StrategyStatus, StrategyParam, StrategyMetrics } from "@/lib/domain-types";

function mapRow(r: any): StrategyVersion {
  return {
    id: r.id,
    name: r.name,
    version: r.version,
    status: r.status as StrategyStatus,
    createdAt: r.created_at,
    description: r.description ?? "",
    params: (r.params ?? []) as StrategyParam[],
    metrics: {
      expectancy: 0,
      winRate: 0,
      maxDrawdown: 0,
      sharpe: 0,
      trades: 0,
      ...(r.metrics ?? {}),
    } as StrategyMetrics,
  };
}

export interface NewStrategyInput {
  name: string;
  version: string;
  status?: StrategyStatus;
  description?: string;
  params?: StrategyParam[];
  metrics?: Partial<StrategyMetrics>;
}

export function useStrategies() {
  const { user } = useAuth();
  const [strategies, setStrategies] = useState<StrategyVersion[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = async () => {
    if (!user) return;
    const { data } = await supabase
      .from("strategies")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    setStrategies((data ?? []).map(mapRow));
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

  const create = async (input: NewStrategyInput) => {
    if (!user) throw new Error("Not signed in");
    const { error } = await supabase.from("strategies").insert({
      user_id: user.id,
      name: input.name,
      version: input.version,
      status: input.status ?? "candidate",
      description: input.description ?? "",
      params: (input.params ?? []) as any,
      metrics: (input.metrics ?? {}) as any,
    });
    if (error) throw error;
    await refetch();
  };

  const update = async (id: string, patch: Partial<NewStrategyInput>) => {
    if (!user) return;
    const dbPatch: any = {};
    if (patch.name) dbPatch.name = patch.name;
    if (patch.version) dbPatch.version = patch.version;
    if (patch.status) dbPatch.status = patch.status;
    if (patch.description !== undefined) dbPatch.description = patch.description;
    if (patch.params) dbPatch.params = patch.params;
    if (patch.metrics) dbPatch.metrics = patch.metrics;
    const { error } = await supabase.from("strategies").update(dbPatch).eq("id", id).eq("user_id", user.id);
    if (error) throw error;
    await refetch();
  };

  const remove = async (id: string) => {
    if (!user) return;
    const { error } = await supabase.from("strategies").delete().eq("id", id).eq("user_id", user.id);
    if (error) throw error;
    await refetch();
  };

  return { strategies, loading, create, update, remove, refetch };
}
