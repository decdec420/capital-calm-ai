// ============================================================
// enrich-simulations — PR #38: Outcome Enrichment + Wendy Loop
// ------------------------------------------------------------
// Processes decision_memory rows with used_for_learning = false,
// fetches forward Coinbase candles to compute hypothetical outcomes,
// stores results in decision_memory_simulations, and marks the
// source decision_memory rows as used_for_learning = true.
//
// Designed to run on a cron schedule (e.g. every 15 minutes) or
// be called manually. Processes up to BATCH_SIZE rows per invocation.
//
// Safety invariants — this function NEVER:
//   - Places, approves, or modifies trades or orders.
//   - Calls any authenticated broker endpoint.
//   - Weakens risk gates or alters doctrine.
//   - Enables live trading or changes paper/live mode.
//   - Stores credentials, API keys, or auth headers.
//
// All writes go to decision_memory_simulations only.
// decision_memory.used_for_learning is set true only after a
// successful simulation result is stored (or intentional ignore).
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, makeCorsHeaders } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import {
  enrichDecisionMemorySimulation,
  type LookaheadWindow,
  MIN_ENRICHMENT_AGE_SECONDS,
} from "../_shared/outcome-enrichment.ts";

const BATCH_SIZE = 20;
const DEFAULT_LOOKAHEAD: LookaheadWindow = "1h";

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
    let lookahead: LookaheadWindow = DEFAULT_LOOKAHEAD;
    let batchSize = BATCH_SIZE;
    if (req.method === "POST") {
      try {
        const body = await req.json().catch(() => ({}));
        if (body?.lookahead && ["15m", "1h", "4h"].includes(body.lookahead)) {
          lookahead = body.lookahead as LookaheadWindow;
        }
        if (body?.batchSize && typeof body.batchSize === "number") {
          batchSize = Math.min(100, Math.max(1, body.batchSize));
        }
      } catch {
        // ignore parse errors — use defaults
      }
    }

    // Minimum age cutoff: decisions too recent don't have forward candle data yet
    const minAgeSeconds = MIN_ENRICHMENT_AGE_SECONDS[lookahead];
    const cutoffTime = new Date(Date.now() - minAgeSeconds * 1000).toISOString();

    // Fetch unprocessed decision_memory rows (used_for_learning = false)
    // with a symbol and created before the cutoff.
    const { data: decisions, error: fetchErr } = await admin
      .from("decision_memory")
      .select(
        "id, user_id, symbol, blocker_codes, replay_packet, created_at",
      )
      .eq("used_for_learning", false)
      .not("symbol", "is", null)
      .lt("created_at", cutoffTime)
      .order("created_at", { ascending: true })
      .limit(batchSize);

    if (fetchErr) {
      log("error", "fetch_decisions_failed", {
        fn: "enrich-simulations",
        err: fetchErr.message,
      });
      return new Response(
        JSON.stringify({ error: fetchErr.message }),
        { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    if (!decisions || decisions.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, processed: 0, message: "no decisions to enrich" }),
        { headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    const results: Array<{
      decisionMemoryId: string;
      simulationId: string | null;
      resultLabel: string;
      learningAction: string;
      error: string | null;
    }> = [];

    for (const decision of decisions) {
      const decisionId = decision.id as string;
      const userId = decision.user_id as string;
      const symbol = decision.symbol as string | null;
      const blockerCodes = (decision.blocker_codes as string[]) ?? [];
      // deno-lint-ignore no-explicit-any
      const replayPacket = decision.replay_packet as Record<string, any> | null;
      const decisionRanAt =
        (replayPacket?.ranAt as string | null) ??
        (decision.created_at as string);

      // Extract side from replay_packet — try meta.side first, then market.side.
      // Null when the packet predates direction recording; enrichment will mark missing_side.
      const rawSide =
        (replayPacket?.meta?.side as string | null | undefined) ??
        (replayPacket?.market?.side as string | null | undefined) ??
        null;
      const side: "long" | "short" | null =
        rawSide === "long" || rawSide === "short" ? rawSide : null;

      let simulationId: string | null = null;
      let resultLabel = "insufficient_data";
      let learningAction = "ignore_insufficient_data";
      let rowError: string | null = null;

      try {
        // Check if a simulation already exists for this decision
        const { data: existing } = await admin
          .from("decision_memory_simulations")
          .select("id, status")
          .eq("decision_memory_id", decisionId)
          .eq("lookahead_window", lookahead)
          .maybeSingle();

        if (existing && existing.status === "completed") {
          // Already enriched — just mark the source as used
          await admin
            .from("decision_memory")
            .update({ used_for_learning: true })
            .eq("id", decisionId);
          results.push({
            decisionMemoryId: decisionId,
            simulationId: existing.id as string,
            resultLabel: "already_completed",
            learningAction: "n/a",
            error: null,
          });
          continue;
        }

        // Insert or update simulation row to 'running'
        if (existing) {
          await admin
            .from("decision_memory_simulations")
            .update({ status: "running", updated_at: new Date().toISOString() })
            .eq("id", existing.id);
          simulationId = existing.id as string;
        } else {
          const { data: simRow, error: insErr } = await admin
            .from("decision_memory_simulations")
            .insert({
              decision_memory_id: decisionId,
              user_id: userId,
              simulation_type: "TAKEN_IF_NOT_BLOCKED",
              lookahead_window: lookahead,
              status: "running",
            })
            .select("id")
            .single();
          if (insErr || !simRow) {
            log("warn", "sim_insert_failed", {
              fn: "enrich-simulations",
              decisionId,
              err: insErr?.message,
            });
            rowError = `sim insert failed: ${insErr?.message ?? "unknown"}`;
            results.push({
              decisionMemoryId: decisionId,
              simulationId: null,
              resultLabel: "error",
              learningAction: "ignore_insufficient_data",
              error: rowError,
            });
            continue;
          }
          simulationId = simRow.id as string;
        }

        // Run enrichment — fetch forward candles and compute hypothetical outcome
        const enrichResult = await enrichDecisionMemorySimulation({
          symbol,
          blockerCodes,
          decisionRanAt,
          lookaheadWindow: lookahead,
          side,
        });

        resultLabel = enrichResult.result_label;
        learningAction = enrichResult.recommended_learning_action;

        // Persist the result
        await admin
          .from("decision_memory_simulations")
          .update({
            status: "completed",
            result: enrichResult,
            failure_reason: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", simulationId);

        // Mark decision as used_for_learning = true.
        // Only set true when we have a definitive result OR explicit ignore.
        // insufficient_data without a clear reason is NOT marked as learned —
        // we may retry after more data is available.
        const shouldMarkLearned =
          enrichResult.result_label !== "insufficient_data" ||
          enrichResult.insufficient_data_reason?.startsWith("no symbol") ||
          enrichResult.insufficient_data_reason?.startsWith("no ranAt") ||
          enrichResult.insufficient_data_reason?.startsWith("invalid ranAt") ||
          // missing_side is permanent — replay packet won't gain side retroactively
          enrichResult.insufficient_data_reason?.startsWith("missing_side");

        if (shouldMarkLearned) {
          await admin
            .from("decision_memory")
            .update({ used_for_learning: true })
            .eq("id", decisionId);
        }

        log("info", "simulation_enriched", {
          fn: "enrich-simulations",
          decisionId,
          simulationId,
          resultLabel,
          learningAction,
          markedLearned: shouldMarkLearned,
        });
      } catch (e) {
        rowError = e instanceof Error ? e.message : String(e);
        log("error", "simulation_error", {
          fn: "enrich-simulations",
          decisionId,
          err: rowError,
        });
        // Mark simulation as failed if we have an ID
        if (simulationId) {
          await admin
            .from("decision_memory_simulations")
            .update({
              status: "failed",
              failure_reason: rowError,
              updated_at: new Date().toISOString(),
            })
            .eq("id", simulationId)
            .catch(() => {/* best-effort */});
        }
      }

      results.push({
        decisionMemoryId: decisionId,
        simulationId,
        resultLabel,
        learningAction,
        error: rowError,
      });
    }

    const successCount = results.filter((r) => !r.error).length;
    const errorCount = results.filter((r) => r.error).length;
    const enrichedCount = results.filter((r) =>
      r.resultLabel !== "insufficient_data" &&
      r.resultLabel !== "error" &&
      r.resultLabel !== "already_completed"
    ).length;

    return new Response(
      JSON.stringify({
        ok: true,
        processed: results.length,
        enriched: enrichedCount,
        skipped_insufficient_data: results.filter(
          (r) => r.resultLabel === "insufficient_data",
        ).length,
        errors: errorCount,
        successes: successCount,
        lookahead,
        results,
      }),
      { headers: { ...cors, "Content-Type": "application/json" } },
    );
  } catch (e) {
    log("error", "handler_error", {
      fn: "enrich-simulations",
      err: e instanceof Error ? e.message : String(e),
    });
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown" }),
      {
        status: 500,
        headers: { ...cors, "Content-Type": "application/json" },
      },
    );
  }
});
