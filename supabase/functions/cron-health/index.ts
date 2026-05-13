import { corsHeaders, makeCorsHeaders } from "../_shared/cors.ts";

const SECRET_PATTERNS = [
  /bearer\s+[a-z0-9._~+\-/]+=*/i,
  /authorization/i,
  /cron[_-]?token/i,
  /service[_-]?role/i,
  /vault/i,
  /decrypted[_-]?secret/i,
  /headers?/i,
  /net\.http_post/i,
];

type CronHealthRpcRow = {
  job_name: string;
  category: "trading" | "market_data" | "learning" | "ops" | "retention" | "safety";
  configured: boolean;
  last_run_at: string | null;
  last_status: "succeeded" | "failed" | "running" | "unknown";
  last_safe_message: string | null;
  expected_every_seconds: number | null;
  stale: boolean;
  severity: "ok" | "info" | "warning" | "critical";
  user_attention_required: boolean;
};

type CronHealthRow = {
  jobName: string;
  category: CronHealthRpcRow["category"];
  configured: boolean;
  lastRunAt: string | null;
  lastStatus: CronHealthRpcRow["last_status"];
  lastSafeMessage: string | null;
  expectedEverySeconds: number | null;
  stale: boolean;
  severity: CronHealthRpcRow["severity"];
  userAttentionRequired: boolean;
};

function containsSecretMaterial(value: unknown): boolean {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function sanitizeMessage(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  if (containsSecretMaterial(value)) return "Cron health details were sanitized.";
  return value.slice(0, 180);
}

function mapRow(row: CronHealthRpcRow): CronHealthRow {
  return {
    jobName: row.job_name,
    category: row.category,
    configured: row.configured === true,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastSafeMessage: sanitizeMessage(row.last_safe_message),
    expectedEverySeconds: typeof row.expected_every_seconds === "number" ? row.expected_every_seconds : null,
    stale: row.stale === true,
    severity: row.severity,
    userAttentionRequired: row.user_attention_required === true,
  };
}

Deno.serve(async (req) => {
  const cors = makeCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!supabaseUrl || !anonKey || !serviceRoleKey) throw new Error("Supabase environment is not configured");

    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.45.0");
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const { data, error } = await admin.rpc("get_cron_health_status", {
      p_user_id: userData.user.id,
    });
    if (error) throw error;

    const rows = ((Array.isArray(data) ? data : []) as CronHealthRpcRow[]).map(mapRow);
    const summary = rows.reduce(
      (acc, row) => {
        if (row.severity === "critical") acc.critical += 1;
        else if (row.severity === "warning") acc.warning += 1;
        else if (row.severity === "ok") acc.ok += 1;
        else acc.unknown += 1;
        return acc;
      },
      { critical: 0, warning: 0, ok: 0, unknown: 0 },
    );

    const body = { rows, summary, lastCheckedAt: new Date().toISOString() };
    if (containsSecretMaterial(body)) throw new Error("Sanitization guard blocked cron health response");

    return new Response(JSON.stringify(body), {
      headers: { ...corsHeaders, ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[cron-health] failed", err);
    return new Response(JSON.stringify({ error: "Failed to load sanitized cron health" }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
