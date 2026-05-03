# Diamond-Tier Edge Plan — From Plumbing to Profit

## Why this plan exists

Recent work hardened the **doctrine, safety, and plumbing**. The numbers say plumbing isn't the problem anymore:

- $9.97 equity from $10 over 11 days. 4 trades total, all `long`, 3 losses + 1 win.
- 24 copilot memory rows, **100% labeled `noise`**. Every learning attempt has been statistically inconclusive.
- Engine has correctly sat for 11 days because all 3 symbols are in `range` regime (setup scores 0.23–0.25 vs ~0.55 floor).
- Only **1 approved strategy** (`trend-rev v1.3`), symbol-agnostic, long-only. Sharpe 0.054, expectancy 0.043 — barely positive on 3 trades.
- 0 active doctrine windows, 0 symbol overrides, 0 queued experiments, 1 stale candidate.
- Bobby's last tick: "coinbase_unreachable — sitting."

The system is a Ferrari with no fuel. This plan adds fuel: **multiple strategies, regime-aware routing, a real learning loop, and short-side capability**, while keeping all the safety we shipped.

## Design principles

1. **Edge before scale.** Don't ask for more capital — earn it from $10.
2. **Multiple uncorrelated edges, not one big one.** A portfolio of small edges beats one fragile one.
3. **The learning loop must actually learn.** 100% `noise` outcomes means our experiment design is broken, not the market.
4. **Capital preservation is non-negotiable.** Diamond tier ≠ aggressive. Every change ships behind doctrine guardrails.
5. **Observability over cleverness.** If we can't explain why a trade fired, we don't take it.

## The 6 pillars

```text
┌────────────────────────────────────────────────────────────┐
│  1. STRATEGY PORTFOLIO   →   3 edges instead of 1          │
│  2. REGIME ROUTER        →   right edge for the moment     │
│  3. SHORT-SIDE UNLOCK    →   cut the long-only handicap    │
│  4. LEARNING LOOP V2     →   experiments that conclude     │
│  5. EXECUTION QUALITY    →   slippage, fees, fills         │
│  6. RISK BUDGET ENGINE   →   Kelly-lite per-strategy       │
└────────────────────────────────────────────────────────────┘
```

---

### Pillar 1 — Strategy portfolio (replace single `trend-rev`)

Ship 3 edges, each with a clear thesis, regime affinity, and kill criteria:

| Strategy | Thesis | Regime | Side | Hold |
|---|---|---|---|---|
| `trend-pullback v2` | Buy/sell pullbacks in established trends | `trending_up` / `trending_down` | both | swing (2-12h) |
| `range-fade v1` | Fade tested boundaries inside well-defined ranges | `range` | both | scalp (15-60m) |
| `breakout-confirm v1` | Buy/sell post-confirmation breakouts of 4h ranges | `transitioning` | both | swing (4-24h) |

This means the system **always has a candidate strategy** for whatever regime BTC/ETH/SOL is in. Today's stuck-in-range problem — when we have a `range-fade` strategy — becomes the strategy's *home turf*, not its enemy.

**Implementation**:
- New table `strategy_definitions` (or just rows in existing `strategies` with `regime_affinity` text and `side_capability`).
- Each strategy gets its own `signal-engine` evaluator function exported from `_shared/strategies/`.
- Backtest each on 90 days of BTC/ETH/SOL 1h candles before going live.
- Promotion gate: minimum 25 backtest trades, Sharpe ≥ 0.7, max drawdown ≤ 5%.

### Pillar 2 — Regime router

Today: `signal-engine` checks one strategy against the current regime and skips if mismatched. Tomorrow: it asks the regime router *which strategy is currently active for this symbol*.

**Logic**:
```text
for each symbol in [BTC, ETH, SOL]:
  regime = classify(symbol)            // existing regime.ts
  candidates = strategies.filter(s => s.regime_affinity.includes(regime) && s.status='approved')
  if candidates.empty: skip with reason ROUTER_NO_FIT
  best = candidates.max(s => s.recent_sharpe * regime_match_strength(s, regime))
  signal = best.evaluate(symbol, candles, intel)
```

**Why it matters**: turns "no signal because trend-rev hates range" into "fired range-fade because it's the right tool." The engine produces *more* signals without lowering quality bars.

### Pillar 3 — Short-side unlock

Right now every trade has been `long`. Coinbase Advanced supports short via perpetuals on supported pairs. Two options:

- **A. Spot-only synthetic short** (cash-out + re-buy lower). Simple, no margin, but capital-inefficient. Good for $10 paper account today.
- **B. Real perp shorts** when broker supports it. Higher edge, requires margin handling.

**Plan**: ship A now (zero broker change), wire B as a feature flag for when real money is at stake. Each strategy declares `side_capability: ['long','short']`. The router doesn't filter sides — strategies do.

### Pillar 4 — Learning loop v2 — make experiments actually conclude

The smoking gun: **24/24 memory rows = `noise`**. Root causes:

1. Experiments run on too few candles (current default ≈ 200 hours = 8 days).
2. Single backtest run, no Monte Carlo or bootstrap confidence intervals.
3. Threshold for "win" probably set at +0.5σ improvement — far below noise floor on small samples.
4. No multi-arm bandit — we always test one knob at a time, ignoring interactions.

