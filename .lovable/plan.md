# Multi-test pipeline + clearer auto-pilot + scaling readiness scope

Three small but related issues to fix on the Strategy Lab:

1. The pipeline only allows **one** strategy in testing — you want many running in parallel.
2. The "🤖 Auto-pilot" banner doesn't actually explain what it's evaluating when the queue is bigger.
3. The "🔒 Scaling readiness" panel is account-wide but reads like it might be tied to a specific strategy.

---

## 1. Multiple paper tests at once

**Today:** The hook picks exactly one `inTesting` candidate (the one with the most paper trades). Everyone else is "Queue." The auto-pilot only ever evaluates that single winner.

**Change:**
- Treat **every** `candidate`-status strategy as actively paper-testing in parallel. They all collect trades simultaneously already (trades carry `strategy_id`); we were just hiding them.
- Replace the single "In testing" panel with an **"In testing (N)"** section that lists each candidate as a compact row showing: friendly name, version, trade progress (`X / 100`), key deltas vs live (expectancy, win rate), and per-row actions (Run check now · Edit · Retire · Force promote).
- Drop the "Queue" concept entirely. The current queue panel only existed because there was one slot to fight over. Duplicate detection + "Remove N duplicates" stays — just moves up into the testing list header.
- Keep the empty state for when there are zero candidates.

**Auto-pilot behavior:**
- `evaluate-candidate` already loops candidates per user; just stop picking only the one with the most trades. Evaluate **every** candidate that has ≥100 paper trades. Each one is independently:
  - promoted (if it clearly beats live + we're past the 7-day cooldown), or
  - retired (if it failed the bar), or
  - paused for review (if drawdown blew up), or
  - skipped (not enough trades / cooldown).
- If two candidates both pass on the same run, promote the one with the **largest expectancy margin** vs live. The rest stay candidates and get re-evaluated next cycle (after cooldown).

## 2. Clarify the auto-pilot banner

Replace the current single-line banner with one that adapts to what's actually happening:

> 🤖 **Auto-pilot active** — checking all 4 paper tests every 30 min. Promotes one to live if it clearly beats the current strategy after 100 trades, then waits 7 days before swapping again.

When there's only one candidate it reads naturally too ("checking 1 paper test"). When there are zero, the banner is hidden.

Also add a small inline **"Last check: 14 min ago · next in 16 min"** hint so it's obvious the loop is alive (computed from `system_state.last_auto_promoted_at` for the "last promoted" timestamp + a `last_evaluated_at` we'll add).

## 3. Scaling readiness — what it's tied to

It's currently **account-wide**, not tied to any single strategy — it's measuring "is your overall paper-trading record good enough to start risking real money beyond $1/trade." The labels just don't say so.

Change the panel header copy from `🔒 Scaling readiness 3/6` to:

> 🔒 **Account-wide scaling readiness · 3/6**
> Across **all** your paper trades and strategies — not any one test. All green before raising real-money caps.

And add a one-line tooltip on each item saying which data source it pulls from (e.g. "All closed paper trades, all strategies").

---

## Files to touch

**Frontend**
- `src/hooks/useStrategies.ts` — replace `inTesting` / `queued` with a single `inTestingList: StrategyVersion[]` (sorted by trade progress desc). Keep `duplicateIds` + `removeDuplicates`.
- `src/pages/StrategyLab.tsx` — replace `InTestingPanel` + `QueuePanel` with one `InTestingListPanel` rendering compact rows. Update the auto-pilot banner copy. Re-wire `triggerEvaluate` to summarize multi-result responses ("Promoted v1.4 · 2 still collecting trades · 1 retired").
- `src/components/trader/ScalingReadinessPanel.tsx` — header copy + per-item tooltips.

**Backend**
- `supabase/functions/evaluate-candidate/index.ts` — loop **all** candidates (not just the top-trade one). On a single cron pass, at most one promotion happens (highest expectancy margin wins); others get retired/skipped independently. Return one result per candidate so the UI can summarize.
- Migration: add `last_evaluated_at TIMESTAMPTZ` to `system_state` so the banner can show "last check: N min ago."

## What stays the same

- The 100-trade bar, 0.05R + 3pp margins, drawdown veto, and 7-day cooldown — all unchanged. Parallel testing doesn't loosen the promotion bar.
- "Force promote" on a candidate still requires ≥100 trades.
- The pipeline diagram in your head: **Live (1) → In testing (N) → Archive**. Just N instead of 1.

---

## Technical notes

- No schema change to `strategies` needed — "in testing" is just `status = 'candidate'`. The single-slot illusion was purely UI-side.
- `moveTesting` becomes obsolete (no slot to move into) and gets removed from the hook.
- The cooldown stays per-user (not per-strategy), so back-to-back promotions of two different candidates are still blocked for 7 days. That's intentional — the cooldown protects against thrashing the live engine, regardless of which candidate won.
