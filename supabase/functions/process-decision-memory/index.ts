// ============================================================
// process-decision-memory — Batch Simulation Queue drainer
// ------------------------------------------------------------
// PR #37: Drains unprocessed decision_memory rows and runs
// deterministic scoring simulations against each one.
//
// Job lifecycle per decision_memory row:
//   1. Query decision_memory WHERE used_for_learning = false (up to BATCH_SIZE).
//   2. For each row, determine which simulation types apply.
//   3. INSERT decision_memory_simulations rows (status='queued').
//   4. For each job, run the pure simulation engine (no broker calls).
//   5. UPDATE the job row with result + status='completed'.
//   6. Only after all jobs for a memory row succeed: mark
//      decision_memory.used_for_learning = true.
//   7. If any step fails: leave used_for_learning = false (retry on next run).
//
// Auth: cron token (vault) OR logged-in user JWT.
//
// Safety invariants:
//   - NEVER calls broker execution (no jessica/katrina imports).
//   - NEVER inserts into trades or trade_signals.
//   - NEVER modifies doctrine.
//   - NEVER approves or rejects signals.
//   - Simulation engine is physically separate from execution code.
//   - used_for_learning is set ONLY after successful result storage.
//   - Failures leave used_for_learning = false (safe to retry).
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts";
import { makeCorsHeaders } from "../_shared/cors.ts";
import {
  buildInputSnapshot,
  getSimulationTypesForReason,
  runSimulation,
  type SimulationInputSnapshot,
  type SimulationType,
} from "../_shared/simulation-engine.ts";

// Maximum decision_memory rows to process in a single invocation.
// Keeps wall-clock time within Supabase edge function limits (~30s).
const BATCH_SIZE = 25;

// Maximum concurrent simulation jobs per memory row (never > sim types count).
const MAX_JOBS_PER_ROW = 2;

// ── Types ─────────────────────────────────────────────────────────────────────

interface DecisionMemoryRowRaw {
  id: string;
  user_id: string;
  symbol: string | null;
  strategy_id: string | null;
  reason_code: string;
  severity: string;
  mode: string;
  market_regime: string | null;
  confidence: number | null;
  setup_score: number | null;
  blocker_codes: string[];
  used_for_learning: boolean;
  created_at: string;
}

interface ProcessResult {
  memoryId: string;
  userId: string;
  jobsCreated: number;
  jobsCompleted: number;
  jobsFailed: number;
  markedLearned: boolean;
  error?: string;
}

