// ============================================================
// Shared CORS helpers
// ------------------------------------------------------------
// Set ALLOWED_ORIGINS (Lovable secret) to a comma-separated list.
// Supports exact origins and glob-style wildcards:
//   https://capital-calm-ai.lovable.app
//   https://*.lovableproject.com
//   https://*.lovable.app
//   http://localhost:8080
//
// makeCorsHeaders(req) is the PRIMARY export. Use it in every
// handler so the response echoes back the validated origin and
// sets Vary: Origin (prevents cache poisoning).
//
// The static corsHeaders export uses "*" — acceptable ONLY for
// cron-internal error paths that never reach a browser. For any
// response that the browser actually reads (including credentialed
// JWT requests) you MUST use makeCorsHeaders(req).
// ============================================================

const raw = Deno.env.get("ALLOWED_ORIGINS") ?? "";
const allowedOrigins: string[] = raw
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOW_HEADERS =
  "authorization, x-client-info, apikey, content-type, " +
  "x-supabase-client-platform, x-supabase-client-platform-version, " +
  "x-supabase-client-runtime, x-supabase-client-runtime-version";

/**
 * Returns true when `origin` matches `pattern`.
 * Pattern may be an exact URL or contain a single leading wildcard
 * segment, e.g. "https://*.lovableproject.com".
 */
function originMatches(pattern: string, origin: string): boolean {
  if (!pattern.includes("*")) return pattern === origin;
  // Convert "https://*.lovableproject.com" → regex
  // Escape dots, replace * with [^.]+ (one subdomain segment only)
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace("\\*", "[^.]+");
  return new RegExp(`^${escaped}$`).test(origin);
}

/**
 * Per-request CORS headers. Call this in every handler.
 * Echoes the validated origin back so the browser accepts the response
 * even for credentialed (Authorization header) requests, which browsers
 * reject when Access-Control-Allow-Origin is "*".
 */
export function makeCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed =
    allowedOrigins.length === 0 ||
    allowedOrigins.some((p) => originMatches(p, origin));

  return {
    "Access-Control-Allow-Origin": allowed && origin ? origin : (allowedOrigins.length === 0 ? "*" : "null"),
    "Access-Control-Allow-Headers": ALLOW_HEADERS,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}

/**
 * Static fallback — only safe for non-browser paths (cron error
 * responses, module-level helpers with no request context).
 * Do NOT use for responses that carry JWT-authenticated data.
 */
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": allowedOrigins.length === 0 ? "*" : allowedOrigins[0],
  "Access-Control-Allow-Headers": ALLOW_HEADERS,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
