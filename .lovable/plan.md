# Why the Overview shows ~55¢ — and what to actually fix

## The deep dive

I pulled your `account_state` and all 4 trades for user `55ab87c5…0d7d`. The DB is **mathematically correct** — the UI just makes it confusing.

### Your real numbers right now

```text
account_state
  equity              = $10,000.55
  cash                = $10,000.55
  start_of_day_equity = $10,000.00   ← never been reset since 2026-04-20
  balance_floor       = $0.00        ← stomped to zero somewhere
  updated_at          = 2026-04-26 21:50 UTC (fresh, mark-to-market is ticking)

trades (4 total)
  BTC win  +$0.6300   (closed 04-22)
  SOL loss -$0.0493   (closed 04-23)
  ETH loss -$0.0301   (closed 04-23)
  BTC open  -$0.0023 unrealized (since 04-22)
                   ─────────
  realized total =  +$0.5506
  + open unreal  =  -$0.0023
                   ─────────
  net P&L        =  +$0.5483  →  $10,000.5483 ✓ matches equity exactly
```

So mark-to-market **is** running (every ~30s, confirmed in network logs) and equity **is** updating. The "55 cents" is real — it's the sum of one $0.63 win minus two ~$0.04 losses on microscopic position sizes (BTC trade was 0.000011 BTC ≈ $0.86 of exposure on a $10k account).

### What's actually wrong

1. **`start_of_day_equity` is stale (6 days old).** "Daily PnL" is computed as `equity − start_of_day_equity`, so it shows the *cumulative* P&L since 04-20, not today's. That's why it reads "+$0.55, +0.01%" forever instead of resetting at 00:00 UTC.

2. **`balance_floor = $0`.** Probably overwritten by an earlier test or a buggy Welcome flow write. "Floor distance" reads ~100% which is meaningless.

3. **Position sizing is the root cause of "no movement."** With a $10k account, the engine opened trades worth $0.86 (BTC), $0.86 (ETH), $1.89 (SOL). Even a 3% winner only nets $0.03. The Overview is honest — there just isn't much money in motion.

4. **No automated start-of-day rollover job exists.** Nothing resets `start_of_day_equity` at 00:00. It's stuck at the original onboarding value.

### What's NOT wrong
- Mark-to-market scheduling — running every ~30s
- Realtime subscription on `account_state` — `useAccountState` is wired correctly
- Equity computation — math checks out to the cent

---

## Proposed fix (4 surgical changes)

### 1. Shrink the paper account to $10 (one-off)
You want smaller, more readable numbers while we tune the agent. I'll run an `UPDATE` on your `account_state`:

```text
equity              = 10.00
cash                = 10.00
start_of_day_equity = 10.00
balance_floor       =  8.50   (85% floor — same ratio as before)
```

This is a paper account — zero real-money risk. All 4 existing trades stay in history; only the live equity rebases to $10. After this, a 1% winner shows as "+$0.10" instead of "+$0.0023" — much easier to read at a glance and forces the engine to size meaningfully against a small balance.

I'll also nudge `doctrine_settings` so the engine knows the new starting equity:
- `starting_equity_usd = 10`
- `max_order_abs_cap = 5` (so a single order can be up to half the account, not capped at $50 which is meaningless on $10)
- `max_order_pct` left at its current value

**This does not cap what users can choose** — Welcome / Settings still let anyone set whatever equity they want. This is just a one-off reset for your account.

### 2. Add a daily start-of-day rollover (server)
New `supabase/functions/rollover-day/index.ts` that copies current `equity` → `start_of_day_equity` for every user once per UTC day. Schedule via `pg_cron` at `5 0 * * *` (00:05 UTC). Idempotent: only writes if `start_of_day_equity` was set more than 20 hours ago.

### 3. Make the Overview honest about small numbers (client)
In `src/pages/Overview.tsx`:
- Show 4 decimals when `|dailyPnl| < $1` so "+$0.5483" reads instead of "+$0.55"
- Show equity to the cent always; add 4-decimal precision on hover
- Add a tooltip on the Equity card showing `realized today` vs `unrealized` split
- When `start_of_day_equity` was set >24h ago, badge the Daily PnL card with "since {date}" instead of pretending it's today

### 4. Wire the Copilot learning loop (foundation only — non-breaking)
You said the AI must learn from every trade. The plumbing already exists (`journal_entries`, `experiments`, mark-to-market closes trades with outcome+reason_tags). What's missing is **automatic post-trade journaling**. I'll add:

- A trigger on `trades` UPDATE (status: open → closed) that calls a new edge function `post-trade-learn`
- That function reads the closed trade + the originating `trade_signal` (entry reasoning, regime, setup score, confidence) and writes a structured `journal_entries` row of kind `'post_trade'` with: outcome, what worked, what didn't, calibration delta (predicted confidence vs realized outcome)
- It also appends to a per-strategy rolling metric so Strategy Lab can show "since last 20 trades: win rate, expectancy, calibration error" — which feeds your existing experiment proposal flow

This gives you the foundation: **every trade produces a learning artifact**, and the experiments page already knows how to act on patterns. We can layer smarter analysis later (LLM weekly review of the journal, candidate auto-propose, etc.) without rewiring anything.

I will **not** auto-promote anything — humans (or your existing approval flow) decide. We're building memory + signal, not autonomy.

---

## Files to touch

- `supabase/functions/rollover-day/index.ts` — new edge function
- `supabase/functions/post-trade-learn/index.ts` — new edge function
- DB migration — pg_cron schedule for rollover; trigger on `trades` for post-trade journal
- One-off `UPDATE` on `account_state` + `doctrine_settings` for your user (paper rebase to $10)
- `src/pages/Overview.tsx` — formatting, tooltip, stale-day badge
- `src/hooks/useAccountState.ts` — expose `realizedToday` / `unrealizedTotal` derived values
- `src/pages/StrategyLab.tsx` — surface the rolling per-strategy metrics from journal entries (read-only)

## What this changes for you immediately

- Equity shows $10.00 instead of $10,000.55 — moves are visible
- Tomorrow morning, "Daily PnL" actually resets
- "Floor distance" stops showing nonsense
- Every closed trade automatically writes a learning entry the Copilot can read
- No change to your trading logic or sizing percentages — just the dollar base
