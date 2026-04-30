// ============================================================
// update-doctrine — single entrypoint for editing doctrine settings.
// Tighten → applies instantly. Loosen → 24h pending change.
// Every change writes to system_audit_log.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  isLoosening,
  type DoctrineField,
  DOCTRINE_FIELD_LABELS,
} from "../_shared/doctrine-resolver.ts";
import { corsHeaders } from "../_shared/cors.ts";


const COOLDOWN_MS = 24 * 60 * 60 * 1000;

const VALID_FIELDS: DoctrineField[] = [
  "max_order_pct",
  "max_order_abs_cap",
  "daily_loss_pct",
  "max_trades_per_day",
  "floor_pct",
  "risk_per_trade_pct",
  "consecutive_loss_limit",
  "loss_cooldown_minutes",
  "scan_interval_seconds",
  "max_correlated_positions",
];

interface ChangeRequest {
  field: DoctrineField;
  to_value: number;
  reason?: string;
}

interface ResultRow {
  field: DoctrineField;
  from_value: number | null;
  to_value: number;
  applied: "instant" | "pending" | "noop";
  effective_at?: string;
  pending_id?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Validate JWT — only the signed-in user can edit their doctrine.
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return json({ error: "missing authorization" }, 401);
    }
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userResp, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userResp?.user) {
      return json({ error: "invalid token" }, 401);
    }
    const userId = userResp.user.id;

    const body = await req.json().catch(() => null);
    const changes: ChangeRequest[] = Array.isArray(body?.changes) ? body.changes : [];
    const startingEquityUsd: number | undefined =
      typeof body?.starting_equity_usd === "number" ? body.starting_equity_usd : undefined;

    if (changes.length === 0 && startingEquityUsd === undefined) {
      return json({ error: "no changes provided" }, 400);
    }

    // Validate field names + numeric values
    for (const c of changes) {
      if (!VALID_FIELDS.includes(c.field)) {
        return json({ error: `invalid field: ${c.field}` }, 400);
      }
      if (typeof c.to_value !== "number" || !Number.isFinite(c.to_value)) {
        return json({ error: `invalid to_value for ${c.field}` }, 400);
      }
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // Load current settings
    const { data: settings, error: sErr } = await admin
      .from("doctrine_settings")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (sErr) return json({ error: sErr.message }, 500);
    if (!settings) return json({ error: "doctrine_settings row missing" }, 500);

    const results: ResultRow[] = [];
    const instantPatch: Record<string, number | null> = {};

    // Handle starting_equity_usd specially — pure setup, no tighten/loosen logic.
    if (startingEquityUsd !== undefined) {
      if (startingEquityUsd < 1) {
        return json({ error: "starting_equity_usd must be >= 1" }, 400);
      }
      instantPatch.starting_equity_usd = startingEquityUsd;
      await admin.rpc("append_audit_log", {
        p_user_id: userId,
        p_action: "doctrine.starting_equity.set",
        p_actor: "user",
        p_trade_id: null,
        p_symbol: null,
        p_amount_usd: startingEquityUsd,
        p_details: {
          from: settings.starting_equity_usd,
          to: startingEquityUsd,
        },
      });
    }

    for (const c of changes) {
      const from = Number((settings as Record<string, unknown>)[c.field] ?? 0);
      const to = c.to_value;
      if (from === to) {
        results.push({ field: c.field, from_value: from, to_value: to, applied: "noop" });
        continue;
      }

      const loosening = isLoosening(c.field, from, to);

      if (!loosening) {
        // Tightening → instant
        instantPatch[c.field] = to;
        await admin.rpc("append_audit_log", {
          p_user_id: userId,
          p_action: "doctrine.tighten",
          p_actor: "user",
          p_trade_id: null,
          p_symbol: null,
          p_amount_usd: null,
          p_details: {
            field: c.field,
            label: DOCTRINE_FIELD_LABELS[c.field],
            from,
            to,
            reason: c.reason ?? null,
          },
        });
        results.push({ field: c.field, from_value: from, to_value: to, applied: "instant" });
      } else {
        // Loosening → 24h pending
        const effectiveAt = new Date(Date.now() + COOLDOWN_MS).toISOString();
        // Mark any older pending rows for the same field as superseded
        await admin
          .from("pending_doctrine_changes")
          .update({ status: "superseded" })
          .eq("user_id", userId)
          .eq("field", c.field)
          .eq("status", "pending");
        const { data: pending, error: pErr } = await admin
          .from("pending_doctrine_changes")
          .insert({
            user_id: userId,
            field: c.field,
            from_value: from,
            to_value: to,
            effective_at: effectiveAt,
            reason: c.reason ?? null,
          })
          .select("id, effective_at")
          .single();
        if (pErr) {
          console.error("[update-doctrine] pending insert failed", pErr);
          return json({ error: pErr.message }, 500);
        }
        await admin.rpc("append_audit_log", {
          p_user_id: userId,
          p_action: "doctrine.loosen.requested",
          p_actor: "user",
          p_trade_id: null,
          p_symbol: null,
          p_amount_usd: null,
          p_details: {
            field: c.field,
            label: DOCTRINE_FIELD_LABELS[c.field],
            from,
            to,
            effective_at: effectiveAt,
            pending_id: pending.id,
            reason: c.reason ?? null,
          },
        });
        results.push({
          field: c.field,
          from_value: from,
          to_value: to,
          applied: "pending",
          effective_at: pending.effective_at,
          pending_id: pending.id,
        });
      }
    }

    if (Object.keys(instantPatch).length > 0) {
      const { error: uErr } = await admin
        .from("doctrine_settings")
        .update({ ...instantPatch, updated_via: "user", updated_at: new Date().toISOString() })
        .eq("user_id", userId);
      if (uErr) {
        console.error("[update-doctrine] settings update failed", uErr);
        return json({ error: uErr.message }, 500);
      }
    }

    console.log(
      `[update-doctrine] user=${userId} instant=${Object.keys(instantPatch).length} pending=${
        results.filter((r) => r.applied === "pending").length
      }`,
    );

    return json({ ok: true, results });
  } catch (e) {
    console.error("[update-doctrine] error", e);
    return json({ error: e instanceof Error ? e.message : "unknown error" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