// ── Core processing ───────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
async function processOneRow(
  admin: any,
  row: DecisionMemoryRowRaw,
): Promise<ProcessResult> {
  const snapshot: SimulationInputSnapshot = buildInputSnapshot({
    symbol: row.symbol,
    regime: row.market_regime,
    setupScore: row.setup_score,
    confidence: row.confidence,
    reasonCode: row.reason_code,
    severity: row.severity,
    blockerCodes: row.blocker_codes ?? [],
    mode: row.mode,
    createdAt: row.created_at,
  });

  const simTypes: SimulationType[] = getSimulationTypesForReason(row.reason_code)
    .slice(0, MAX_JOBS_PER_ROW);

  // ── Step 1: insert queued job rows ─────────────────────────────────────────
  const jobInserts = simTypes.map((simType) => ({
    decision_memory_id: row.id,
    user_id: row.user_id,
    symbol: row.symbol,
    strategy_id: row.strategy_id ?? null,
    simulation_type: simType,
    status: "queued",
    input_snapshot: snapshot as unknown as Record<string, unknown>,
  }));

  // ignoreDuplicates: if a concurrent run already inserted jobs for this
  // (decision_memory_id, simulation_type), the unique constraint fires and we
  // get back an empty array rather than an error. The concurrent runner owns
  // those jobs and will mark used_for_learning when it finishes — we exit
  // cleanly here and leave the flag untouched.
  const { data: insertedJobs, error: insertErr } = await admin
    .from("decision_memory_simulations")
    .insert(jobInserts, { ignoreDuplicates: true })
    .select("id, simulation_type");

  if (insertErr) {
    return {
      memoryId: row.id,
      userId: row.user_id,
      jobsCreated: 0,
      jobsCompleted: 0,
      jobsFailed: 0,
      markedLearned: false,
      error: `job insert failed: ${insertErr.message}`,
    };
  }

  // All jobs were already inserted by a concurrent run — exit safely.
  if (!insertedJobs || insertedJobs.length === 0) {
    return {
      memoryId: row.id,
      userId: row.user_id,
      jobsCreated: 0,
      jobsCompleted: 0,
      jobsFailed: 0,
      markedLearned: false,
    };
  }

  // ── Step 2: run each simulation and store result ───────────────────────────
  let completedCount = 0;
  let failedCount = 0;

  for (const job of insertedJobs as Array<{ id: string; simulation_type: SimulationType }>) {
    // Mark running — check error explicitly; .update() resolves instead of throwing.
    // If this write fails the job stays 'queued' and the simulation must not proceed
    // or a future invocation will re-run the same job producing a duplicate result.
    const { error: runningErr } = await admin
      .from("decision_memory_simulations")
      .update({ status: "running", started_at: new Date().toISOString() })
      .eq("id", job.id);

    if (runningErr) {
      console.error(
        `[process-decision-memory] failed to mark job ${job.id} running:`,
        runningErr.message,
      );
      failedCount++;
      continue;
    }

    try {
      const result = runSimulation(job.simulation_type, snapshot);

      // Check the update error explicitly — .update() resolves rather than
      // throws on DB/RLS failures. If the result write fails we must count
      // this as a failure so allSucceeded stays false and used_for_learning
      // is NOT set on the parent row, keeping it in the retry queue.
      const { error: resultErr } = await admin
        .from("decision_memory_simulations")
        .update({
          status: "completed",
          result: result as unknown as Record<string, unknown>,
          score: result.score,
          completed_at: new Date().toISOString(),
        })
        .eq("id", job.id);

      if (resultErr) {
        console.error(
          `[process-decision-memory] result write failed for job ${job.id}:`,
          resultErr.message,
        );
        await admin
          .from("decision_memory_simulations")
          .update({
            status: "failed",
            error: `result write failed: ${resultErr.message}`,
            completed_at: new Date().toISOString(),
          })
          .eq("id", job.id);
        failedCount++;
      } else {
        completedCount++;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(
        `[process-decision-memory] job ${job.id} failed:`,
        errMsg,
      );

      await admin
        .from("decision_memory_simulations")
        .update({
          status: "failed",
          error: errMsg,
          completed_at: new Date().toISOString(),
        })
        .eq("id", job.id);

      failedCount++;
    }
  }

  // ── Step 3: mark used_for_learning = true ONLY if all jobs succeeded ───────
  // If any job failed we leave the flag false so the next run retries.
  const allSucceeded = failedCount === 0 && completedCount === insertedJobs.length;
  let markedLearned = false;

  if (allSucceeded) {
    const { error: updateErr } = await admin
      .from("decision_memory")
      .update({ used_for_learning: true })
      .eq("id", row.id);

    if (updateErr) {
      console.warn(
        `[process-decision-memory] could not mark ${row.id} learned:`,
        updateErr.message,
      );
    } else {
      markedLearned = true;
    }
  }

  return {
    memoryId: row.id,
    userId: row.user_id,
    jobsCreated: insertedJobs.length,
    jobsCompleted: completedCount,
    jobsFailed: failedCount,
    markedLearned,
  };
}

// deno-lint-ignore no-explicit-any
async function processForUser(admin: any, userId: string): Promise<ProcessResult[]> {
  const { data: rows, error: fetchErr } = await admin
    .from("decision_memory")
    .select(
      "id, user_id, symbol, strategy_id, reason_code, severity, mode, " +
        "market_regime, confidence, setup_score, blocker_codes, used_for_learning, created_at",
    )
    .eq("user_id", userId)
    .eq("used_for_learning", false)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (fetchErr) {
    console.error("[process-decision-memory] fetch error:", fetchErr.message);
    return [];
  }

  const memoryRows = (rows ?? []) as DecisionMemoryRowRaw[];
  if (memoryRows.length === 0) return [];

  const results: ProcessResult[] = [];
  for (const row of memoryRows) {
    try {
      results.push(await processOneRow(admin, row));
    } catch (err) {
      results.push({
        memoryId: row.id,
        userId: row.user_id,
        jobsCreated: 0,
        jobsCompleted: 0,
        jobsFailed: 1,
        markedLearned: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

// ── HTTP handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const cors = makeCorsHeaders(req);
  const json = (b: unknown, s: number) =>
    new Response(JSON.stringify(b), {
      status: s,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const admin = createClient(supabaseUrl, serviceRoleKey);

    const authHeader = req.headers.get("Authorization") ?? "";
    let userIds: string[] = [];

    // Cron token auth
    const { data: cronTokenData } = await admin.rpc("get_signal_engine_cron_token");
    const cronToken = (cronTokenData as string | null) ?? null;
    const isCron = !!(cronToken && authHeader === `Bearer ${cronToken}`);

    if (isCron) {
      // Process all users that have unlearned rows
      const { data: rows } = await admin
        .from("decision_memory")
        .select("user_id")
        .eq("used_for_learning", false);
      userIds = Array.from(
        new Set(((rows ?? []) as Array<{ user_id: string }>).map((r) => r.user_id)),
      );
    } else {
      // User JWT auth
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const token = authHeader.replace("Bearer ", "");
      const { data: userData, error: userErr } = await userClient.auth.getUser(token);
      if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
      userIds = [userData.user.id];

      const rl = await checkRateLimit(admin, userData.user.id, "process-decision-memory", 10);
      if (!rl.allowed) return rateLimitResponse(rl, cors);
    }

    if (userIds.length === 0) {
      return json({ ok: true, processed: 0, results: [] }, 200);
    }

    const allResults: ProcessResult[] = [];
    for (const uid of userIds) {
      try {
        const results = await processForUser(admin, uid);
        allResults.push(...results);
      } catch (err) {
        allResults.push({
          memoryId: "unknown",
          userId: uid,
          jobsCreated: 0,
          jobsCompleted: 0,
          jobsFailed: 0,
          markedLearned: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const totalRows = allResults.length;
    const totalJobs = allResults.reduce((s, r) => s + r.jobsCreated, 0);
    const totalCompleted = allResults.reduce((s, r) => s + r.jobsCompleted, 0);
    const totalFailed = allResults.reduce((s, r) => s + r.jobsFailed, 0);
    const totalMarked = allResults.filter((r) => r.markedLearned).length;

    return json(
      {
        ok: true,
        memoryRowsProcessed: totalRows,
        jobsCreated: totalJobs,
        jobsCompleted: totalCompleted,
        jobsFailed: totalFailed,
        memoryRowsMarkedLearned: totalMarked,
        results: allResults,
      },
      200,
    );
  } catch (e) {
    console.error("process-decision-memory error", e);
    return json({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});

