## Phase 2 — Multi-Strategy Edge (Live Paper)

Mode stays `paper`. Bot stays `paused` unless you flip it. Nothing in this plan touches `live_trading_enabled`, broker order routing, or the live/paper switch.

### What changes for the user

- The bot stops being a one-trick pony. Today: `trend-rev` only, refuses to trade `range` regimes (which is why all 3 symbols have been silent).
- After Phase 2: 4 approved strategies, each with a regime it's good at. The engine picks the right tool for the current market on each symbol every tick.
- Shorts unlock in paper. Currently every trade is forced long — half the market is invisible to us.

### The 4 strategies after Phase 2

| Strategy | Regime affinity | Sides | Risk weight | What it does |
|---|---|---|---|---|
| `trend-rev v1.3` (existing) | trending_up, trending_down | long | 1.0 | Unchanged. Keeps current behaviour as the baseline. |
| `trend-pullback v2` | trending_up, trending_down | long, short | 0.5 → 1.0 after 30d | Enters on RSI pullbacks within an established trend. Tighter stops, better R:R than v1.3. |
| `range-fade v1` | range | long, short | 0.5 | Fades the edges of a confirmed range. Sells near resistance, buys near support. Hard time-stop if range breaks. |
| `breakout-confirm v1` | breakout | long, short | 0.5 | Enters on confirmed range breaks with volume expansion. Skips the first candle (no chasing). |

All 3 new strategies start at `risk_weight = 0.5` so their position sizes are half of trend-rev's until they earn capital. After 30 paper days with positive expectancy, the auto-promotion path (already in `evaluate-candidate`) can promote them to 1.0.

### The regime router (the brain that picks)

New module `_shared/strategy-router.ts`. Per symbol, per tick:

```text
candidates = strategies
  .filter(s => s.status == 'approved')
  .filter(s => s.regime_affinity.includes(current_regime))
  .filter(s => s.side_capability.includes(desired_side))

if (candidates.empty) → no trade, log reason
if (candidates.length == 1) → use it
else → pick highest recent_sharpe (from strategy_performance_v),
       falling back to highest risk_weight, then alphabetical
```

The signal-engine currently treats every symbol the same and only refuses non-tradeable regimes. After this change `range` becomes tradeable *if* a range strategy exists for it. `TRADEABLE_REGIMES` becomes a union of all approved strategies' `regime_affinity` arrays, computed once per tick.

### Short side unlock (synthetic, paper only)

True shorting on Coinbase spot isn't possible. We do **synthetic shorting**: when a short signal fires and there's an existing long position in that symbol, we sell down (partial or full) and treat the avoided-loss as the short's PnL. When there's no spot to sell, we just log the signal and skip — no fake borrowed selling.

In Phase 2 paper, synthetic shorts simulate as if shorts were real: paper PnL accounts for them. We mark every short trade with `direction_basis = 'engine_chose_short'` and a new `synthetic_short = true` flag in `notes` so we can audit later.

### Rollout — live paper from day one (your choice)

All 3 new strategies fire real paper signals on first deploy with `risk_weight = 0.5`. The cost-aware gate from Phase 1 still applies, so weak signals get filtered. The Kelly-lite sizing means worst case a new strategy uses half the risk budget per trade vs trend-rev.

A safety brake: in the first 14 days, if any new strategy hits 4 consecutive losses, it auto-flips to `status = 'paused'` and posts an alert. You can re-arm or kill from `/edge`.

### `/edge` page additions

- Per-strategy: live status, recent trades, win rate, Sharpe, current risk_weight
- "Pause" / "Resume" / "Kill" buttons (writes to `strategies.status`)
- Regime router transparency: per symbol, "current regime → selected strategy → why"

---

## Technical details

### DB migration

```sql
-- Per-strategy circuit breaker
alter table public.strategies
  add column if not exists consecutive_losses int not null default 0,
  add column if not exists auto_paused_at timestamptz,
  add column if not exists auto_pause_reason text;

-- Status values used: 'candidate', 'approved', 'paused', 'archived'
-- (no enum change needed, they're already text)

-- Synthetic short audit flag on trades
alter table public.trades
  add column if not exists synthetic_short boolean not null default false;

-- Seed the 3 new strategies for the user (status='approved', risk_weight=0.5)
-- Insert via insert tool, not migration.
```

