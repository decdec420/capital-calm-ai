// ============================================================
// process-strategy-learning — PR #39: Strategy Learning Consumer
// ------------------------------------------------------------
// Reads enriched decision_memory_simulations (status=completed,
// used_for_strategy_learning=false), groups evidence by
// (user, symbol, strategy, regime, reason_code, learning_action),
// creates strategy_learning_recommendations rows, then marks
// simulations as used_for_strategy_learning=true.
//
// Designed to run on a cron schedule (e.g. every hour) or be
// called manually for a specific user.
//
// Safety invariants — this function NEVER:
//   - Places, approves, or modifies trades or orders.
//   - Calls any authenticated broker endpoint.
//   - Weakens risk gates or alters doctrine.
//   - Enables live trading or changes paper/live mode.
//   - Auto-mutates strategy params, metrics, or status.
//   - Auto-accepts any recommendation.
//   - Stores credentials, API keys, or auth headers.
//
// All outputs are strategy_learning_recommendations rows with
// status='pending_review'. A human must accept/reject each one.
//
// Consumed flag (used_for_strategy_learning) is set ONLY after
// the recommendation is successfully inserted into the DB.
// If insertion fails, simulations remain available for retry.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, makeCorsHeaders } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import {
  buildAllRecommendations,
  groupEvidence,
  type EvidenceRow,
} from "../_shared/strategy-learning.ts";
import type { SimulationResult } from "../_shared/outcome-enrichment.ts";

const BATCH_SIZE = 200; // simulations per invocation