**Fixes**:
- Increase backtest window to 90 days (~2160 hourly candles) and require 30+ trades for a verdict.
- Bootstrap-resample 200x for each before/after to compute confidence interval on Δ-expectancy.
- Verdict = `accepted` only if Δ-expectancy 95% CI excludes zero AND |Δ| > one standard error.
- Add `tournament` mode: take top-3 candidate parameter sets and walk-forward test them in parallel before promoting.
- Replace single-knob proposals with **factorial designs** (e.g., test ema_fast × stop_atr_mult on a 3×3 grid).

### Pillar 5 — Execution quality

We've ignored fees and slippage on a $10 account where they're *50% of the trade math*. At ~$0.40/round-trip on Coinbase Advanced (taker), a 3% win on a $1 position = $0.03 gross, **−$0.40 net**. We were trading at a guaranteed loss before edge.

**Fixes**:
- Use **maker-only limit orders** at the proposed entry, with 90s TTL → cancel if unfilled (no chasing).
- Add `min_edge_after_costs` gate: reject signals where `expected_pnl_pct < 2 × (fee_pct + estimated_slippage_pct)`.
- Track realized vs proposed entry slippage in `trades.notes` and feed back into copilot memory.
- Bump minimum order size so fees < 5% of expected PnL (likely $5+ per trade until equity grows).

### Pillar 6 — Risk budget — Kelly-lite per strategy

Currently every strategy shares the same `risk_per_trade_pct = 0.01`. Diamond-tier: each strategy gets its own risk weight, computed from its rolling Sharpe and capped by doctrine:

```text
weight_i = clamp(rolling_sharpe_i / sum(rolling_sharpe), 0.1, 0.5)
risk_per_trade_i = doctrine.risk_per_trade_pct * weight_i * confidence
```

Effect: a strategy that's working gets more capital; one in drawdown gets throttled automatically — without touching doctrine.

---

## Cross-cutting upgrades

### Observability (so we can tell what's working)
- New page `/edge` showing per-strategy: rolling 30-trade Sharpe, expectancy, regime fit, current weight, last-50 trades equity curve.
- New view `strategy_performance_v` aggregating from `trades` for fast read.
- Per-symbol heatmap of regime × strategy pnl over last 90 days.

### Feedback into Brain Trust
- Pipe last 30 closed trades into Katrina's review prompt with their regime/strategy tags so she stops saying "sample too small" and starts saying "trend-pullback in BTC trending_up has 0.62 expectancy on 18 trades."

### Watchdog hygiene
- Clear stale `system_state.pause_reason` whenever `trading_paused_until` is in the past AND Brain Trust is healthy.
- Add `coinbase-probe` watchdog that distinguishes Coinbase API outage from our auth failure (current Bobby tick failed with "coinbase_unreachable" — was it really? or our key issue?).

### Doctrine wiring (use what we built)
- Seed 2 default `doctrine_windows`: `low_vol_overnight` (00–06 UTC, mode=`calm`) and `us_open_volatility` (13–15 UTC, mode=`active`).
- Seed `doctrine_symbol_overrides` for SOL with tighter `risk_per_trade_pct` (more volatile).

---

## Phased rollout

```text
Phase 1 (this sprint) — UNBLOCK + INSTRUMENT
  • Clear stale pause_reason, stale agent_health, fix coinbase-probe.
  • Ship per-strategy weight column + Kelly-lite risk math (Pillar 6 lite).
  • Ship min_edge_after_costs gate (Pillar 5).
  • Add /edge dashboard (read-only).
  • Re-run Taylor with last-30-trades context (now CORS works).

Phase 2 — PORTFOLIO
  • Ship range-fade v1 + breakout-confirm v1 strategies.
  • Ship regime router in signal-engine.
  • Backtest each on 90d, gate on 25 trades + Sharpe 0.7 before approval.
  • Seed doctrine_windows + SOL symbol override.

Phase 3 — LEARN PROPERLY
  • 90-day backtest window for experiments.
  • Bootstrap CI verdict logic (Pillar 4).
  • Factorial design proposer (replace single-knob).
  • Tournament walk-forward before promotion.

Phase 4 — SHORTS + REAL EDGE
  • Spot synthetic short side for all strategies.
  • Trade live with Phase 2 portfolio + Phase 3 learning loop active.
  • If broker supports perps, gate real shorts behind feature flag + explicit ack.
```

## Acceptance criteria for "diamond tier"

- ≥3 approved strategies, each with documented regime affinity and >25 backtest trades.
- Engine fires ≥1 signal per day on average across the 3-symbol universe (vs 0/day today).
- Copilot memory shows ≥30% non-`noise` outcomes within 2 weeks of Pillar 4 ship.
- Per-trade math always has positive expected value after fees+slippage (gate enforced).
- Equity curve over a 30-day window shows positive Sharpe ≥ 0.5 on at least one strategy.
- Every signal has a human-readable explanation ("range-fade @ BTC support, regime=range, conf=0.71, weight=0.35, expected_after_costs=+0.8%").
- No regression in safety: max drawdown ≤ doctrine `daily_loss_pct`, kill-switch reachable in <2s, every doctrine change still goes through `pending_doctrine_changes`.

## Out of scope (be honest)

- ML / RL models. We have ≤4 trades. ML on this dataset is astrology.
- New asset classes (equities, FX). Stay on BTC/ETH/SOL until edge is proven.
- Custom indicators beyond what `regime.ts` already exposes. Use price action, ATR, volume, support/resistance — nothing exotic.
- Sentiment trading. We have macro context from Brain Trust; that's the right altitude for sentiment.

## What I need from you

Approve Phase 1 to start. I'll come back with the Phase 2 strategy specs (range-fade and breakout-confirm) for separate approval before implementing them — those deserve their own design review since they'll be live-trading your money.
