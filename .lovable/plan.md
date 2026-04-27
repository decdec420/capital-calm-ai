# Strategy Lab — Calmer Promotions + Friendlier UI

Two things at once: stop the bot from flipping strategies on weak evidence, and make the page readable without a finance degree.

---

## Part 1 — Stop the bot from constantly shifting

The current auto-promotion is too eager: 50 trades, "≥" beats anything, no cooldown. We tighten it on three axes so promotions become rare and meaningful.

### Changes to `evaluate-candidate` (the cron job)

- **Raise the trade bar from 50 → 100.** Doubles statistical confidence. The "Promotion progress" bar in the UI updates to match (`100 / 100 paper trades`).
- **Require a real margin, not just "better".** Today `cExp >= aExp` passes if the candidate is 0.001R better. New rule: candidate must beat live by **≥0.05R expectancy AND ≥3pp win rate** (same threshold the Learning evaluator already uses). Drawdown still can't be more than 10pp worse. Sharpe still must be ≥ live.
- **7-day cooldown after any promotion.** Once a strategy is auto-promoted, the next auto-promotion is locked for 7 days. Forces real-world validation before the next swap. (You can still force-promote manually from the menu — the cooldown only blocks the cron.)
- **Soft-confirm window (optional, off by default).** When a candidate passes, instead of swapping immediately, write a "ready to promote in 24h — reply to veto" alert. If you don't object, the promotion runs the next day. We'll add a toggle for this in Settings; default off so the auto-pilot works out-of-the-box, and you can opt in if you want a sanity check window.

### How often promotions actually happen after this

With paper trading at current pace, a candidate needs roughly **2–4 weeks** to accumulate 100 trades. Then it must clear the higher bar on every metric. Realistic expectation: **0–1 promotions per month**, with most candidates getting retired instead. That's the right tempo — strategies should evolve, not thrash.

---

## Part 2 — Make the page look less like a math textbook

The bones are good, the language is the problem. "trend-rev v1.3+stop_atr_mult=2", "EXPECTANCY 0.04R", "SHARPE 0.05" — true but unfriendly.

### Friendlier names

- **Strategy display name** gets a separate `display_name` field (still keeps the technical `name`/`version` for the engine). Defaults: instead of `trend-rev v1.3` the live card shows something like **"Steady Trender"** with the technical id in small text underneath. We'll seed sensible defaults for existing strategies and let you rename any time from the Edit menu.
- **Candidate names** get auto-generated readable summaries: instead of `trend-rev v1.3+stop_atr_mult=2` it shows **"Wider stops experiment"** with the parameter diff still visible in the "Changes vs live" box below.

### Translate the metrics into English

Keep the precise numbers (you need them) but add one-line plain-English subtitles under each:

- **Expectancy 0.04R** → subtitle "Avg profit per trade"
- **Win rate 67%** → subtitle "How often it wins"
- **Max DD -1.9%** → subtitle "Worst losing streak"
- **Sharpe 0.05** → subtitle "Smoothness of returns"
- **Trades 3** → subtitle "Sample size"

Use a tooltip with a longer explanation for each (we already have the `Explain` component).

### Visual breathing room

- **Plain-English banner replaces the cron line.** "Auto-pilot active · evaluates every 30 min · promotes automatically if it beats the baseline" becomes a single soft-colored line: **"On auto-pilot — checking every 30 min, replaces only after 100 trades and a clear win."**
- **Status badges instead of all-caps eyebrows.** "● LIVE  CURRENTLY TRADING" → just a green pill that says **"Now trading"**. "● IN TESTING  ACCUMULATING PAPER TRADES" → amber pill **"Paper testing"**.
- **Hide the "Changes vs live" box behind a small "see what changed" toggle** — it's reference, not a primary thing to read.
- **Promotion progress bar** gets a friendly label: "On track for review in ~12 days" (computed from trades/day pace) instead of just "47 to go".

### What stays the same

- The actual numbers (expectancy, win rate, etc.) — they're correct and useful, just need context
- The pipeline structure (Live → In Testing → Queue → Archive)
- Scaling readiness checklist
- All the dropdown actions (clone, edit, force promote, retire)

---

## Files touched

- `supabase/functions/evaluate-candidate/index.ts` — new thresholds, cooldown logic
- `supabase/migrations/<new>` — add `display_name` column to `strategies`, `last_auto_promoted_at` to `system_state`, optional `auto_promote_soft_confirm` flag to `system_state`
- `src/pages/StrategyLab.tsx` — Live + In Testing panels: friendlier names, plain-English metric subtitles, calmer banner, cleaner header pills
- `src/components/trader/MetricExplain.tsx` (small new helper) — wraps each metric with subtitle + tooltip
- `src/lib/strategy-naming.ts` (small new helper) — generates "Wider stops experiment" style names from the parameter diff
- `TRADES_TO_PROMOTE` constant: 50 → 100 in both UI and cron
- `src/pages/Settings.tsx` — optional toggle for soft-confirm mode

---

## What you'll see when this ships

The page becomes scannable in 5 seconds without reading any technical text. The live strategy looks like *"Steady Trender — now trading. Avg profit per trade: 0.04R. Wins 67% of the time."* The candidate becomes *"Wider stops experiment — paper testing, on track for review in ~12 days."* The auto-promotion still happens, just with real evidence behind it.
