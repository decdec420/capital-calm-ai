# Fix: "Run new review" blocked by CORS (and same bug across all edge functions)

## What's happening

When you click **Run new review** in Taylor's Strategy Brief, the browser sends a CORS preflight to the `katrina` edge function. The function responds with:

```
Access-Control-Allow-Origin: https://capital-calm-ai.lovable.app
```

But you're on the preview origin `https://dacbb29c-a598-42a1-b73e-1e1e4a5d0271.lovableproject.com`. The browser sees the mismatch and aborts — the function never runs, no review is created, and you see the "Failed to load resource" error.

The other warning in your console (`AlertDialogContent` ref forwarding) is a pre-existing shadcn/Radix dev-only warning unrelated to this issue.

## Root cause

`supabase/functions/_shared/cors.ts` builds a **static** `corsHeaders` object that pins `Access-Control-Allow-Origin` to the *first* entry of the `ALLOWED_ORIGINS` env var (currently the published domain). A `makeCorsHeaders(req)` helper exists that reflects the request origin properly — but almost every function imports the static version instead.

So this is a latent backend-wide bug. Katrina is just the most visible because clicking "Run new review" is a one-shot user-triggered fetch — most other functions are background cron jobs where you don't see the failures.

## The fix

### 1. Harden `supabase/functions/_shared/cors.ts`

- Keep `makeCorsHeaders(req)` as the canonical helper, but extend it to support **wildcard origins** like `https://*.lovableproject.com` and `https://*.lovable.app` so every preview sandbox works without manually updating the env var.
- Always add `Vary: Origin` to prevent cache poisoning.
- Always echo back `Access-Control-Allow-Methods` and `Access-Control-Max-Age` so preflights are cached.
- Keep the static `corsHeaders` export as a safe fallback (`*`) but stop using it from request handlers.

### 2. Switch every edge function to per-request CORS

Replace this pattern:
```ts
import { corsHeaders } from "../_shared/cors.ts";
if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
return new Response(JSON.stringify(x), { headers: { ...corsHeaders, "Content-Type": "application/json" }});
```

with:
```ts
import { makeCorsHeaders } from "../_shared/cors.ts";
const cors = makeCorsHeaders(req);
if (req.method === "OPTIONS") return new Response(null, { headers: cors });
return new Response(JSON.stringify(x), { headers: { ...cors, "Content-Type": "application/json" }});
```

Functions to update (all currently importing the static `corsHeaders`):
- katrina, copilot-chat, signal-engine, signal-decide, signal-explain
- daily-brief, market-brief, market-intelligence
- doctrine-impact, update-doctrine, activate-doctrine-changes
- propose-experiment, run-experiment, evaluate-candidate
- jessica, journal-explain, post-trade-learn
- mark-to-market, position-reconcile, rollover-day
- broker-connection, broker-execute, trade-close

### 3. Set `ALLOWED_ORIGINS` to cover preview + published + local

```
https://capital-calm-ai.lovable.app,https://*.lovableproject.com,https://*.lovable.app,http://localhost:8080
```

Step 1 makes the wildcards work, so future preview URLs won't break this again.

### 4. Verify

- Deploy the updated functions.
- From the preview tab, click **Run new review** in Taylor's Strategy Brief. Should succeed and write a new `strategy_reviews` row.
- Spot-check one or two other functions (`copilot-chat`, `signal-engine`) from preview to confirm no regression.
- Tail Katrina edge logs to confirm the function actually executed end-to-end.

## Out of scope

- The `AlertDialogContent` / `Function components cannot be given refs` warnings are pre-existing shadcn/Radix dev warnings, unrelated to CORS. Happy to do a separate pass to clean those up if you want.

Approve and I'll switch to build mode and ship it.
