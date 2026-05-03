## Roadmap to "ready for live money" (paper now, live later)

The destination is real money. Everything between here and there falls into three groups: **prove the edge is real**, **harden the plumbing so live orders don't blow up**, and **build the human controls so flipping the switch is a non-event, not a leap of faith**.

Phase 1 (risk infra) and Phase 2 (multi-strategy edge) are done. Here's what stands between us and arming live.

---

### Phase 3 — Statistical honesty (do this next, no exceptions)

You cannot go live on point-estimate metrics. A strategy with "58% win-rate over 47 trades" could honestly be a 40% strategy on a hot streak. We need to know which is which **before** real money is at risk.

- **Bootstrap confidence intervals on every strategy verdict.** Win-rate, expectancy, Sharpe — all reported as `point [low, high]` 95% CIs. UI flags anything where the CI crosses zero as "not yet proven".
- **Minimum-evidence gate.** Below 30 trades per (strategy × regime), status is "insufficient evidence". No promotion, no live-eligibility, no copilot proposals based on it.
- **Walk-forward replay.** New `replay-strategy` edge function: re-run strategy logic against historical candles for any date range, produce out-of-sample equity curve. This is the single biggest defense against overfitting.
- **Regime-stratified scorecards.** Break every metric down by `(strategy × regime × symbol)`. Catches the "looks great overall, secretly only works in trending_up BTC" trap.
- **Copilot uses CI verdicts.** Doctrine proposals cite `[low, high]`, not the point estimate.

### Phase 4 — Edge depth

Once we can tell signal from noise, safe to add more inputs.

- 2 more strategies: `vwap-revert v1`, `momentum-burst v1`
- Cross-symbol features (BTC dominance, BTC-ETH correlation, total-3 momentum) fed into the AI side-decision
- Real correlation gate enforcing `max_correlated_positions` from a 30d return correlation matrix
- Time-of-day affinity per strategy (soft-pause in known-bad UTC hours)
- Regret tracking — simulate signals NOT taken, surface over-tight gates

### Phase 5 — Live-execution hardening (the bridge)

This is the work the original `LIVE_EXECUTION_SPRINT.md` was pointing at. None of it matters in paper, all of it matters the second we flip live.

- **Maker-only limit orders** with re-quote logic. Eats less spread than market orders → meaningfully better real-world PnL.
- **Idempotent order submission.** Every order gets a deterministic `client_order_id`; retries can't double-fill.
- **Partial-fill reconciliation.** Real fills come in pieces. Position tracking, stop placement, and PnL accounting all need to handle multi-fill orders cleanly.
- **Real fill telemetry.** Track `expected_fill_price` vs `actual_fill_price` per order. After 50 live fills, recalibrate the paper slippage model from the empirical distribution. Without this our paper PnL is a guess.
- **Order-state machine + reconciliation loop.** Periodically pull broker open orders + positions and compare to our DB. Auto-flag drift, auto-cancel orphans.
- **Broker error taxonomy.** Categorize Coinbase errors (rate-limit, insufficient-funds, invalid-product, transient) and route each to the right handler (retry / abort / alert).
- **Fee-aware sizing.** Real Coinbase taker/maker fees baked into expectancy calcs and the cost-aware gate.

### Phase 6 — Live-readiness ceremony (gate to flipping the switch)

Before `live_trading_enabled` flips to true, the system itself enforces a checklist:

- **Live-readiness scorecard** (new page or `/edge` panel). Green/red on:
  - At least one strategy with 95% CI lower bound > 0 on expectancy
  - 60+ paper trading days with no critical incidents
  - Broker connection healthy 99%+ over trailing 14d
  - All agent_health green for 14d
  - Slippage model calibrated against ≥50 real test orders
  - Manual dry-run of kill-switch + reconnect flow within last 7d
- **Two-step arming** (already partially built). Acknowledgment dialog + 24h cooldown + re-confirmation. Don't simplify this.
- **Tiny-size canary period.** First 14 days live, hard cap order size at $5 regardless of doctrine. System literally cannot place a bigger order. Confidence-building, not edge-seeking.
- **Auto-revert tripwires.** Live mode auto-flips back to paper if: 3 consecutive losing days, single-day loss > 2× daily_loss_pct, broker error rate > 5%, or any agent_health failure lasting > 30 min.

### Phase 7 — Operator polish (parallel, low blocking)

- Single "is this thing working?" health page (consolidates /edge + /performance + /risk)
- Weekly digest via Telegram (already have the connector)
- Strategy "what changed" version log with auto/manual/copilot trigger
- Backfill mode for new strategies (90d historical replay before going live-paper)
- Snapshot/restore for doctrine + strategies + risk weights

### Phase 8 — Knowing when to pause (must exist before live)

- **Decay detector.** 30d Sharpe vs lifetime Sharpe per strategy. Drop below 50% for 2 weeks → auto-pause (in live this means real capital is protected the moment edge fades).
- **Regime-shift detector.** Realized vol / trend-strength distribution shift > 2σ from 90d baseline → market-state alert.
- **Champion/challenger.** When a strategy auto-pauses, system spins a re-tuned challenger in shadow for 14d, proposes promotion if it beats the paused version.

---

### Suggested order

```text
Phase 3 (honesty)        ──▶ blocks everything else
   │
   ├─▶ Phase 4 (more edge)         ─┐
   ├─▶ Phase 5 (live plumbing)     ─┼─▶ Phase 6 (readiness ceremony) ──▶ FLIP LIVE (canary)
   └─▶ Phase 8 (decay detection)   ─┘
   
Phase 7 (operator polish) — anytime, parallel
```

**Phase 3 is the real gate.** If we add Phases 4/5/6/7/8 without it, we'll be making decisions with real money based on metrics that look meaningful but aren't.

### Sizing

- Phase 3: 1 build pass (CI view + replay function + UI surfacing)
- Phase 4: 2 build passes
- Phase 5: 3 build passes (this is the heaviest — real broker integration is fiddly)
- Phase 6: 1 build pass (mostly checks + tripwires on top of existing infra)
- Phase 7: 2 build passes
- Phase 8: 1 build pass

Realistic timeline to "armed live with $5 canary cap" at one Phase per session: ~8 build passes. Then 14 days of canary. Then full live.

### What I'd ship next

**Phase 3.** It's the foundation everything else stands on, and it's the one thing that takes "are we actually making money?" from a hopeful guess to an answer with error bars.

Want me to spec Phase 3 in detail and start building, or zoom in on any other phase first?