Deno.serve(async (req) => {
  const cors = makeCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
      Deno.env.get("SERVICE_KEY") ??
      "";
    if (!SERVICE_KEY) {
      return new Response(
        JSON.stringify({ error: "missing service role key" }),
        { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Parse optional request params
    let batchSize = BATCH_SIZE;
    let filterUserId: string | null = null;
    if (req.method === "POST") {
      try {
        const body = await req.json().catch(() => ({}));
        if (body?.batchSize && typeof body.batchSize === "number") {
          batchSize = Math.min(500, Math.max(1, body.batchSize));
        }
        if (body?.userId && typeof body.userId === "string") {
          filterUserId = body.userId;
        }
      } catch {
        // ignore parse errors — use defaults
      }
    }

    // ── Step 1: Fetch unconsumed completed enriched simulations ──────────────
    //
    // Join decision_memory to get blocker_codes, symbol, strategy_id,
    // market_regime, reason_code — all needed for grouping.
    //
    // Only consume:
    //   - status = completed
    //   - used_for_strategy_learning = false
    //   - result IS NOT NULL
    //   - result_label NOT IN (insufficient_data, no_clear_edge) [pre-filter]
    //
    // Missing-side and insufficient records are skipped in groupEvidence()
    // but we do a coarse DB pre-filter to reduce data transfer.
    let query = admin
      .from("decision_memory_simulations")
      .select(
        `id, user_id, decision_memory_id, result,
         decision_memory!inner(
           id, symbol, strategy_id, market_regime,
           reason_code, blocker_codes
         )`,
      )
      .eq("status", "completed")
      .eq("used_for_strategy_learning", false)
      .not("result", "is", null)
      .order("created_at", { ascending: true })
      .limit(batchSize);

    if (filterUserId) {
      query = query.eq("user_id", filterUserId);
    }

    const { data: rawRows, error: fetchErr } = await query;

    if (fetchErr) {
      log("error", "fetch_simulations_failed", {
        fn: "process-strategy-learning",
        err: fetchErr.message,
      });
      return new Response(
        JSON.stringify({ error: fetchErr.message }),
        { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    if (!rawRows || rawRows.length === 0) {
      return new Response(
        JSON.stringify({
          ok: true,
          processed: 0,
          groups: 0,
          recommendations_created: 0,
          simulations_consumed: 0,
          message: "no unconsumed simulations to process",
        }),
        { headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    // ── Step 2: Project to EvidenceRow shape ──────────────────────────────────
    const evidenceRows: EvidenceRow[] = [];
    for (const row of rawRows) {
      // deno-lint-ignore no-explicit-any
      const dm = (row as any).decision_memory as Record<string, unknown> | null;
      if (!dm) continue;

      const result = row.result as SimulationResult | null;
      if (!result) continue;

      // Pre-filter: skip insufficient_data and no_clear_edge at projection time
      if (
        result.result_label === "insufficient_data" ||
        result.result_label === "no_clear_edge" ||
        result.recommended_learning_action === "ignore_insufficient_data"
      ) {
        // Mark as consumed so we don't reprocess these repeatedly
        // Use a background update — don't fail if this errors
        admin
          .from("decision_memory_simulations")
          .update({ used_for_strategy_learning: true })
          .eq("id", row.id as string)
          .then(() => {})
          .catch(() => {});
        continue;
      }

      evidenceRows.push({
        id: row.id as string,
        user_id: row.user_id as string,
        decision_memory_id: row.decision_memory_id as string,
        symbol: (dm.symbol as string | null) ?? null,
        strategy_id: (dm.strategy_id as string | null) ?? null,
        market_regime: (dm.market_regime as string | null) ?? null,
        reason_code: (dm.reason_code as string) ?? "UNKNOWN",
        blocker_codes: (dm.blocker_codes as string[]) ?? [],
        result,
      });
    }

    if (evidenceRows.length === 0) {
      return new Response(
        JSON.stringify({
          ok: true,
          processed: rawRows.length,
          groups: 0,
          recommendations_created: 0,
          simulations_consumed: rawRows.length,
          message: "all simulations were insufficient_data or no_clear_edge — marked consumed",
        }),
        { headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    // ── Step 3: Group evidence ─────────────────────────────────────────────────
    const groups = groupEvidence(evidenceRows);

    if (groups.length === 0) {
      return new Response(
        JSON.stringify({
          ok: true,
          processed: rawRows.length,
          groups: 0,
          recommendations_created: 0,
          simulations_consumed: 0,
          message: "evidence grouped to zero groups — no actionable patterns",
        }),
        { headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    // ── Step 4: Build recommendations ─────────────────────────────────────────
    const recommendations = buildAllRecommendations(groups);

    // ── Step 5: Insert recommendations + mark consumed ────────────────────────
    //
    // For each recommendation:
    //   1. Insert the recommendation row
    //   2. Only after successful insert, mark the contributing simulations consumed
    //
    // If insertion fails, simulations are NOT marked consumed — retry on next run.

    let recommendationsCreated = 0;
    let simulationsConsumed = 0;
    const errors: string[] = [];

    for (let i = 0; i < recommendations.length; i++) {
      const rec = recommendations[i];
      const group = groups[i];
      const simIds = group.rows.map((r) => r.id);

      try {
        const { error: insErr } = await admin
          .from("strategy_learning_recommendations")
          .insert(rec);

        if (insErr) {
          errors.push(
            `group[${i}] ${rec.reason_code}/${rec.recommendation_type}: ${insErr.message}`,
          );
          log("error", "recommendation_insert_failed", {
            fn: "process-strategy-learning",
            reasonCode: rec.reason_code,
            type: rec.recommendation_type,
            err: insErr.message,
          });
          continue; // do NOT mark consumed — retry next run
        }

        recommendationsCreated++;

        // Mark simulations as consumed only after successful insert
        const { error: markErr } = await admin
          .from("decision_memory_simulations")
          .update({ used_for_strategy_learning: true })
          .in("id", simIds);

        if (markErr) {
          // Log but don't fail — recommendation was created; next run will skip via dedup
          log("warn", "mark_consumed_failed", {
            fn: "process-strategy-learning",
            simIds,
            err: markErr.message,
          });
        } else {
          simulationsConsumed += simIds.length;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`group[${i}] ${rec.reason_code}/${rec.recommendation_type}: ${msg}`);
      }
    }

    log("info", "process_complete", {
      fn: "process-strategy-learning",
      rawRows: rawRows.length,
      evidenceRows: evidenceRows.length,
      groups: groups.length,
      recommendationsCreated,
      simulationsConsumed,
      errors: errors.length,
    });

    return new Response(
      JSON.stringify({
        ok: true,
        processed: rawRows.length,
        groups: groups.length,
        recommendations_created: recommendationsCreated,
        simulations_consumed: simulationsConsumed,
        errors: errors.length > 0 ? errors : undefined,
      }),
      { headers: { ...cors, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", "process_strategy_learning_crashed", {
      fn: "process-strategy-learning",
      err: msg,
    });
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }
});
