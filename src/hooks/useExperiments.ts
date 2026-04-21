import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { Experiment, ExperimentStatus, ExperimentBacktestResult } from "@/lib/domain-types";

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
    proposedBy: (r.proposed_by ?? "user") as Experiment["proposedBy"],
    hypothesis: r.hypothesis,
    backtestResult: (r.backtest_result ?? null) as ExperimentBacktestResult | null,
    strategyId: r.strategy_id,
    autoResolved: !!r.auto_resolved,
    needsReview: !!r.needs_review,
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
      proposed_by: "user",
    });
    if (error) throw error;
    await refetch();
  };

  const setStatus = async (id: string, status: ExperimentStatus) => {
    if (!user) return;
    const patch: any = { status };
    if (status === "accepted" || status === "rejected") patch.needs_review = false;
    const { error } = await supabase.from("experiments").update(patch).eq("id", id).eq("user_id", user.id);
    if (error) throw error;
    await refetch();
  };

  const remove = async (id: string) => {
    if (!user) return;
    const { error } = await supabase.from("experiments").delete().eq("id", id).eq("user_id", user.id);
    if (error) throw error;
    await refetch();
  };

  // Promote an accepted experiment into a new candidate strategy version that
  // copies the approved strategy's params and overrides the tested knob.
  const promoteToStrategy = async (id: string) => {
    if (!user) throw new Error("Not signed in");
    const exp = experiments.find((e) => e.id === id);
    if (!exp) throw new Error("Experiment not found");
    if (exp.status !== "accepted") throw new Error("Only accepted experiments can be promoted");

    // Find approved strategy as the base
    const { data: base } = await supabase
      .from("strategies")
      .select("name,version,params,description")
      .eq("user_id", user.id)
      .eq("status", "approved")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const baseParams: Array<{ key: string; value: any; unit?: string }> = (base?.params as any) ?? [];
    const afterNum = Number(exp.after);
    const newValue = Number.isFinite(afterNum) ? afterNum : exp.after;
    let nextParams = baseParams.map((p) => p.key === exp.parameter ? { ...p, value: newValue } : p);
    if (!baseParams.some((p) => p.key === exp.parameter)) {
      nextParams = [...nextParams, { key: exp.parameter, value: newValue }];
    }

    const baseVersion = base?.version ?? "v1";
    const nextVersion = `${baseVersion}+${exp.parameter}=${exp.after}`;

    const { error } = await supabase.from("strategies").insert({
      user_id: user.id,
      name: base?.name ?? "trend-rev",
      version: nextVersion,
      status: "candidate",
      description: `Promoted from experiment: ${exp.title}. ${exp.hypothesis ?? ""}`.trim(),
      params: nextParams as any,
      metrics: (exp.backtestResult?.after?.metrics ?? {}) as any,
    });
    if (error) throw error;
    return nextVersion;
  };

  const counts = useMemo(() => {
    const c = { queued: 0, running: 0, accepted: 0, rejected: 0, needsReview: 0, copilotProposed: 0, autoResolved: 0 };
    for (const e of experiments) {
      if (e.status === "queued") c.queued++;
      else if (e.status === "running") c.running++;
      else if (e.status === "accepted") c.accepted++;
      else if (e.status === "rejected") c.rejected++;
      if (e.needsReview) c.needsReview++;
      if (e.proposedBy === "copilot") c.copilotProposed++;
      if (e.autoResolved) c.autoResolved++;
    }
    return c;
  }, [experiments]);

  const needsReview = useMemo(() => experiments.filter((e) => e.needsReview), [experiments]);
  const inFlight = useMemo(() => experiments.filter((e) => e.status === "queued" || e.status === "running"), [experiments]);
  const recentlyAutoResolved = useMemo(
    () => experiments.filter((e) => e.autoResolved && (e.status === "accepted" || e.status === "rejected")).slice(0, 20),
    [experiments],
  );

  return { experiments, loading, create, setStatus, remove, refetch, promoteToStrategy, counts, needsReview, inFlight, recentlyAutoResolved };
}
