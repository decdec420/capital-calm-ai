# Clean up code/setup bugs so skips reflect trade quality

Goal: eliminate skips and learning failures caused by **misconfigured code or wrong defaults**, so every remaining skip is a legitimate "this wasn't a good trade" decision. No changes to risk doctrine, kill-switch, or confidence thresholds.

## What's broken right now (evidence from DB)

| # | Issue | Evidence | Category |
|---|---|---|---|
| 1 | Coinbase fee default too pessimistic in `EDGE_BELOW_COSTS` gate | 0.6%/side hardcoded; Coinbase Advanced taker is 0.4–0.6% tier-based; 7 SOL skips in 24h | Bad default |
| 2 | Half-R TP1 for small accounts auto-fails the cost gate | `sizeUsd<$1` → TP1=0.5R, so a 2% stop yields 1% TP1 edge vs 2.8% required | Logic conflict |
| 3 | Bobby directives never reach the trader | 48 expired directives with `target_agent='wags'`, signal-engine queries `('taylor','all')` only | Routing bug |
| 4 | Jessica writes off-topic directives | Current "wags" directives are about data-staleness ops chatter, not trade guidance | Prompt scope |
| 5 | Learning loop can't accumulate samples | 180 sims completed → only INSUFFICIENT_EVIDENCE recs (needs 5/bucket, we only trade SOL) | Threshold too high for current scale |

Yes — Bobby/Wendy/Jessica do learn from these decisions via `decision_memory` → `decision_memory_simulations` → `strategy_learning_recommendations`. The pipeline runs, but #5 means it never produces actionable output at current volume.

## Fixes

### 1. Lower fee default in EDGE_BELOW_COSTS gate
File: `supabase/functions/signal-engine/index.ts` (~line 2835)
- `feePctPerSide`: `0.006` → `0.004` (Coinbase Advanced realistic taker)
- Round-trip cost becomes 1.0% → required TP1 edge becomes **2.0%** (was 2.8%)
- Live mode safety: cap stays at `Math.min(0.012, …)` so observed-cost ceiling unchanged

### 2. Decouple half-R TP1 from cost gate in paper mode
Same file (~line 2858)
- In paper mode only, drop `EDGE_MULT_REQUIRED` from `2.0` → `1.5`
- Live keeps 2.0×
- Rationale: the half-R TP1 (line 2812) was designed for small accounts, but the 2× cost gate cancels it out. 1.5× in paper still requires a profitable expectancy without auto-killing every small-account setup.

### 3. Fix Bobby directive routing
File: `supabase/functions/signal-engine/index.ts` (line 992)
- Change `.in("target_agent", ["taylor", "all"])` → `.in("target_agent", ["taylor", "wags", "all"])`
- Lets Jessica's directives actually reach the trader regardless of which name the LLM picks

### 4. Constrain Jessica's directive scope
File: `supabase/functions/jessica/index.ts` (around line 152, system prompt)
- Add explicit rule: directives must be **trade-decision guidance only** (entry criteria, sizing, regime preference) — not ops/data-health questions
- Add: target must be `"taylor"` or `"all"`, never `"wags"` or other ad-hoc names
- Cleanup: mark current 2 active "all" directives + 7 active "hall" + 18 active "mafee" as expired if older than 6h (one-shot SQL)

### 5. Lower learning-loop sample minimum for paper
File: `supabase/functions/post-trade-learn/index.ts` (search for `minimum 5` / `>= 5`)
- For paper-mode buckets, require **3 samples** instead of 5 to graduate from INSUFFICIENT_EVIDENCE
- Keep 5 for live
- Result: with current ~25 sims/day on SOL, we'll get actionable recommendations within ~24h instead of never

## What this does NOT change
- MIN_CONFIDENCE (0.50)
- max_trades_per_day, risk_per_trade_pct, daily_loss_pct, floor_pct
- Kill switch behavior
- Live-mode guardrails (all stricter values preserved)
- Wags's setup-evaluation prompt (already fixed last turn)

## Expected effect
- Trade frequency: ~0/day → ~10–15/day (Wags fix unblocks confidence skips; #1+#2 unblock cost-gate skips)
- Bobby directives become actionable trader feedback within 1 cycle
- First learning recommendation graduates from INSUFFICIENT_EVIDENCE within 24h
- Remaining skips will be **legitimate**: bad regime, no edge, doctrine cap hit, etc.

## Verification after deploy
1. Query `decision_memory` 30min after deploy → confirm no new `EDGE_BELOW_COSTS` with cost-source=default for SOL setups with >2% stops
2. Query `bobby_directives` where `target_agent IN ('taylor','wags')` and confirm signal-engine snapshot shows them in `directives` array
3. Query `strategy_learning_recommendations` 24h later → confirm at least one `recommendation_type != 'INSUFFICIENT_EVIDENCE'`
