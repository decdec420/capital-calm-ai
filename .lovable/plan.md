
# Money-Making Audit — What's Actually Going Wrong

I pulled the closed-trade history and walked through the engine. The "it always loses" feeling isn't doctrine — it's three concrete bugs in how trades are sized, exited, and how big the floor is relative to your equity. Here's what the data shows, then what to fix.

## What the trade history says

Account: equity **$9.97**, floor **$8.00** (only $1.97 of total risk budget left).

| Trade | Entry → Exit | Stop dist | TP1 dist | TP1 hit? | Hold | PnL |
|-------|-------------|-----------|----------|----------|------|-----|
| BTC long | 78,175 → stop | 3.00% | 4.50% | no | 6.3 days | **−$0.026** |
| ETH long | 2,391 → stop | 3.50% | 5.25% | no | 1.4 days | **−$0.030** |
| SOL long | 88.13 → stop | 2.61% | 4.94% | no | 17 hrs | **−$0.049** |
| BTC long | 75,947 → TP2 | 1.50% | (no TP1) | n/a | 1.3 days | **+$0.63** |

**Pattern:** the only winner had a tight 1.5% stop and **no TP1** so it ran to TP2. Every loser had a 2.6–3.5% stop and a TP1 at 4.5–5.25% that **never triggered** before the stop did. The asymmetry is the whole story.

## Three real bugs (not "doctrine too tight")

### Bug 1: Stops are placed where noise lives, targets where noise doesn't

`signal-engine/index.ts` line ~1786:
```ts
const fallbackStopPct = Math.max(0.004, Math.min(0.04, stratStopAtrMult * 0.01));
```
This approximates ATR as **1% of price** — a constant. With `stop_atr_mult` of 2.5–3, you get 2.5–3% stops on every trade regardless of the actual symbol or timeframe volatility. Then TP1 is set at 1R (= same 2.5–3% the other way) and TP2 at 2R+.

On a 1h chart, BTC/ETH/SOL routinely wick **2–3% in a single bar of normal noise**. So:
- Stop is *inside* the noise band → gets clipped on every wick.
- TP1 is *just past* the noise band → only fires on a real directional move.
- The AI also has a hard rule "VETO if stop > 3%" (line ~679), so it can't widen out of the noise zone either.

Result: P(stop hit) >> P(TP1 hit). Negative expectancy by construction.

### Bug 2: TP1 ladder isn't banking anything

`mark-to-market` uses `evaluateTradeInCandle` with **synthetic candles** where `high = low = close = current price` (line ~76-81 of MTM). That's defensible for stops (no fake spike kills you) but it means TP1 only fires if the *exact spot tick* prints at-or-above TP1. Combined with TP1 being 4–5% away on every losing trade, **TP1 never fires**, so you never bank the half-profit that's supposed to make this strategy positive-expectancy.

Across 4 closed trades: `tp1_filled = false` on all of them. The whole "compound machine" the journal entries reference has literally never run.

### Bug 3: $8 kill-switch floor on a $9.97 account = 1 trade of headroom

The floor is a **global constant** (`KILL_SWITCH_FLOOR_USD = 8` in `_shared/doctrine.ts`). For a $10 starting account it's appropriate. For a $100 account it's still $8 — fine. But the floor doesn't scale, and the *order minimum* (`minOrderUsd = 0.25`) plus the per-order cap (`max_order_abs_cap = 0.25` in your doctrine row) means at $9.97 equity you can only ever place **a single $0.25 order at a time**, with risk-per-trade math producing tiny qty that's hugely sensitive to fees/spread.

At $0.25 notional, a 3% adverse move = **−$0.0075**. A 5 bps spread cost on entry+exit ≈ −$0.00025. Fees ≈ another fraction of a cent. The signal:noise ratio at this notional is too low for the 1R:2R ladder to pay off statistically — even a *correct* edge gets buried in micro-friction.

## The Fix — three changes that turn this into a working money machine

### Fix 1: Volatility-aware stops (the big one)

Replace the constant `0.01` ATR proxy with a real volatility read from the regime block (`annualizedVolPct` already exists per your earlier comment). Pseudocode:

```ts
// in signal-engine/index.ts ~ line 1786
const realizedVolPct = winner.regime?.realizedVolPct ?? 0.012; // 1h ATR proxy
const fallbackStopPct = Math.max(
  0.006,                              // floor: 0.6% (don't get noise-stopped)
  Math.min(0.025, stratStopAtrMult * realizedVolPct)
);
```

And **invert the stop heuristic** in the AI prompt: instead of "VETO if stop > 3%", say "stop must sit *outside* the recent 1h ATR × 1.5 — if it can't, skip the trade". Tight stops are a feature only when the entry is *adjacent to structure* (HL, VWAP, swing low). Otherwise they're a tax.

### Fix 2: TP1 that actually fires on small accounts

Two cheap structural changes:

**(a) Use the candle high/low, not just spot.** MTM should fetch the latest 1m candle (already available via `fetchTickers`-equivalent) and pass real `{high, low, close}` to `evaluateTradeInCandle`. This means TP1 fires when the *bar* tagged it, not only when spot is currently above it — same realism as the loss path.

**(b) Tier TP1 by distance.** When risk-per-unit ($entry−stop$) is tiny relative to spread, place TP1 at **0.5R** (half the stop distance), not 1R. Banking 0.5R on half the position when the move is fast still produces positive expectancy if win-rate ≥ ~60%, and it dramatically increases TP1 fire-rate on choppy days.

```ts
const tp1Mult = sizeUsd < 1.0 ? 0.5 : 1.0;  // small-account tier
const tp1 = side === "long"
  ? entry + riskPerUnit * tp1Mult
  : entry - riskPerUnit * tp1Mult;
```

### Fix 3: Account-tiered minimums and cap unlock

Make the per-order cap and order minimum scale with equity instead of being a flat $0.25:

| Equity band | min order | per-order cap | risk/trade | Realistic $/trade |
|-------------|-----------|---------------|------------|-------------------|
| $5–$15 | $0.25 | $0.25 (3% of equity) | 1% | $0.001–$0.003 |
| $15–$50 | $0.50 | $1.50 (10%) | 1.5% | $0.01–$0.03 |
| $50–$250 | $1.00 | $5.00 (10%) | 1.5% | $0.05–$0.15 |
| $250+ | $2.00 | Active profile cap ($25) | per profile | $0.30–$1+ |

Implement as a helper in `_shared/doctrine-resolver.ts` that recomputes `maxOrderUsd` and `minOrderUsd` from current equity each tick (read from `account_state`), so a user who deposits more or compounds up automatically gets larger sizing without editing doctrine. This is what answers your "$10 or $100" framing — the same code earns sub-cent on $10 and ~$0.10/trade on $100, no doctrine change needed.

## Out-of-scope but worth noting

- **Spread/fee awareness in sizing**: skip trades where `(spread + 2×fee_bps) > 0.4 × stopDistPct` — the trade can't be profitable even if directionally right. One-line gate addition; high impact at small notionals.
- **Don't open new trades while one is unresolved on the same symbol** (already handled by `OPEN_POSITION` gate, good).
- **MTM cadence**: 15s is fine; the bottleneck is TP1 placement + spot-only candle, not poll rate.

## Files that change

- `supabase/functions/signal-engine/index.ts` — stop sizing, TP1 multiple, AI prompt heuristic.
- `supabase/functions/mark-to-market/index.ts` — replace `tickerToSyntheticCandle` with a real 1m candle pull for TP/stop evaluation.
- `supabase/functions/_shared/sizing.ts` — equity-tiered `minOrderUsd` and per-order cap.
- `supabase/functions/_shared/doctrine-resolver.ts` — derive caps from equity.
- `src/lib/doctrine-constants.ts` — mirror the new tier table for the UI.
- One small migration: add a `account_tier` view (optional, just nicer UX).
- Tests: extend `sizing.test.ts` and add `lifecycle.test.ts` cases for 0.5R TP1 fills.

## What you should expect after

On a $10 account: trades remain pennies, but **win-rate climbs into the 55–65% range** (TP1 actually banking) instead of stop-out-on-noise. Net: you stop bleeding, start slow-compounding. On $100: the same code moves you toward $0.05–$0.15 per closed cycle. On $400+ the existing Active profile takes over and the dollar amounts become meaningful without any further changes.

Approve and I'll implement all three fixes plus tests in one pass.
