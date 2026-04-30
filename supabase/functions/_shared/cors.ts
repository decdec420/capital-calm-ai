// ============================================================
// Shared CORS headers
// ------------------------------------------------------------
// Set ALLOWED_ORIGINS env var to a comma-separated list of
// allowed origins (e.g. "https://your-app.lovable.app").
// Falls back to "*" only when the env var is unset (local dev).
// ============================================================

const raw = Deno.env.get("ALLOWED_ORIGINS") ?? "";
const allowedOrigins: string[] = raw
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// For module-level usage (e.g., json() helpers that don't have
// the Request in scope). Uses the first configured origin; falls
// back to "*" for dev environments.
const staticOrigin = allowedOrigins[0] ?? "*";

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": staticOrigin,
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/**
 * Per-request variant — validates the incoming Origin header against
 * the allowlist and returns an exact-match or "null" (blocked).
 * Prefer this in OPTIONS handlers and anywhere you have the Request.
 */
export function makeCorsHeaders(req: Request): Record<string, string> {
  if (allowedOrigins.length === 0) {
    return corsHeaders; // dev: no allowlist configured
  }
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
      ? origin
      : "null",
    "Access-Control-Allow-Headers": corsHeaders["Access-Control-Allow-Headers"],
  };
}
