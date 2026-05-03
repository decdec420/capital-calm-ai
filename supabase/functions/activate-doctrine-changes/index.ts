// ============================================================
// activate-doctrine-changes — cron-only.
// Finds pending_doctrine_changes whose effective_at has passed
// and applies them to doctrine_settings. Marks the row activated
// and writes an audit log entry. Runs every 5 minutes.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders, makeCorsHeaders} from "../_shared/cors.ts";


Deno.serve(async (req) => {
    const cors = makeCorsHeaders(req);
if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // Token check — only cron can call this.
    const authHeader = req.headers.get("authorization") ?? "";
    const provided = authHeader.replace(/^Bearer\s+/i, "");
    const { data: tokenRow } = await admin.rpc("get_activate_doctrine_changes_cron_token");
    const expected = (tokenRow as string | null) ?? "";
    if (!expected || provided !== expected) {
      return json({ error: "unauthorized" }, 401);
    }

    const { data: due, error: dueErr } = await admin
      .from("pending_doctrine_changes")
      .select("id, user_id, field, from_value, to_value, effective_at, reason")
      .eq("status", "pending")
      .lte("effective_at", new Date().toISOString())
      .order("effective_at", { ascending: true })
      .limit(200);
    if (dueErr) return json({ error: dueErr.message }, 500);

    let activated = 0;
    let failed = 0;

    for (const row of due ?? []) {
      try {
        // Apply the change to doctrine_settings
        const patch: Record<string, number> = {};
        patch[row.field] = Number(row.to_value);

        const { error: uErr } = await admin
          .from("doctrine_settings")
          .update({ ...patch, updated_via: "cooldown-activation", updated_at: new Date().toISOString() })
          .eq("user_id", row.user_id);
        if (uErr) {
          console.error(`[activate-doctrine] update failed for ${row.id}`, uErr);
          failed++;
          continue;
        }

        // Mark the pending row activated
        const { error: mErr } = await admin
          .from("pending_doctrine_changes")
          .update({ status: "activated", activated_at: new Date().toISOString() })
          .eq("id", row.id);
        if (mErr) {
          console.error(`[activate-doctrine] mark activated failed for ${row.id}`, mErr);
          failed++;
          continue;
        }

        // Audit log
        await admin.rpc("append_audit_log", {
          p_user_id: row.user_id,
          p_action: "doctrine.loosen.activated",
          p_actor: "system",
          p_trade_id: null,
          p_symbol: null,
          p_amount_usd: null,
          p_details: {
            field: row.field,
            from: row.from_value,
            to: row.to_value,
            requested_at: row.effective_at,
            pending_id: row.id,
            reason: row.reason,
          },
        });

        // Post a low-severity alert so the user sees it
        await admin.from("alerts").insert({
          user_id: row.user_id,
          severity: "info",
          title: `Doctrine change active · ${row.field}`,
          message: `${row.field} loosened from ${row.from_value} → ${row.to_value} after the 24h cooldown.`,
        });

        activated++;
      } catch (e) {
        console.error(`[activate-doctrine] unexpected error on ${row.id}`, e);
        failed++;
      }
    }

    console.log(`[activate-doctrine] checked=${due?.length ?? 0} activated=${activated} failed=${failed}`);
    return json({ ok: true, checked: due?.length ?? 0, activated, failed });
  } catch (e) {
    console.error("[activate-doctrine] error", e);
    return json({ error: e instanceof Error ? e.message : "unknown error" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
