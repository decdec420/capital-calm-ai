import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useTableChanges } from "@/hooks/useRealtimeSubscriptions";
import type {
  RecommendationType,
  RecommendationStatus,
  SampleQuality,
} from "@/lib/strategy-learning";
import {
  isExperimentEligible,
  buildExperimentProposalInput,
} from "@/lib/strategy-learning";

// ─── Row shape ────────────────────────────────────────────────────────────────

export interface StrategyLearningRecommendationRow {
  id: string;
  symbol: string | null;
  strategy_id: string | null;
  market_regime: string | null;
  reason_code: string;
  recommendation_type: RecommendationType;
  recommendation: string;
  confidence: number;
  evidence_count: number;
  sample_quality: SampleQuality;
  supporting_simulation_ids: string[];
  status: RecommendationStatus;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  decision: string | null;
}

// ─── Filter options ───────────────────────────────────────────────────────────

export interface RecommendationFilters {
  status?: RecommendationStatus;
  symbol?: string;
  recommendation_type?: RecommendationType;
}

// ─── Review action payload ────────────────────────────────────────────────────

export interface ReviewPayload {
  decision?: string;
}

// ─── Map raw Supabase row ─────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRow(r: any): StrategyLearningRecommendationRow {
  return {
    id: r.id,
    symbol: r.symbol ?? null,
    strategy_id: r.strategy_id ?? null,
    market_regime: r.market_regime ?? null,
    reason_code: r.reason_code,
    recommendation_type: r.recommendation_type as RecommendationType,
    recommendation: r.recommendation,
    confidence: Number(r.confidence ?? 0),
    evidence_count: Number(r.evidence_count ?? 0),
    sample_quality: r.sample_quality as SampleQuality,
    supporting_simulation_ids: r.supporting_simulation_ids ?? [],
    status: r.status as RecommendationStatus,
    created_at: r.created_at,
    reviewed_at: r.reviewed_at ?? null,
    reviewed_by: r.reviewed_by ?? null,
    decision: r.decision ?? null,
  };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useStrategyLearningRecommendations(filters: RecommendationFilters = {}) {
  const { user } = useAuth();
  const [rows, setRows] = useState<StrategyLearningRecommendationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Map from recommendation id → experiment id (deduplication cache)
  const [proposalIds, setProposalIds] = useState<Map<string, string>>(new Map());

  const refetch = useCallback(async () => {
    if (!user) return;
    setError(null);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q = (supabase as any)
      .from("strategy_learning_recommendations")
      .select("*")
      .eq("user_id", user.id);

    if (filters.status) {
      q = q.eq("status", filters.status);
    }
    if (filters.symbol) {
      q = q.eq("symbol", filters.symbol);
    }
    if (filters.recommendation_type) {
      q = q.eq("recommendation_type", filters.recommendation_type);
    }

    // Pending first, then newest within each status group
    q = q
      .order("status", { ascending: true })   // "accepted","deferred","pending_review","rejected" — pending sorts last alphabetically
      .order("created_at", { ascending: false });

    const [{ data, error: fetchErr }, { data: expData }] = await Promise.all([
      q,
      // Fetch existing experiment proposals linked to strategy_learning recommendations
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabase as any)
        .from("experiments")
        .select("id, source_recommendation_id")
        .eq("user_id", user.id)
        .eq("source", "strategy_learning")
        .not("source_recommendation_id", "is", null),
    ]);

    if (fetchErr) {
      setError(fetchErr.message);
    } else {
      // Sort so pending_review always comes first
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sorted = ((data ?? []) as any[])
        .map(mapRow)
        .sort((a, b) => {
          if (a.status === "pending_review" && b.status !== "pending_review") return -1;
          if (b.status === "pending_review" && a.status !== "pending_review") return 1;
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        });
      setRows(sorted);

      // Build deduplication map: recommendation_id → experiment_id
      const pids = new Map<string, string>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const exp of (expData ?? []) as any[]) {
        if (exp.source_recommendation_id) {
          pids.set(exp.source_recommendation_id, exp.id);
        }
      }
      setProposalIds(pids);
    }
    setLoading(false);
  }, [user, filters.status, filters.symbol, filters.recommendation_type]);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    refetch();
  }, [user?.id, refetch]);

  useTableChanges("strategy_learning_recommendations", refetch);

  // ── Review actions — update status + review metadata only ────────────────
  //
  // These actions NEVER:
  //   - Modify strategies or strategy params
  //   - Modify doctrine_settings
  //   - Create or approve trades or signals
  //   - Weaken risk gates or safety blocks
  //   - Call any broker endpoint
  //
  // They ONLY update: status, reviewed_at, reviewed_by, decision

  const reviewAction = useCallback(
    async (id: string, newStatus: "accepted" | "rejected" | "deferred", payload: ReviewPayload = {}) => {
      if (!user) throw new Error("Not signed in");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: updateErr } = await (supabase as any)
        .from("strategy_learning_recommendations")
        .update({
          status: newStatus,
          reviewed_at: new Date().toISOString(),
          reviewed_by: user.email ?? user.id,
          decision: payload.decision ?? null,
        })
        .eq("id", id)
        .eq("user_id", user.id);

      if (updateErr) throw new Error(updateErr.message);
      await refetch();
    },
    [user, refetch],
  );

  const accept = useCallback(
    (id: string, payload?: ReviewPayload) => reviewAction(id, "accepted", payload),
    [reviewAction],
  );

  const reject = useCallback(
    (id: string, payload?: ReviewPayload) => reviewAction(id, "rejected", payload),
    [reviewAction],
  );

  const defer = useCallback(
    (id: string, payload?: ReviewPayload) => reviewAction(id, "deferred", payload),
    [reviewAction],
  );

  // ── Create experiment proposal from an accepted eligible recommendation ──────
  //
  // Safety invariants:
  //   - Only accepted recommendations can create proposals (status guard).
  //   - Only eligible types (TUNE_THRESHOLD, QUESTION_BLOCKER, REVIEW_STRATEGY_FIT).
  //   - Safety-block reason codes are BLOCKED.
  //   - REINFORCE_BLOCKER and INSUFFICIENT_EVIDENCE are BLOCKED.
  //   - Duplicate proposals are PREVENTED (one per recommendation).
  //   - Proposal uses status='needs_review' — run-experiment cron NEVER auto-runs it.
  //   - Does NOT mutate strategies, doctrine, signals, or positions.
  //   - Does NOT create trades or call any broker endpoint.

  const createExperimentProposal = useCallback(
    async (rec: StrategyLearningRecommendationRow): Promise<string> => {
      if (!user) throw new Error("Not signed in");

      // Safety: only accepted eligible recommendations
      if (!isExperimentEligible({ ...rec, status: rec.status })) {
        throw new Error(
          "This recommendation is not eligible for an experiment proposal.",
        );
      }

      // Safety: deduplication — one proposal per recommendation
      if (proposalIds.has(rec.id)) {
        return proposalIds.get(rec.id)!;
      }

      const input = buildExperimentProposalInput({
        id: rec.id,
        user_id: user.id,
        recommendation_type: rec.recommendation_type,
        reason_code: rec.reason_code,
        symbol: rec.symbol,
        strategy_id: rec.strategy_id,
        market_regime: rec.market_regime,
        confidence: rec.confidence,
        evidence_count: rec.evidence_count,
        recommendation: rec.recommendation,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: insErr } = await (supabase as any)
        .from("experiments")
        .insert({
          user_id: input.user_id,
          title: input.title,
          parameter: input.parameter,
          before_value: input.before_value,
          after_value: input.after_value,
          delta: input.delta,
          hypothesis: input.hypothesis,
          status: input.status,
          proposed_by: input.proposed_by,
          source: input.source,
          source_recommendation_id: input.source_recommendation_id,
          symbol: input.symbol,
          strategy_id: input.strategy_id,
          notes: input.notes,
          needs_review: true,
        })
        .select("id")
        .single();

      if (insErr) throw new Error(insErr.message);
      const expId: string = data.id;

      setProposalIds((prev) => new Map(prev).set(rec.id, expId));
      return expId;
    },
    [user, proposalIds],
  );

  const pending = rows.filter((r) => r.status === "pending_review");
  const reviewed = rows.filter((r) => r.status !== "pending_review");

  return {
    rows,
    pending,
    reviewed,
    loading,
    error,
    refetch,
    accept,
    reject,
    defer,
    createExperimentProposal,
    proposalIds,
  };
}
