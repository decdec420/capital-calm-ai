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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ── PEM normalization ────────────────────────────────────────

function stripPem(pem: string): string {
  return pem
    .replace(/-----BEGIN[^-]+-----/g, "")
    .replace(/-----END[^-]+-----/g, "")
    .replace(/\s/g, "");
}

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

// Wrap a 32-byte raw P-256 private scalar (from a SEC1 EC PRIVATE KEY) into
// a PKCS8 PrivateKeyInfo for prime256v1. We extract the 32-byte private key
// from the SEC1 DER and rebuild as PKCS8. This is a minimal hand-rolled DER
// emitter — only correct for P-256 (prime256v1).
function sec1ToPkcs8Pem(sec1Pem: string): string {
  const sec1 = b64ToBytes(stripPem(sec1Pem));
  // SEC1 ECPrivateKey ::= SEQUENCE { version INTEGER (1), privateKey OCTET STRING(32), ... }
  // Find OCTET STRING tag 0x04 with length 0x20 (32) — that's our scalar.
  let priv: Uint8Array | null = null;
  for (let i = 0; i < sec1.length - 33; i++) {
    if (sec1[i] === 0x04 && sec1[i + 1] === 0x20) {
      priv = sec1.slice(i + 2, i + 2 + 32);
      break;
    }
  }
  if (!priv) throw new Error("Could not parse SEC1 private key — expected 32-byte P-256 scalar");

  // PKCS8 PrivateKeyInfo for prime256v1 (P-256) wrapping the SEC1 ECPrivateKey.
  // Build: SEQUENCE { version 0, AlgorithmIdentifier { ecPublicKey, prime256v1 }, OCTET STRING { ECPrivateKey } }
  // ECPrivateKey: SEQUENCE { INTEGER 1, OCTET STRING priv }
  const ecPrivateKey = new Uint8Array([
    0x30, 0x25,                         // SEQUENCE, len 37
    0x02, 0x01, 0x01,                   // INTEGER 1
    0x04, 0x20, ...priv,                // OCTET STRING priv (32)
    0xa1, 0x00,                         // [1] empty publicKey (optional)
  ]);

  // AlgorithmIdentifier: SEQUENCE { OID 1.2.840.10045.2.1 (ecPublicKey), OID 1.2.840.10045.3.1.7 (prime256v1) }
  const algId = new Uint8Array([
    0x30, 0x13,
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
  ]);

  const inner = new Uint8Array([
    0x02, 0x01, 0x00,                   // version 0
    ...algId,
    0x04, ecPrivateKey.length, ...ecPrivateKey, // OCTET STRING wrapping ECPrivateKey
  ]);

  const pkcs8 = new Uint8Array([0x30, 0x82, (inner.length >> 8) & 0xff, inner.length & 0xff, ...inner]);
  const b64 = bytesToB64(pkcs8);
  const wrapped = b64.match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----\n`;
}

function normalizePem(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes("BEGIN PRIVATE KEY")) {
    return trimmed.endsWith("\n") ? trimmed : trimmed + "\n";
  }
  if (trimmed.includes("BEGIN EC PRIVATE KEY")) {
    return sec1ToPkcs8Pem(trimmed);
  }
  throw new Error(
    "Private key must be PEM with -----BEGIN PRIVATE KEY----- or -----BEGIN EC PRIVATE KEY-----",
  );
}

// ── JWT signing (probe only, mirrors broker.ts) ──────────────

function encodeB64url(obj: object): string {
  const json = JSON.stringify(obj);
  let bin = "";
  new TextEncoder().encode(json).forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function signJwt(keyName: string, pkcs8Pem: string): Promise<string> {
  const keyBytes = b64ToBytes(stripPem(pkcs8Pem));
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const header = { alg: "ES256", kid: keyName, typ: "JWT" };
  const payload = { iss: "coinbase-cloud", sub: keyName, nbf: now, exp: now + 60, nonce };
  const sigInput = `${encodeB64url(header)}.${encodeB64url(payload)}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(sigInput),
  );
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${sigInput}.${sigB64}`;
}

async function probeAccounts(keyName: string, pkcs8Pem: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  try {
    const jwt = await signJwt(keyName, pkcs8Pem);
    const r = await fetch("https://api.coinbase.com/api/v3/brokerage/accounts?limit=1", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (r.ok) {
      await r.text();
      return { ok: true };
    }
    const txt = await r.text();
    return { ok: false, status: r.status, error: txt.slice(0, 400) };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

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
        pkcs8 = normalizePem(rawPem);
      } catch (e) {
        return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Invalid PEM" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Probe BEFORE persisting — never store invalid creds
      const probe = await probeAccounts(keyName, pkcs8);
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
      const probe = await probeAccounts(row.api_key_name, row.api_key_private_pem);
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
