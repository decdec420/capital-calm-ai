import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type {
  Experiment,
  ExperimentStatus,
  ExperimentBacktestResult,
  CopilotMemoryRow,
} from "@/lib/domain-types";

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

function mapMemory(r: any): CopilotMemoryRow {
  return {
    id: r.id,
    parameter: r.parameter,
    direction: r.direction,
    fromValue: Number(r.from_value),
    toValue: Number(r.to_value),
    outcome: r.outcome,
    expDelta: r.exp_delta != null ? Number(r.exp_delta) : null,
    winRateDelta: r.win_rate_delta != null ? Number(r.win_rate_delta) : null,
    sharpeDelta: r.sharpe_delta != null ? Number(r.sharpe_delta) : null,
    drawdownDelta: r.drawdown_delta != null ? Number(r.drawdown_delta) : null,
    attemptCount: Number(r.attempt_count ?? 1),
    lastTriedAt: r.last_tried_at,
    retryAfter: r.retry_after,
    experimentId: r.experiment_id,
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
  const [memory, setMemory] = useState<CopilotMemoryRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = async () => {
    if (!user) return;
    const [{ data: expData }, { data: memData }] = await Promise.all([
      supabase
        .from("experiments")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false }),
      // copilot_memory rows live alongside experiments and drive the "what
      // have we already learned" panel + the AI proposer's cooldown logic.
      supabase
        .from("copilot_memory" as any)
        .select("*")
        .eq("user_id", user.id)
        .order("last_tried_at", { ascending: false }),
    ]);
    setExperiments((expData ?? []).map(mapRow));
    setMemory(((memData ?? []) as any[]).map(mapMemory));
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

  /** Wipe memory for one parameter — useful after a strategy rewrite when
   * what we "learned" about ema_fast no longer applies. */
  const clearMemory = async (parameter: string) => {
    if (!user) return;
    const { error } = await supabase
      .from("copilot_memory" as any)
      .delete()
      .eq("user_id", user.id)
      .eq("parameter", parameter);
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

    // Insert the new candidate strategy and grab its id so we can stamp it
    // back on the experiment — that's how we know "this one already shipped"
    // and stop showing it in the "ready to ship" pile.
    const { data: inserted, error } = await supabase
      .from("strategies")
      .insert({
        user_id: user.id,
        name: base?.name ?? "trend-rev",
        version: nextVersion,
        status: "candidate",
        description: `Promoted from experiment: ${exp.title}. ${exp.hypothesis ?? ""}`.trim(),
        params: nextParams as any,
        metrics: (exp.backtestResult?.after?.metrics ?? {}) as any,
      })
      .select("id")
      .single();
    if (error) throw error;

    // Mark the experiment as promoted by linking it to the new strategy. The
    // experiment itself stays accepted (history), but the UI now treats it as
    // shipped instead of "ready to ship".
    if (inserted?.id) {
      await supabase
        .from("experiments")
        .update({ strategy_id: inserted.id })
        .eq("id", id)
        .eq("user_id", user.id);
    }
    await refetch();
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
  // "Ready to ship" = accepted but not yet promoted into a candidate strategy.
  // Once promoted (strategyId set), it moves to the Promoted section instead.
  const accepted = useMemo(
    () => experiments.filter((e) => e.status === "accepted" && !e.strategyId).slice(0, 20),
    [experiments],
  );
  const promoted = useMemo(
    () => experiments.filter((e) => !!e.strategyId).slice(0, 20),
    [experiments],
  );
  const recentlyAutoResolved = useMemo(
    () => experiments.filter((e) => e.autoResolved && (e.status === "accepted" || e.status === "rejected")).slice(0, 20),
    [experiments],
  );

  return {
    experiments,
    loading,
    create,
    setStatus,
    remove,
    refetch,
    promoteToStrategy,
    counts,
    needsReview,
    inFlight,
    accepted,
    recentlyAutoResolved,
    memory,
    memoryCount: memory.length,
    clearMemory,
  };
}
