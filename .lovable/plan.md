# Things you probably aren't thinking to ask — efficiency audit

Three buckets: **money-making**, **codebase/cost**, **trading robustness**. Each item has a quick read on impact (H/M/L) and effort.

---

## A) Money-making efficiency

### A1. Universe is 1 symbol, but we pay for 3 [H impact, L effort]
Last 24h: 227 evaluations, **100% SOL-USD**. BTC and ETH have Brain Trust intel generated every 2m but no signals evaluated against them.
- Why this matters: triples the number of independent setups per day at near-zero added cost. SOL alone has ~25 sims/day → with 3 symbols you'd hit the 3-sample learning threshold in <12 hrs *per regime*.
- Likely cause: signal-engine has a winner-takes-all symbol selector that only picks one. Worth checking whether to evaluate top-2 per tick instead of top-1.

### A2. No real fills → no observed cost data, no rotation, no compounding [H, M]
- `broker_fills` count last 30d = **0**. The whole "observed fee/slippage" branch in `EDGE_BELOW_COSTS` will never activate because we never trade.
- Paper account at $1000, doctrine cap $50/order, risk 1.5%/trade — these are reasonable but if the system never fires, there's no data to learn from. The fixes we just shipped should unblock this, but worth verifying within 24h.

### A3. Strategy mix is monoculture [M, M]
3 strategies seeded (`trend-rev`, `vwap-revert`, `momentum-burst`) but only `trend-rev` is `approved`. The other two are `candidate` — they need promotion to actually pick up trades. Currently every signal routes to one strategy.
- Promotion gate normally requires backtest evidence. Worth asking: are the candidates being evaluated against shadow trades at all, or just sitting?

### A4. Doctrine `max_trades_per_day=6` may cap upside [L, L]
With Wags + cost-gate fixes you're projecting 10–15/day. Cap will bite. Either raise to 12 or make it dynamic with `risk_per_trade_pct`. Keep daily loss cap (2%) as the real safety.

### A5. Maker vs taker [M, M]
`prefer_maker_orders=false`. On Coinbase Advanced, maker fees are roughly half taker. Once you have ≥10 fills, flipping this for setups with patient entries could cut the cost gate's "required edge" by ~30% — i.e., more trades clear.

---

## B) Codebase / cost efficiency

### B1. AI call volume per minute [H, M]
Cron currently runs **every minute or faster**: `jessica-tick`, `signal-engine-tick-aggressive`, `scalp-watcher-5s`, `mark-to-market-15s`, `market-intelligence-2m`, plus `signal-engine-tick-active` every 2m. Each Jessica + signal-engine + brain-trust tick hits Lovable AI Gateway.
- Conservative estimate: ~5–10 LLM calls/min = 7,000–14,000/day even when nothing is happening.
- Action: **add a "quiet mode"** — if no momentum/news in last 15m AND no open positions, downshift to every 5m for Jessica + signal-engine. Saves 60–80% of LLM spend on idle days.

### B2. `system_events` is a write-only landfill [M, L]
**10,627 rows, all `bobby_decision`, oldest 8 days ago.** Growing ~1300/day. No retention policy. At this rate the table will dominate DB size in 3 months.
- Action: cron job that deletes `bobby_decision` events older than 7 days unless they reference an open incident. Same pattern you applied to `bobby_directives`.

### B3. Two overlapping signal-engine crons [L, L]
- `signal-engine-tick-aggressive` every 1m
- `signal-engine-tick-active` every 2m
Both query the same data. If one is meant to be conditional on `active_profile`, the routing should happen *inside* one cron, not by running both. As-is, the every-2m tick is redundant work.

### B4. Edge function count: 31 — consolidation opportunity [L, M]
Some are tiny one-shots that could fold into shared modules: `signal-decide`, `signal-explain`, `signal-engine` all touch the same domain. `journal-explain` + `doctrine-impact` + `replay-strategy` are explanation helpers. Not urgent, but each function is its own cold start.

### B5. Decision-memory replay packets are heavy [L, M]
`decision_memory.replay_packet` is a JSONB blob written on every skip. 227 rows = 704 KB → ~3 KB/row. At 1300 decisions/day that's ~4 MB/day, ~120 MB/month. Consider: store only `meta` summary on `LOW_CONFIDENCE` skips (the common case); keep full packet only on `would_have_*` candidates that actually feed learning.

---

## C) Trading robustness / correctness

### C1. `direction_basis` validator allows `default_long_fallback` [M, ?]
The trigger validates this value as legal — meaning somewhere we're falling back to long when we can't decide direction. That's a known antipattern (always-long bias in choppy markets). Worth checking: how often does this fire, and should it skip instead of defaulting?

### C2. No correlation check between SOL and BTC/ETH [M, M]
`max_correlated_positions=3` exists but with 1-symbol universe it never bites. When you expand to 3 symbols, correlated long positions on a crypto-wide downtrend will compound losses. Verify the correlation calc actually treats BTC/ETH/SOL as correlated (they often move together).

### C3. Consecutive loss + cooldown logic [L, L]
`consecutive_loss_limit=2`, `loss_cooldown_minutes=30`. Very tight. After 2 losses (which a normal day can produce) you're paused 30m. Combined with `max_trades_per_day=6` and the autonomous mode, this is more brittle than it looks. Worth a once-over: should the cooldown scale with size of loss, not just count?

### C4. No regime-change kill [M, M]
Doctrine has daily loss cap but no "regime flipped against me intra-trade" trigger. If you're long during a regime change to `trending_down`, you ride it until SL. A soft-exit on regime flip (close 50% of position, tighten stop) is a common improvement.

### C5. Wendy/Katrina coverage [L, M]
Wendy grades closed trades, Katrina does weekly review (Sundays). With **0 closed trades in 30 days**, neither has run with real data. Once trades fire, monitor whether Katrina's review actually fires on Sunday — easy to miss if the cron path is broken.

### C6. Telegram + notifications [L, L]
`notify_telegram` swallows ALL errors silently (`EXCEPTION WHEN OTHERS THEN NULL`). If TG is down for a day you'd never know. Worth at least logging to `system_events` on failure.

### C7. RLS audit on `decision_memory` [L, L]
Has two SELECT policies (one `public`, one `authenticated`) doing the same thing. Duplicate policies are a maintenance smell and slightly slower. Consolidate.

---

## Top 3 I'd actually do next (in priority order)

1. **Expand the trading universe to BTC + ETH + SOL** (A1). This is the highest-leverage change: 3× the trade frequency, 3× the learning signal, no doctrine change.
2. **Add system_events retention + quiet-mode cron throttle** (B1 + B2). Cuts AI spend ~70% on idle days and stops DB bloat.
3. **Verify regime-change soft-exit + correlation cap** (C2 + C4). Before live mode, these are the two failures that turn a 2% daily loss cap into a 5% loss in practice.

Want me to scope any of these as their own plan?
