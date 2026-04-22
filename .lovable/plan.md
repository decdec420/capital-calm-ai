

## Make experiments AI-run, not user-run

Right now Experiments is a glorified spreadsheet — you type the parameter, you compute the delta, you flip the status. The Copilot is silent throughout. Let's flip it so the AI proposes, runs, and reports — the operator just reviews.

### The new model

```text
                    ┌──────────────────────────────────┐
 Copilot tick  ───▶ │ propose-experiment edge function │
 (cron, hourly)     │  · scans recent trades + regime  │
                    │  · picks ONE param to test       │
                    │  · writes row: status=queued     │
                    └─────────────┬────────────────────┘
                                  │
                    ┌─────────────▼──────────────────┐
 run-experiment  ◀──┤ pg_cron picks queued rows      │
 edge function      │  · pulls candles, runs backtest│
                    │  · fills before/after/delta    │
                    │  · status=accepted|rejected    │
                    │  · status=needs_review (close) │
                    └─────────────┬──────────────────┘
                                  │
                    ┌─────────────▼──────────────────┐
 Operator UI    ◀───┤ Copilot weekly digest          │
 (only when         │  · "I tested 4 things this wk" │
  attention needed) │  · 1 needs your call           │
                    └────────────────────────────────┘
```

Three moving parts: a **proposer**, a **runner**, and a **digest** the user sees. The first two are silent.

### What changes for the user

**Learning page becomes a digest, not a workbench.** No "Queue experiment" dialog up top. Instead:

- **Hero card**: *"Copilot is running 3 experiments in the background. 1 needs your review."*
- **"Needs review" lane** (only shown when non-empty) — significant deltas where stats are borderline; user clicks Accept / Reject / Promote-to-strategy.
- **"Recently auto-resolved" lane** — collapsed by default. Clear winners auto-accepted, clear losers auto-rejected. Two-line summary each. Click to expand and see backtest detail.
- **Copilot's reasoning** — every experiment row gets a "Why did Copilot try this?" expander showing the AI's hypothesis, the evidence it pulled from recent trades, and the backtest result.

The **manual "Queue experiment" button moves to a kebab menu** for power users who want to suggest one — but it's no longer the default action.

### What changes under the hood

#### 1. `experiments` table — small additions
```sql
ALTER TABLE experiments
  ADD COLUMN proposed_by text NOT NULL DEFAULT 'user',  -- 'user' | 'copilot'
  ADD COLUMN hypothesis text,                            -- AI's reasoning
  ADD COLUMN backtest_result jsonb,                      -- full BacktestResult
  ADD COLUMN strategy_id uuid,                           -- which strategy it targets
  ADD COLUMN auto_resolved boolean NOT NULL DEFAULT false,
  ADD COLUMN needs_review boolean NOT NULL DEFAULT false;
```
Add `'needs_review'` as a valid `status` value alongside the existing four.

#### 2. New edge function: `propose-experiment`
- Reads: approved strategy + last 30 days of trades + recent gate-reasons + regime history
- Calls Lovable AI (`google/gemini-3-flash-preview`) with a tool-call schema asking for: `{ parameter, before, after, hypothesis, expected_effect }`
- Writes one `experiments` row with `proposed_by='copilot'`, `status='queued'`
- Idempotent: skips if there are already ≥2 queued copilot experiments for this user

#### 3. New edge function: `run-experiment`
- Picks oldest `queued` experiment row
- Pulls Coinbase candles (reuses the fetch from `lib/backtest.ts`, ported to Deno — or we lift the pure logic to a shared helper)
- Runs backtest with **before** params → baseline metrics
- Runs backtest with **after** params → candidate metrics
- Computes delta + a simple significance check: trade count ≥ 30, expectancy delta > 1 stdev
- Decision tree:
  - Clear improvement → `status='accepted'`, `auto_resolved=true`
  - Clear regression → `status='rejected'`, `auto_resolved=true`
  - Borderline / interesting → `status='needs_review'`, `needs_review=true` → fires an alert
- Writes `backtest_result` jsonb so the UI can render the full breakdown

#### 4. Schedule both with pg_cron
- `propose-experiment`: every 6h
- `run-experiment`: every 15m (drains the queue)

Both use the existing `signal_engine_cron_token` pattern from the vault.

#### 5. Copilot context awareness
Extend the `buildContext()` payload in `Copilot.tsx` with:
```ts
experiments: {
  running: count,
  needsReview: count,
  recentlyAccepted: [{ parameter, delta }, ...],
}
```
So when you ask the Copilot *"what have you been testing?"* it actually knows.

#### 6. New "Promote to strategy" action
On any `accepted` experiment, a button creates a new `strategies` row (status `candidate`) with the **after** params copied in. Closes the loop: idea → test → ship.

### What the user actually sees on the Learning page

```text
┌────────────────────────────────────────────────────────┐
│  Copilot R&D                          ⓘ how this works │
│                                                        │
│  Running 3 · 1 needs your call · 12 auto-resolved this │
│  week (8 rejected, 4 accepted)                         │
└────────────────────────────────────────────────────────┘

┌─ NEEDS REVIEW ─────────────────────────────────────────┐
│ ► Tighten stop_atr_mult 1.5 → 1.3                      │
│   Win rate +4%, expectancy −0.08R · borderline         │
│   Why Copilot tried this · Accept · Reject · Promote   │
└────────────────────────────────────────────────────────┘

┌─ RECENTLY AUTO-RESOLVED  (click to expand)  ────────  ▼│
└────────────────────────────────────────────────────────┘

[ ⋯ menu: Suggest experiment manually ]
```

### Out of scope (call out, build later)
- Forward-testing in paper mode (after backtest passes, run the param in paper for N days)
- Multi-parameter / grid search experiments — start with one knob at a time
- A dedicated Copilot "research log" feed (could fold into Journals with `kind=research`)

### Files touched
- New migration: `experiments` columns + cron schedule
- New: `supabase/functions/propose-experiment/index.ts`
- New: `supabase/functions/run-experiment/index.ts`
- New: `src/lib/backtest-shared.ts` (lift pure backtest logic so Deno can use it; existing `lib/backtest.ts` re-exports for client use)
- Edit: `src/hooks/useExperiments.ts` (add `needsReview`, `runningByCopilot`, `promoteToStrategy`)
- Edit: `src/pages/Learning.tsx` (rewrite as digest)
- Edit: `supabase/functions/copilot-chat/index.ts` (accept experiments context)
- Edit: `src/pages/Copilot.tsx` (attach experiments context)
- Edit: `src/lib/domain-types.ts` (`ExperimentStatus` += `needs_review`, new fields)

### Build order (one PR each)
1. Migration + extend `useExperiments` + rewrite Learning page as digest reading existing data (UI lands first, even with no copilot rows yet)
2. `run-experiment` function + pg_cron — drains any manually-queued rows automatically
3. `propose-experiment` function + pg_cron — Copilot starts seeding the queue
4. Copilot context wiring + "Promote to strategy" button — closes the loop

After step 1 the page already feels different (read-only digest). After step 3 the AI is genuinely doing R&D in the background.

