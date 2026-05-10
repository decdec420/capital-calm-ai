// ============================================================
// useStrategyLearningExperiments — PR #42
// Fetch and promote strategy_learning experiment proposals.
//
// Safety invariants:
//   - Only fetches experiments where source = 'strategy_learning'.
//   - promoteToQueued validates before/after and status before writing.
//   - Promotion only updates: before_value, after_value, delta, status, notes.
//   - source and source_recommendation_id are NEVER mutated.
//   - proposed_by is NEVER mutated.
//   - Does NOT mutate strategies, doctrine, risk gates, or signals.
//   - Does NOT create trades or call any broker endpoint.
//   - Only needs_review → queued transitions are allowed.
//   - queued, running, accepted, rejected experiments are blocked.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useTableChanges } from "@/hooks/useRealtimeSubscriptions";
import {
  validatePromoteToQueued,
  computeDelta,
  type ValidationResult,
} from "@/lib/experiment-review";

// ─── Row shape ────────────────────────────────────────────────────────────────

export interface StrategyLearningExperimentRow {
  id: string;
  title: string;
  parameter: string;
  /** Current before_value — empty string until reviewer fills it in. */
  beforeValue: string;
  /** Current after_value — empty string until reviewer fills it in. */
  afterValue: string;
  hypothesis: string | null;
  notes: string | null;
  status: string;
  source: string;
  sourceRecommendationId: string | null;
  symbol: string | null;
  strategyId: string | null;
  createdAt: string;
}

// ─── Row mapper ───────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRow(r: any): StrategyLearningExperimentRow {
  return {
    id: r.id,
    title: r.title ?? "",
    parameter: r.parameter ?? "",
    beforeValue: r.before_value ?? "",
    afterValue: r.after_value ?? "",
    hypothesis: r.hypothesis ?? null,
    notes: r.notes ?? null,
    status: r.status ?? "needs_review",
    source: r.source ?? "strategy_learning",
    sourceRecommendationId: r.source_recommendation_id ?? null,
    symbol: r.symbol ?? null,
    strategyId: r.strategy_id ?? null,
    createdAt: r.created_at,
  };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface PromoteToQueuedOptions {
  beforeValue: string;
  afterValue: string;
  reviewerNotes?: string;
}

export function useStrategyLearningExperiments() {
  const { user } = useAuth();
  const [proposals, setProposals] = useState<StrategyLearningExperimentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!user) return;
    setError(null);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error: fetchErr } = await (supabase as any)
      .from("experiments")
      .select("id, title, parameter, before_value, after_value, hypothesis, notes, status, source, source_recommendation_id, symbol, strategy_id, created_at")
      .eq("user_id", user.id)
      .eq("source", "strategy_learning")
      .eq("status", "needs_review")
      .order("created_at", { ascending: false });

    if (fetchErr) {
      setError(fetchErr.message);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setProposals(((data ?? []) as any[]).map(mapRow));
    }
    setLoading(false);
  }, [user]);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useTableChanges("experiments", refetch);

  // ── Validate without committing ──────────────────────────────────────────

  const validate = useCallback(
    (id: string, opts: PromoteToQueuedOptions): ValidationResult => {
      const row = proposals.find((p) => p.id === id);
      if (!row) {
        return { valid: false, errors: ["Proposal not found."] };
      }
      return validatePromoteToQueued({
        id: row.id,
        status: row.status,
        source: row.source,
        parameter: row.parameter,
        beforeValue: opts.beforeValue,
        afterValue: opts.afterValue,
      });
    },
    [proposals],
  );

  // ── Promote to Queued ────────────────────────────────────────────────────
  //
  // Safety: this action ONLY updates before_value, after_value, delta,
  // status, and optionally appends reviewer notes. It NEVER:
  //   - Mutates strategies or strategy params.
  //   - Mutates doctrine_settings or doctrine mode.
  //   - Creates or approves trades or signals.
  //   - Weakens risk gates or safety blocks.
  //   - Calls any broker or execution endpoint.
  //   - Changes source or source_recommendation_id.
  //
  // The experiment becomes eligible for the existing run-experiment pipeline
  // only after this update — no experiment runs immediately.

  const promoteToQueued = useCallback(
    async (id: string, opts: PromoteToQueuedOptions): Promise<void> => {
      if (!user) throw new Error("Not signed in");

      const row = proposals.find((p) => p.id === id);
      if (!row) throw new Error("Proposal not found");

      // Validate — throws a structured error if invalid
      const result = validatePromoteToQueued({
        id: row.id,
        status: row.status,
        source: row.source,
        parameter: row.parameter,
        beforeValue: opts.beforeValue,
        afterValue: opts.afterValue,
      });

      if (!result.valid) {
        throw new Error(result.errors.join(" "));
      }

      const delta = computeDelta(row.parameter, opts.beforeValue, opts.afterValue);

      // Append reviewer notes to existing notes if provided
      let updatedNotes = row.notes ?? "";
      if (opts.reviewerNotes?.trim()) {
        const separator = updatedNotes ? "\n\n" : "";
        updatedNotes = `${updatedNotes}${separator}Reviewer notes: ${opts.reviewerNotes.trim()}`;
      }

      // Patch ONLY the fields that a reviewer is allowed to set.
      // source, source_recommendation_id, proposed_by, user_id, title,
      // parameter, hypothesis are all preserved as-is.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: updateErr } = await (supabase as any)
        .from("experiments")
        .update({
          before_value: opts.beforeValue.trim(),
          after_value: opts.afterValue.trim(),
          delta,
          status: "queued",
          notes: updatedNotes || null,
          needs_review: false,
        })
        .eq("id", id)
        .eq("user_id", user.id)
        .eq("source", "strategy_learning")
        .eq("status", "needs_review");

      if (updateErr) throw new Error(updateErr.message);

      await refetch();
    },
    [user, proposals, refetch],
  );

  return {
    proposals,
    loading,
    error,
    refetch,
    validate,
    promoteToQueued,
  };
}
