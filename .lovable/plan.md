## Brain Trust audit — findings

The Brain Trust (Hall / Dollar Bill / Mafee in `market-intelligence`) is silently skipping every symbol on every cron tick. Logs show, on a tight loop:

```
No candles for BTC-USD; skipping AI experts.
No candles for ETH-USD; skipping AI experts.
No candles for SOL-USD; skipping AI experts.
```

This means **no expert ever runs**, so `market_intelligence` rows never refresh. Trade decisions downstream that read this row are getting stale or null intel — which is part of why Bobby/Wags say the desk feels blind.

### Root cause

`supabase/functions/market-intelligence/index.ts` has its **own private** `fetchCoinbaseCandles` (lines 611–622):

```text
fetch(`${CB}/products/${symbol}/candles?granularity=…`)
  → if !ok throw
  → no retry, no User-Agent, no backoff
```

It is then called for 3 granularities in parallel via `Promise.allSettled` (line 643). When any one throws (Coinbase intermittently returns 429 or 5xx to edge-runtime IPs, especially when 6 parallel requests fire), `allSettled` swallows the rejection. We log only the generic "No candles" line — the actual HTTP status / error message is lost.

The rest of the codebase (signal-engine, mark-to-market) uses `_shared/market.ts → fetchCandles()` which already has:
- exponential backoff (1s / 2s) on 429 + 5xx
- proper error surfacing
- health tracking via `MarketFetchTracker`

`market-intelligence` is the only consumer that bypasses it, and it's the only one failing.

### Secondary observations

- Cron fires every ~1 minute (logs show ~60s cadence), but Brain Trust is documented as a 4-hour cadence. Even when candles work, we'd be calling Lovable AI 9× per minute. That's wasteful and may be causing rate-limit pressure on the AI gateway too.
- `news_flags` / funding / Fear&Greed are best-effort — fine as-is.
- `EXPERT_MODEL = google/gemini-2.5-flash` — fine, available in our gateway.

## Plan

### 1. Replace the local Coinbase fetcher with the shared one

In `supabase/functions/market-intelligence/index.ts`:

- Import `fetchCandles` from `../_shared/market.ts`.
- Delete the local `fetchCoinbaseCandles` function and the local `CB` constant.
- Adapt the call sites to the `Candle` shape returned by the shared fetcher (`{t,o,h,l,c,v}`) — update `runMacroStrategist` / `runPatternSpecialist` accordingly, since they currently index raw arrays (`c[0]`, `c[2]`, etc.).
- For the 6h granularity (21600s) the shared fetcher accepts it directly.

This buys us retries, correct error surfacing, and consistent health tracking.

### 2. Surface the real failure reason

Replace the swallowed `Promise.allSettled` block with explicit per-fetch handling so the log line becomes, e.g.:

```text
[brain-trust] BTC-USD candle fetch failed (6h): HTTP 429 — skipping experts
```

Keep using `Promise.allSettled` for parallelism, but inspect each rejection and log the `.reason.message`. Still skip the symbol if either 6h or 1d is empty, but at least we know *why*.

### 3. Throttle the cron schedule

Brain Trust narrative is meant to be a 4h cadence. Add a short-circuit at the top of `runIntelligenceForSymbol` for the cron path:

- Look up `market_intelligence.generated_at` for `(user_id, symbol)`.
- If `now() - generated_at < 4 hours`, log "fresh, skip" and return without calling the AI or Coinbase.

On-demand calls (signed-in user hitting "Refresh") still bypass this freshness check. This both saves cost and avoids hammering Coinbase.

### 4. Verify

- `supabase--curl_edge_functions` POST to `/market-intelligence` with cron token → expect at least one symbol with `ok: true` and a non-null `candle_count_4h` in the database.
- Tail `edge-function-logs-market-intelligence` → no more "No candles" lines on the next cron cycle (or, if Coinbase truly is failing, we now see the HTTP code).
- `select symbol, generated_at, candle_count_4h, candle_count_1d from market_intelligence order by generated_at desc limit 10;` → rows refreshing per symbol.

### Out of scope (note for follow-up)

- Tuning the Brain Trust cron interval in `supabase/config.toml` if cron is currently set tighter than 4h.
- Renaming the local field-index assumptions in the AI prompts (already covered in step 1).

Approve and I'll implement all four steps and verify against the live function.
