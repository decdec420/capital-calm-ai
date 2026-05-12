# Get more trades firing — without changing the safety model

## The honest summary

The guardrails are not blocking anything. Wags (the AI trader) is being more cautious than the rules require — it's inventing extra strictness around 15-minute price action and "wait for the perfect support touch" that isn't part of the documented skip criteria. The fix is two small prompt edits plus a one-time cleanup of stale standing orders. No doctrine changes, no threshold changes, no behavioral overhaul.

## Three small changes

### 1. Stop Wags from over-indexing on 15-minute noise (prompt edit)

In `supabase/functions/signal-engine/index.ts` around line 585 (the SKIP CRITERIA block), add one explicit clarification:

> **15-minute timeframe is for entry timing, not direction. Do not skip a setup because the 15m is briefly counter to the 4h/1h. 15m chop inside an aligned higher-timeframe trend is normal — fade it if anything, do not let it veto the trade.**

This is the line that maps directly to the skip reasons we're actually seeing. Wags will still skip when 4h/1h disagree (the documented criterion), but won't keep skipping clean trending setups because 15m wiggled down for 20 minutes.

### 2. Soften the "perfect entry or skip" framing on key levels (prompt edit)

Same file, around line 583. Current language tells Wags: *"A long in open space = wide stops, undefined risk. Prefer the former strongly."* That's good guidance, but in practice it's reading as "only buy within $0.50 of support." Add one clarifying sentence:

> **"Open space" means no support visible for more than 1 ATR below entry. Being mid-range with support 1-2% away is still acceptable risk — set the stop just under that support and size accordingly. Do not wait for an exact touch that may never come.**

This nudges Wags from "snipe the exact support level" back to "trade with defined risk near support."

### 3. Clear stale Bobby standing orders (one-time)

There are 10+ active Bobby directives, several of which are months-old "reconcile conflicting intel" or "ETH broken support" notes that have long since been superseded. They're still being injected into Wags's prompt as "STANDING ORDERS FROM BOBBY" with `[URGENT]` tags, and they bias toward skipping. Move all active directives older than 24 hours and not tied to an open trade into `status = 'expired'`.

This is data-only (UPDATE on `bobby_directives`), reversible, and doesn't change any code.

## What this is NOT

- **Not lowering MIN_CONFIDENCE.** Already irrelevant — Wags produces 0.75 against a 0.50 bar.
- **Not raising max trades per day.** Already at 15, currently firing 0.
- **Not weakening any doctrine setting** (`risk_per_trade_pct`, `daily_loss_pct`, `max_order_pct`, stop placement rules, etc.) — those stay exactly as they are.
- **Not overriding the AI's judgement.** Wags can still skip; we're just removing two specific over-strict heuristics that aren't in the spec.
- **Not changing the safety prompt for live mode.** The live-mode block ("hesitation on clear setups is its own form of failure") already says the right thing; the issue is in the shared skip-criteria block above it.

## Expected effect

Based on the last 24h sample where 210/217 skip reasons cited 15m-counter or "not at exact support":
- Estimated trade rate goes from ~0/day → ~3–6/day in paper, matching the ~50% of evaluations that have aligned 4h/1h, setup ≥0.7, and defined support within range.
- Quality stays controlled by the existing setup score and confidence floors, which aren't changing.
- If trade rate overshoots (e.g. >10/day), it's already capped by `max_trades_per_day = 15` and would auto-cool after `consecutive_loss_limit = 4` losses — your existing safety net.

## Technical details

- Two edits to the system prompt string in `supabase/functions/signal-engine/index.ts` (around lines 583 and 585). No new functions, no schema changes, no migration.
- One data update statement to expire stale `bobby_directives`. Reversible.
- No doctrine_settings change. No `MIN_CONFIDENCE` change.

## Rollback

If trade quality drops, revert the two prompt lines and the stale directives stay expired (no harm — they were stale). Total rollback is a single file revert.