### Files to create

- `supabase/functions/_shared/strategy-router.ts` — pure function: `selectStrategy(regime, side, strategies, performance)` returns `{strategy, reason}` or `{strategy: null, reason}`
- `supabase/functions/_shared/strategy-router.test.ts` — Deno tests covering: no candidates, single candidate, multi-candidate Sharpe tie-break, side mismatch, all-paused
- `supabase/functions/_shared/strategies/trend-pullback-v2.ts` — params + signal-shape helpers
- `supabase/functions/_shared/strategies/range-fade-v1.ts` — params, range-detection helpers (Bollinger-style bounds from regime data), time-stop logic
- `supabase/functions/_shared/strategies/breakout-confirm-v1.ts` — params, volume-confirm helper, anti-chase delay
- `src/pages/Edge.tsx` — extend with per-strategy controls and router transparency panel
- `src/components/edge/StrategyCard.tsx` — pause/resume/kill UI
- `src/components/edge/RouterPanel.tsx` — per-symbol routing decision viewer

### Files to edit

- `supabase/functions/signal-engine/index.ts`:
  - Replace `.eq('status','approved').limit(1)` strategy load with a full approved-strategy fetch
  - After computing regime per symbol, call `selectStrategy()` to pick the strategy for that candidate
  - Replace the static `TRADEABLE_REGIMES` filter with: "tradeable if any approved strategy has affinity"
  - Pass the selected strategy's params (stop_atr_mult, ema, rsi) to `computeRegime` and the AI prompt for that symbol — different strategies see different regime computations
  - Add short-signal handling: if AI returns `side: 'short'`, mark `synthetic_short = true` and proceed via the same paper-fill path
  - On signal/trade close, increment `strategies.consecutive_losses` on loss, reset on win; auto-pause at 4
- `supabase/functions/_shared/reasons.ts` — add `NO_STRATEGY_FOR_REGIME`, `STRATEGY_AUTO_PAUSED`, `SHORT_NO_SPOT_TO_SELL`
- `supabase/functions/_shared/regime.ts` — `TRADEABLE_REGIMES` becomes a function `tradeableRegimesFor(strategies)` instead of a static set
- `supabase/functions/post-trade-learn/index.ts` — update consecutive_losses counter on close; trigger auto-pause + alert at threshold

### Sequencing (single deploy)

1. Migration: add columns to `strategies` and `trades`
2. Insert the 3 new strategy rows for the user with `status='approved'`, `risk_weight=0.5`
3. Ship router + strategy modules + tests
4. Wire signal-engine to use router
5. Extend `/edge` UI
6. Deploy signal-engine and post-trade-learn

### Risks & mitigations I want you aware of

- **More signals = more paper trades.** Expect signal frequency to ~2-3x. Doctrine guardrails (max_trades_per_day=5, daily_loss_pct=0.3%) still cap downside.
- **range-fade is the most dangerous.** Fading extremes works until a range breaks, at which point you're catching a knife. The time-stop (close if range invalidates within N candles) is the seatbelt.
- **Short signals depend on existing spot.** First few weeks, expect most shorts to be `SHORT_NO_SPOT_TO_SELL` — that's correct behaviour, not a bug.
- **Strategy interaction.** Two strategies could fire on the same symbol same tick if regime is ambiguous. Router enforces one-strategy-per-symbol-per-tick by Sharpe ranking.

### What's still NOT included (Phase 3+)

- Real broker shorting (requires margin account, out of scope)
- Bootstrap-CI verdicts in copilot_memory (Phase 3)
- Maker-only limit orders (Phase 3)
- Going live (separate explicit user decision later)

After approval I'll run this in one build pass: migration → seed strategies → router + tests → engine wiring → UI. I'll show you the `/edge` page when it's done.