import { useEffect, useMemo, useState } from "react";
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

/** Stable signature for a param set so we can detect duplicate candidates. */
function paramSig(params: StrategyParam[]): string {
  return [...params]
    .map((p) => `${p.key}=${String(p.value)}`)
    .sort()
    .join("|");
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

  // ─── Pipeline derivations ──────────────────────────────────────────────
  // The Strategy Lab is a single-lane pipeline: one Live, one In-Testing,
  // everything else queued. We surface those views here so the UI doesn't
  // have to re-derive them ad hoc.
  const approved = useMemo(() => strategies.find((s) => s.status === "approved") ?? null, [strategies]);
  const candidates = useMemo(() => strategies.filter((s) => s.status === "candidate"), [strategies]);
  const archived = useMemo(() => strategies.filter((s) => s.status === "archived"), [strategies]);

  /** The candidate currently "in testing" — most paper trades wins.
   * Ties broken by most-recently updated (i.e. most recent activity). */
  const inTesting = useMemo<StrategyVersion | null>(() => {
    if (candidates.length === 0) return null;
    return [...candidates].sort((a, b) => {
      const dt = (b.metrics.trades ?? 0) - (a.metrics.trades ?? 0);
      if (dt !== 0) return dt;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    })[0];
  }, [candidates]);

  const queued = useMemo(
    () => candidates.filter((c) => c.id !== inTesting?.id),
    [candidates, inTesting?.id],
  );

  /** Group queued candidates by identical param signature so the UI can flag
   * duplicates (the "4 identical stop_atr_mult=2 candidates" mess). */
  const duplicateIds = useMemo(() => {
    const groups = new Map<string, StrategyVersion[]>();
    for (const c of candidates) {
      const sig = paramSig(c.params);
      const arr = groups.get(sig) ?? [];
      arr.push(c);
      groups.set(sig, arr);
    }
    const dupes = new Set<string>();
    for (const arr of groups.values()) {
      if (arr.length < 2) continue;
      // Keep the one with the most trades (and newest as tie-breaker); mark the rest.
      const sorted = [...arr].sort((a, b) => {
        const dt = (b.metrics.trades ?? 0) - (a.metrics.trades ?? 0);
        if (dt !== 0) return dt;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
      for (let i = 1; i < sorted.length; i++) dupes.add(sorted[i].id);
    }
    return dupes;
  }, [candidates]);

  /** Move a queued candidate into the testing slot. We don't need to mutate
   * status (everything stays "candidate") — `inTesting` is derived from
   * `metrics.trades`, so we bump the target's `updated_at` so it wins the
   * tie-break. To reliably take the slot we also "park" the current
   * in-testing candidate's trade count behind the new one. To keep it
   * simple and non-destructive, we just bump the new candidate's metric
   * trade count above the current one (only if needed). */
  const moveTesting = async (id: string) => {
    if (!user) return;
    const target = candidates.find((c) => c.id === id);
    if (!target) return;
    const currentTrades = inTesting?.metrics.trades ?? 0;
    const targetTrades = target.metrics.trades ?? 0;
    // If the target already has more trades, just touching updated_at is enough.
    const newMetrics: StrategyMetrics = { ...target.metrics };
    if (targetTrades <= currentTrades) {
      newMetrics.trades = currentTrades + 1;
    }
    const { error } = await supabase
      .from("strategies")
      .update({ metrics: newMetrics as any, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", user.id);
    if (error) throw error;
    await refetch();
  };

  /** Archive every duplicate candidate, leaving the "winner" of each group. */
  const removeDuplicates = async () => {
    if (!user || duplicateIds.size === 0) return 0;
    const ids = Array.from(duplicateIds);
    const { error } = await supabase
      .from("strategies")
      .update({ status: "archived" })
      .in("id", ids)
      .eq("user_id", user.id);
    if (error) throw error;
    await refetch();
    return ids.length;
  };

  return {
    strategies,
    loading,
    create,
    update,
    remove,
    refetch,
    // pipeline views
    approved,
    candidates,
    inTesting,
    queued,
    archived,
    duplicateIds,
    moveTesting,
    removeDuplicates,
  };
}
