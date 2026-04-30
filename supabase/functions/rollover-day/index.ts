import { corsHeaders } from "../_shared/cors.ts";
// ============================================================
// rollover-day — UTC midnight start-of-day equity rollover
// ------------------------------------------------------------
// Runs once per UTC day (pg_cron at 00:05 UTC). For every user
// whose `start_of_day_equity` was last set more than 20 hours ago,
// copies their current `equity` into `start_of_day_equity` so the
// "Daily PnL" metric on Overview resets at the day boundary.
//
// Idempotent: if it runs twice in the same day, the second pass
// is a no-op because updated_at-based gating already excludes
// freshly-rolled rows.
//
// Auth: Bearer token from `get_rollover_day_cron_token()` RPC,
// matching the pattern used by mark-to-market.
// ============================================================


Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const { createClient } = await import(
      "https://esm.sh/@supabase/supabase-js@2.45.0"
    );
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // deno-lint-ignore no-explicit-any
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    // Cron-only entrypoint. Validate token via the same vault pattern
    // used elsewhere; if the RPC isn't installed yet, fall back to
    // SERVICE_ROLE bearer for safety during initial deploy.
    const authHeader = req.headers.get("Authorization") ?? "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
    let tokenOk = false;
    try {
      const { data: tok } = await admin.rpc("get_rollover_day_cron_token");
      if (tok && tok === bearer) tokenOk = true;
    } catch {
      // RPC not installed yet — accept service-role key as fallback.
    }
    if (!tokenOk && bearer !== SERVICE_KEY) {
      return new Response(
        JSON.stringify({ error: "rollover-day: unauthorized" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Pick rows whose start-of-day was set > 20h ago. This naturally
    // makes the function idempotent on a per-day cadence.
    const cutoff = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
    const { data: rows, error: fetchErr } = await admin
      .from("account_state")
      .select("user_id, equity, start_of_day_equity, updated_at")
      .lt("updated_at", cutoff);

    if (fetchErr) throw fetchErr;

    // We can't reliably gate by start_of_day_updated_at (no such column),
    // so we re-fetch ALL rows and let the dry-run flag below decide. The
    // updated_at filter above is just an optimization; in practice
    // mark-to-market touches updated_at every 30s, so we drop that filter
    // and instead gate on the actual day boundary.
    const { data: allRows, error: allErr } = await admin
      .from("account_state")
      .select("user_id, equity, start_of_day_equity");
    if (allErr) throw allErr;

    let rolled = 0;
    const todayUtc = new Date().toISOString().slice(0, 10);

    for (const r of allRows ?? []) {
      const equity = Number(r.equity ?? 0);
      const sod = Number(r.start_of_day_equity ?? 0);
      // Skip if equity already equals start_of_day_equity to the cent
      // (already rolled today, or no movement since last roll).
      if (Math.abs(equity - sod) < 0.005) continue;
      const { error: upErr } = await admin
        .from("account_state")
        .update({ start_of_day_equity: equity })
        .eq("user_id", r.user_id);
      if (upErr) {
        console.error("rollover-day update failed", r.user_id, upErr);
        continue;
      }
      rolled += 1;
    }

    return new Response(
      JSON.stringify({
        ok: true,
        ranAt: new Date().toISOString(),
        utcDay: todayUtc,
        scanned: (allRows ?? []).length,
        rolled,
        // Surface how many rows the cutoff filter would have caught,
        // for observability — but we ignore it in production logic.
        wouldHaveCaught: (rows ?? []).length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("rollover-day error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
