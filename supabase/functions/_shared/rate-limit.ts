// rate-limit.ts — per-user sliding-window rate limiter for edge functions.
//
// Backed by an atomic Postgres function (`check_and_increment_rate_limit`)
// which performs the check + increment in a single statement using
// INSERT ... ON CONFLICT ... DO UPDATE. This eliminates the read-then-write
// race that a naive client-side implementation would have.
//
// Usage: call checkRateLimit() near the top of any user-facing handler,
// after JWT verification (so userId is known) and before any expensive work.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

/**
 * Atomically check and increment the rate-limit counter for (userId, fnName).
 *
 * @param admin       Service-role Supabase client
 * @param userId      Authenticated user's UUID
 * @param fnName      Edge function name, e.g. "copilot-chat"
 * @param maxRequests Max requests allowed per window
 * @param windowMs    Window size in ms (default: 60_000)
 *
 * Fail-open: if the RPC errors (e.g. transient DB issue), we allow the
 * request rather than locking the user out of the product.
 */
export async function checkRateLimit(
  admin: ReturnType<typeof createClient>,
  userId: string,
  fnName: string,
  maxRequests: number,
  windowMs = 60_000,
): Promise<RateLimitResult> {
  const windowSeconds = Math.max(1, Math.ceil(windowMs / 1000));

  const { data, error } = await admin.rpc("check_and_increment_rate_limit", {
    p_user_id: userId,
    p_function_name: fnName,
    p_max_requests: maxRequests,
    p_window_seconds: windowSeconds,
  });

  if (error) {
    console.error(`[rate-limit] RPC error for ${fnName}:`, error.message);
    // Fail-open
    return {
      allowed: true,
      remaining: maxRequests,
      resetAt: new Date(Date.now() + windowMs),
    };
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return {
      allowed: true,
      remaining: maxRequests,
      resetAt: new Date(Date.now() + windowMs),
    };
  }

  return {
    allowed: !!row.allowed,
    remaining: typeof row.remaining === "number" ? row.remaining : 0,
    resetAt: row.reset_at ? new Date(row.reset_at) : new Date(Date.now() + windowMs),
  };
}

/**
 * Build a 429 response with a Retry-After header.
 */
export function rateLimitResponse(
  result: RateLimitResult,
  corsHeaders: Record<string, string>,
): Response {
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((result.resetAt.getTime() - Date.now()) / 1000),
  );
  return new Response(
    JSON.stringify({
      error: "Rate limit exceeded",
      retryAfter: retryAfterSeconds,
    }),
    {
      status: 429,
      headers: {
        ...corsHeaders,
        "Retry-After": String(retryAfterSeconds),
        "Content-Type": "application/json",
      },
    },
  );
}
