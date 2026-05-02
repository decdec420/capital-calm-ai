## Brain Trust — make it feel live

You want Hall, Dollar Bill, and Mafee responsive instead of cached for 4h. Plan below makes the desk feel live every minute while protecting against gateway rate limits and pointless re-runs.

### Refresh model (per 1-min cron tick, per symbol)

| Expert | Cadence | Why |
|---|---|---|
| **Mafee** (pattern + `recent_momentum_1h`/`4h`) | **Every minute** | This is the live tape read. Engine already gates on `recent_momentum_at` freshness. |
| **Dollar Bill** (funding signal + sentiment + news_flags) | **Every 5 min** OR sooner if a new news item appears | Funding rate updates every 8h on Binance, Fear&Greed updates daily — calling Bill every minute is paying Gemini to read the same numbers. |
| **Hall** (macro phase, trend, S/R, narrative) | **Every 15 min** OR sooner if price breaks his stated `nearest_support`/`nearest_resistance` | Wyckoff phase doesn't change in 60 seconds. Event-driven re-run handles real regime shifts. |

External data fetchers also get short caches so we don't spam free APIs:
- Coinbase candles: per-fetch (already retried via `_shared/market.ts`)
- Funding rate: 5 min cache
- Fear & Greed: 30 min cache
- CryptoPanic news: 5 min cache

### Soft staleness gating (signal-engine)

Add to the conviction scoring — don't block trades, just dial down confidence when intel is stale:

```text
mafee_age = now - market_intelligence.recent_momentum_at
if mafee_age > 5 min:  setup_score *= 0.85
if mafee_age > 15 min: setup_score *= 0.65 + log warning
hall_age = now - market_intelligence.generated_at
if hall_age > 60 min:  setup_score *= 0.90
```

This keeps the bot trading during gateway hiccups but forces it to be more selective. A 0.55 setup_score that drops to 0.47 because intel is stale will fail the conviction bar naturally.

### Implementation

**1. `supabase/functions/market-intelligence/index.ts`**
- Replace the single `BRAIN_TRUST_FRESHNESS_MS` with per-expert freshness windows.
- Refactor `runIntelligenceForSymbol` so each expert is gated independently:
  - Read prior row → compute `mafeeAge`, `billAge`, `hallAge`.
  - Always call Mafee (with 1h candles).
  - Call Bill only if `billAge > 5min` OR `news_flags` changed since last run.
  - Call Hall only if `hallAge > 15min` OR current spot crossed prior `nearest_support`/`nearest_resistance`.
  - When an expert is skipped, carry over its previous fields into the upsert so the row stays whole.
- Add module-level memoized fetchers for funding / fear-greed / news with the cache TTLs above.
- Keep `skipFreshness: true` for on-demand UI calls (refresh button always runs all three).

**2. `supabase/functions/signal-engine/index.ts`**
- After loading `market_intelligence`, compute `mafeeAge` and `hallAge`, apply the multiplicative penalties above to `setup_score` before the conviction gate.
- Log the penalty in `gateReasons` so the UI can explain "Setup score reduced 15% — Mafee read 7m old".
- Surface a stale_intel reason in `system_state.last_engine_snapshot.gateReasons` when intel is older than 15min, so the operator can see it on the desk strip.

**3. Cron schedule**
- Confirm `market-intelligence` cron runs every 1 minute (it already does — same token as `signal-engine`). No DB change needed.

**4. Verify**
- `supabase--curl_edge_functions` POST `/market-intelligence` twice within 60s → second call should log "Mafee ran, Bill skipped (cached 12s), Hall skipped (cached 12s)".
- `select symbol, generated_at, recent_momentum_at from market_intelligence` taken 5 min apart → `recent_momentum_at` advances every minute, `generated_at` (Hall stamp) only every 15 min.
- Edge function logs → no 429s from Lovable AI gateway.
- A signal proposed during stale-intel period shows the penalty in `gateReasons`.

### Cost envelope (1 user, 3 symbols)

- Mafee: 3 × 60 = **180 calls/hr** (the "live" feel)
- Bill: 3 × 12 = **36 calls/hr**
- Hall: 3 × 4 = **12 calls/hr** (+ event-driven extras)
- **Total: ~228 AI calls/hr** vs 540 if we ran all three every minute. Same live feel on the part that matters; ~2.4× cheaper; far below any gateway throttle.

### Out of scope (note for later)

- Per-symbol parallelism inside one cron tick (currently sequential). Worth doing if we add a 2nd user.
- Pushing Brain Trust output over Realtime so the UI updates without polling.

Approve and I'll implement, deploy, and verify.
