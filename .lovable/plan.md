# Make alerts useful, not just notifications

Right now every alert card on `/alerts` is a flat strip: severity dot, title, the raw `message` string, a timestamp, and a hover-only dismiss. That works as a *notification*, but it doesn't tell you what to do. The data behind it is richer than the card shows — most alerts come from typed events (heartbeat, guardrail, signal proposed, trade closed, experiment-needs-call) and each type has an obvious "next step."

This plan makes the card pull its weight: explain the situation, show why it matters, and give one clear action.

## What changes (user-visible)

Each alert card grows from a one-liner into a small "incident card" with three parts:

```text
┌────────────────────────────────────────────────────────────┐
│ ● CRITICAL · Cron health      02:48 PM · 4 min ago    [×]  │
│ Jessica heartbeat lost                                     │
│                                                            │
│ What: Jessica hasn't ticked in 9 minutes (cron may be      │
│       down). Bot is currently: paused.                     │
│ Why : New signals stop being generated. Open positions     │
│       still mark-to-market, but no entries/exits fire.     │
│ Fix : 1. Check cron health on the Health page              │
│       2. If bot is intentionally paused, this clears on    │
│          its own when you resume                           │
│       3. Re-run Jessica manually to reset heartbeat        │
│                                                            │
│ [ Open Health → ] [ Run Jessica now ] [ Dismiss ]          │
└────────────────────────────────────────────────────────────┘
```

The card stays compact by default (collapsed: title + one-line summary + primary action) and **expands on click** to reveal what/why/fix + secondary actions. So the page still scans fast, but every alert is one click away from being actionable.

A small **category chip** ("Cron health", "Guardrail", "Signal", "Trade", "Experiment", "System") sits next to severity so you can eyeball a stack of alerts and group them mentally.

## How alerts get classified

We don't change the database. Alerts are classified at render time by matching `title` + `message` against the patterns the app already produces (we wrote those triggers, so we know them):

| Pattern in title                          | Category         | Primary action            |
|-------------------------------------------|------------------|---------------------------|
| `Jessica heartbeat lost`                  | Cron health      | Open Health · Run Jessica |
| `Kill-switch ENGAGED`                     | System           | Open Risk Center          |
| `Guardrail caution` / `Guardrail BLOCKED` | Guardrail        | Open Risk Center          |
| `Signal proposed`                         | Signal           | Open Copilot (signal)     |
| `Trade closed`                            | Trade            | Open Trades               |
| `Experiment needs your call`              | Experiment       | Open Copilot (experiments)|
| anything else                             | System           | (no primary)              |

For each category we hard-code a short **what / why / fix** template. The raw `message` is still shown verbatim under "What" — we never hide the original text, we just frame it.

## Bulk noise reduction (small bonus)

While we're in here: the page currently shows every "Experiment needs your call · stop_atr_mult" alert as a separate row (there are ~12 stacked right now). Group consecutive alerts with the same `title` into a single card with a count badge — "Experiment needs your call · stop_atr_mult **×12**" — expandable to see each occurrence with its individual message. Critical and warning alerts are *never* grouped; only `info` collapses, so we don't hide anything urgent.

## Technical notes

Files touched:

- `src/lib/alert-classification.ts` (new) — pure function `classifyAlert(alert) → { category, what, why, fixes: string[], primaryAction?: { label, to } }`. All pattern matching + templates live here, fully unit-testable.
- `src/components/trader/AlertCard.tsx` (new) — replaces the current inline `AlertBanner` usage on the Alerts page. Collapsed/expanded state, category chip, what/why/fix block, primary + dismiss buttons. Keyboard-accessible (Enter/Space toggles, Esc collapses).
- `src/pages/Alerts.tsx` — swap the `AlertBanner` map for `AlertCard`; add the info-only grouping pass before render; keep the existing severity filter / search / "Dismiss visible" controls.
- `src/components/trader/AlertDetailSheet.tsx` — keep for backward compatibility (Overview's recent-alerts list still uses it), but the Alerts page no longer opens the sheet on click; expansion happens inline on the card itself.
- `src/lib/__tests__/alert-classification.test.ts` (new) — cover one fixture per category + the fallback.

No DB migration, no edge-function changes, no schema changes. The `alerts` table stays exactly as-is.

## Out of scope (call out so we don't sneak it in)

- Adding a `category` / `action_url` column to the `alerts` table. We can do that later if the heuristic gets noisy, but right now patterns are stable and a column would just duplicate what producers already encode in the title.
- Auto-running fixes (e.g. "Run Jessica now" actually triggering the edge function). The button in the mock above is aspirational — for this pass it links to the Health page and the user clicks the existing manual-run control there. Happy to wire one-click remediation in a follow-up if you want it.
