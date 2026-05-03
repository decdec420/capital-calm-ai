## Phase 3 — Statistical honesty (SHIPPED)

Goal: distinguish proven edge from a hot streak before risking real money.

### What shipped

**New views (read-only, RLS via security_invoker):**

- `strategy_performance_ci_v` — every strategy's metrics with 95% confidence intervals:
  - **Win-rate**: Wilson score interval (honest at small N, doesn't break at p=0/p=1)
  - **Expectancy (avg_pnl)**: t-based 95% CI
  - **Sharpe (per trade)**: Lo (2002) standard error
  - **`evidence_status`**: `no_data` / `insufficient_evidence` (<30) / `developing` (<100) / `sufficient`
  - **`edge_verdict`**: `unproven` (n<30) / `positive_edge` (lower bound of expectancy > 0) / `negative_edge` (upper bound < 0) / `inconclusive`

- `strategy_regime_perf_v` — same metrics broken down per (strategy × regime). Catches the "looks great overall, only works in trending_up BTC" trap.

**UI:**

- `/edge` page: new "Statistical honesty" panel between portfolio strip and strategies table. Per-strategy row showing evidence status, win-rate with CI, expectancy with CI, Sharpe with CI, and the honest verdict badge.
- Methodology footnote so we never forget what the numbers mean.

### Why analytical CIs instead of true bootstrap

True bootstrap requires resampling N×B times (B≈1000 reps). Implementable in Postgres but expensive on every page load. The analytical formulas chosen are the standard textbook equivalents:
- Wilson interval converges to bootstrap for proportions
- t-CI converges to bootstrap for means with N≥30
- Lo (2002) is the published asymptotic for Sharpe

If we ever want true bootstrap (e.g., for non-normal PnL distributions), it goes in a periodic edge function that materializes results into a table — not in a view.

### What just shipped (Phase 3 sub-tasks)

- **CI gate in `evaluate-candidate`**: a candidate may pass the point-estimate margins (expectancy / win-rate / DD / Sharpe) and STILL be held back if its `edge_verdict` from `strategy_performance_ci_v` isn't `positive_edge` (paper) or `positive_edge` + `evidence_status='sufficient'` (live). The promotion alert now includes the lower-bound expectancy so the operator sees the honest number, not the headline.
- **CI context in `propose-experiment`**: the copilot now sees the baseline strategy's `edge_verdict`, evidence count, and 95% CIs before proposing a knob change. New `statisticalGuidance` field instructs it to be conservative when the baseline has a proven edge, aggressive when it has a proven negative edge, and exploratory when unproven.
- **`replay-strategy` edge function**: walk-forward replay over realized closed trades. Splits the trade stream into N folds (default 5), computes in-sample vs out-of-sample stats per split, and returns a rolling-window edge curve. Outputs a `stability_score` (fraction of folds where OOS expectancy stays within 1 SE of in-sample) and a verdict: `stable_edge` / `moderate_drift` / `unstable_or_overfit`. Surfaced as a "Replay" button per row on `/edge` (disabled until 30+ closed trades exist).

## Phase 4 — Edge depth (SHIPPED)

Goal: more shots on goal in regimes the baseline can't trade, with cross-symbol awareness so we don't take 3 correlated longs at once.

### What shipped

- **`vwap-revert v1.0`** (candidate, all users): mean-reversion playbook for `range`/`chop` regimes, both directions. Tight stops (1.0× ATR), modest TP (1.2R), risk_weight 0.7. Activates exactly where `trend-rev` sits out.
- **`momentum-burst v1.0`** (candidate, all users): long-only breakout chaser for `breakout`/`trending_up`. Wider stop (2.0× ATR), longer runner (2.8R), risk_weight 0.8.
- **`handle_new_user`** trigger updated so every new account ships with all three playbooks.
- **Backfill** ran for existing users; idempotent so re-runs are safe.

### Engine integration

- **Playbook menu** added to the AI prompt: lists every strategy eligible at the current symbol's regime with a one-line personality so the AI reasons in a style the router can honor. If no playbook fits, the AI is told the signal will be dropped — pushing it to skip rather than propose unroutable trades.
- **Cross-symbol context**: when scanning ETH/SOL, the prompt now includes BTC's current regime + setup score. AI is instructed that crypto beta means "long alt vs trending_down BTC" needs alt-specific edge.
- **Correlation note**: if user already holds an open BTC long, prompts demand confidence ≥ 0.80 + a clear alt-specific reason for any new ETH/SOL long. Soft gate (doesn't override doctrine; raises the bar in reasoning).

### What's intentionally NOT in Phase 4

- Hard correlation cap (separate from doctrine's `max_correlated_positions`). The current soft gate is enough; a hard cap belongs to live-mode hardening (Phase 5/6).
- New regime detector (`vwap-revert` reuses existing range/chop classification). If it underperforms because the classification is too coarse, that becomes a follow-up.

## Phase 5 — Live execution plumbing (SHIPPED)

Goal: stop pretending fees and slippage don't exist. Make every real-money round-trip honestly costed and idempotent under retry.

### What shipped

**Database (`broker_fills` + augmented `trades`):**

- `broker_fills` table: one row per Coinbase fill with `fill_price`, `base_size`, `quote_size`, `fees_usd`, `slippage_pct`, `fill_kind` (entry/tp1/tp2/stop/manual_close). Unique on `(user_id, client_order_id, fill_kind)` so a retry can't double-insert.
- `trades.entry_fees_usd`, `exit_fees_usd`, `entry_slippage_pct`, `effective_pnl`, `partial_fill`, `requested_size` — the cost ledger lives on the trade row so reports/views don't have to JOIN.
- `live_execution_stats_v` view: 30-day rolling avg fee% and slippage% per user, fed back into the cost-aware edge gate.
- `doctrine_settings.prefer_maker_orders` (opt-in, default false) — small accounts stay on market IOC because maker orders won't fill at $1.

**Broker layer (`_shared/broker.ts` + new `_shared/fills.ts`):**

- `BrokerFill` now carries `feesUsd` (`total_fees` from Coinbase) and the raw order payload for the audit table.
- New `recordFill()` helper: writes the audit row, computes signed `slippage_pct` (positive = bad on either side), idempotent via upsert with ignoreDuplicates.
- `effectivePnl()` helper: gross PnL minus both legs of fees. The honest number that goes to the user.
- 6 unit tests covering slippage signs, BUY/SELL asymmetry, null inputs, fee netting.

**Engine call sites:**

- **Entry (`signal-engine`)**: deterministic `clientOrderId = signalRow.id` already existed; now also captures fees, computes entry slippage, detects partial fills (`filledBaseSize < expected × 0.99`), and writes everything into the trade row in the same UPDATE that flips status to `open`.
- **Manual close (`trade-close`)**: switched from `crypto.randomUUID()` to deterministic `${trade.id}-close`. Records the fill, accumulates exit fees, writes `effective_pnl`.
- **TP1/TP2/stop (`mark-to-market`)**: deterministic clientOrderIds (`${trade.id}-tp1`, `-tp2`, `-stop`). Each leg records its fill and accumulates `exit_fees_usd` so the final close knows the round-trip cost.

**Cost-aware edge gate (`signal-engine`):**

- Once a user has ≥10 fills in the rolling 30-day window, the gate replaces its hardcoded 0.6%/0.10% assumption with the user's actual observed cost. Floored at 0.3% fee / 0.05% slip and capped at 1.2% fee / 0.5% slip so one weird fill doesn't freeze trading.
- Gate journal entries now tag `costSource: default | observed` so we can see when the engine starts using real numbers.

### Why this matters

Before Phase 5, a "winning" $0.30 trade on a $1 position was actually a $0.10 loser after Coinbase took its $0.40 in round-trip fees. We were promoting strategies based on a number that didn't exist. Now `pnl` is the gross headline and `effective_pnl` is the truth — and `evaluate-candidate` will pick up the truth automatically because Phase 3's CI views read from `trades.pnl` (the column we should retarget to `effective_pnl` once we have a few real fills to validate the math).

### What's intentionally NOT in Phase 5

- **Maker-only execution path**: doctrine flag landed but the post-only limit code isn't wired yet. On $1 orders maker fills are unreliable; we'll wire the actual post-only path in Phase 6 when the canary cap is also in place.
- **Re-targeting CI views to `effective_pnl`**: deliberate. We let real fills accumulate first so we can sanity-check the bookkeeping against Coinbase reports before swapping the source of truth on the Edge dashboard.

### Roadmap reminder

```text
Phase 3 (honesty) ✓ ──▶
   Phase 4 (vwap-revert, momentum-burst, cross-symbol) ✓ ──▶
      Phase 5 (live plumbing: idempotency, partial fills, fee-aware sizing, fill audit) ✓ ──▶
         ├─▶ Phase 6 (live-readiness ceremony: scorecard, two-step arming, $5 canary, maker-only path, auto-revert tripwires)
         ├─▶ Phase 7 (operator polish: health page, weekly digest, snapshot/restore)
         └─▶ Phase 8 (decay detection + champion/challenger)
```
