// ============================================================
// broker-connection edge function
// ------------------------------------------------------------
// Actions (per authenticated user):
//   GET  ?action=status          → returns broker_health row
//   POST { action: "save",       → validates PEM, normalizes to PKCS8,
//          keyName, privatePem }    runs read-only probe, writes Vault
//   POST { action: "disconnect" } → deletes vault secrets, clears health
//
// All Coinbase secrets are workspace-wide (single-tenant Vault), but the
// broker_health row is per-user so the UI can react.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { normalizeCoinbasePrivateKeyPem, probeCoinbaseAccounts } from "../_shared/coinbase-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ── Handler ──────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Auth
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const userId = userData.user.id;
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Parse action
  let action = new URL(req.url).searchParams.get("action") ?? "status";
  let body: Record<string, unknown> = {};
  if (req.method === "POST") {
    try {
      body = await req.json();
      action = (body.action as string) ?? action;
    } catch { /* ignore */ }
  }

  try {
    if (action === "status") {
      const { data } = await admin.from("broker_health").select("*").eq("user_id", userId).maybeSingle();
      return new Response(JSON.stringify({ ok: true, health: data ?? { status: "not_connected" } }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "save") {
      const keyName = String(body.keyName ?? "").trim();
      const rawPem = String(body.privatePem ?? "").trim();
      if (!keyName || keyName.length < 8 || keyName.length > 500) {
        return new Response(JSON.stringify({ error: "keyName must be 8-500 chars" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!rawPem || rawPem.length > 5000) {
        return new Response(JSON.stringify({ error: "privatePem missing or too large" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      let pkcs8: string;
      try {
        pkcs8 = normalizeCoinbasePrivateKeyPem(rawPem);
      } catch (e) {
        return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Invalid PEM" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Probe BEFORE persisting — never store invalid creds
      const probe = await probeCoinbaseAccounts(keyName, pkcs8);
      if (!probe.ok) {
        const friendly = probe.status === 401 || probe.status === 403
          ? `Coinbase rejected the credentials (HTTP ${probe.status}). Check the API key name and that the key has 'view' + 'trade' scopes.`
          : `Probe failed: ${probe.error}`;
        await admin.rpc("update_broker_health", {
          p_user_id: userId, p_status: "auth_failed", p_key_name: keyName, p_error: friendly,
        });
        return new Response(JSON.stringify({ error: friendly, status: probe.status }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Probe passed — write Vault
      const { error: e1 } = await admin.rpc("upsert_broker_secret", {
        p_name: "coinbase_api_key_name", p_value: keyName, p_description: "Coinbase Advanced Trade API key name",
      });
      if (e1) throw new Error(`Vault key name write failed: ${e1.message}`);
      const { error: e2 } = await admin.rpc("upsert_broker_secret", {
        p_name: "coinbase_api_key_private_pem", p_value: pkcs8, p_description: "Coinbase Advanced Trade EC private key (PKCS8)",
      });
      if (e2) throw new Error(`Vault private key write failed: ${e2.message}`);

      await admin.rpc("update_broker_health", {
        p_user_id: userId, p_status: "healthy", p_key_name: keyName, p_error: null,
      });

      return new Response(JSON.stringify({ ok: true, status: "healthy", keyName }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "disconnect") {
      const { error } = await admin.rpc("delete_broker_secrets");
      if (error) throw new Error(`Vault delete failed: ${error.message}`);
      await admin.rpc("update_broker_health", {
        p_user_id: userId, p_status: "not_connected", p_key_name: null, p_error: null,
      });
      return new Response(JSON.stringify({ ok: true, status: "not_connected" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "probe") {
      // Re-probe using the currently-stored Vault credentials. Used by the
      // background health check and the "Re-test" button.
      const { data, error } = await admin.rpc("get_coinbase_broker_credentials");
      if (error) throw new Error(`Vault read failed: ${error.message}`);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.api_key_name || !row?.api_key_private_pem) {
        await admin.rpc("update_broker_health", {
          p_user_id: userId, p_status: "not_connected", p_key_name: null, p_error: "No credentials in Vault",
        });
        return new Response(JSON.stringify({ ok: true, status: "not_connected" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const probe = await probeCoinbaseAccounts(row.api_key_name, row.api_key_private_pem);
      if (probe.ok) {
        await admin.rpc("update_broker_health", {
          p_user_id: userId, p_status: "healthy", p_key_name: row.api_key_name, p_error: null,
        });
        return new Response(JSON.stringify({ ok: true, status: "healthy" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const friendly = probe.status === 401 || probe.status === 403
        ? `Coinbase rejected the credentials (HTTP ${probe.status}). Reconnect required.`
        : `Probe failed: ${probe.error}`;
      await admin.rpc("update_broker_health", {
        p_user_id: userId, p_status: "auth_failed", p_key_name: row.api_key_name, p_error: friendly,
      });
      return new Response(JSON.stringify({ ok: false, status: "auth_failed", error: friendly }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[broker-connection] error", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
