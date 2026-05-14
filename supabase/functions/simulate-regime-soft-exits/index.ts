// ============================================================
// simulate-regime-soft-exits — manual dry-run soft-exit worker
// ------------------------------------------------------------
// On-demand only in this PR. Do not schedule aggressively. Future scheduling
// should follow the existing Supabase pg_cron + pg_net + Vault-token pattern.
// This function never calls broker execution and never mutates trades,
// stops, take-profits, doctrine, strategies, or signals.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { makeCorsHeaders } from "../_shared/cors.ts";
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts";
import {
  createSupabaseRegimeSoftExitStorage,
  runRegimeSoftExitSimulationWorker,
} from "../_shared/regime-soft-exit-worker.ts";

Deno.serve(async (req) => {
  const cors = makeCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";

  const authed = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData } = await authed.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const admin = createClient(supabaseUrl, serviceKey);
  const rl = await checkRateLimit(admin, userId, "simulate-regime-soft-exits", 12);
  if (!rl.allowed) return rateLimitResponse(cors, rl);

  try {
    const result = await runRegimeSoftExitSimulationWorker(
      createSupabaseRegimeSoftExitStorage(admin),
    );

    return new Response(JSON.stringify({
      ...result,
      executionAllowed: false,
      message: "Simulation only — no trade was closed, no stop was changed, and no broker action was taken.",
    }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({
      error: e instanceof Error ? e.message : String(e),
      executionAllowed: false,
    }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
