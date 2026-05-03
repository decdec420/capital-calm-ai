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

### Roadmap reminder

```text
Phase 3 (honesty) ✓ ──▶
   ├─▶ Phase 4 (more edge: vwap-revert, momentum-burst, cross-symbol features, correlation gate)
   ├─▶ Phase 5 (live plumbing: maker-only, idempotency, partial fills, fee-aware sizing)
   ├─▶ Phase 6 (live-readiness ceremony: scorecard, two-step arming, $5 canary cap, auto-revert tripwires)
   ├─▶ Phase 7 (operator polish: health page, weekly digest, snapshot/restore)
   └─▶ Phase 8 (decay detection + champion/challenger)
```
