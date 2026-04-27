## Problem

Heartbeat alert says "Jessica may be down" → button sends you to **Risk Center**, which has nothing about Jessica. You can't see what's happening, can't restart her, can't tell whether the bot is just paused. Dead end.

## Fix — make the alert self-contained

The alert card itself should answer: *what is Jessica doing right now, and what can I do about it?* No navigation required for the common cases.

### 1. Live Jessica status inside the alert card

When the expanded card is a `cron_health` alert, render a small **live status block** at the top of the expanded body (above "Why" / "Fixes"):

```text
┌─────────────────────────────────────────────────┐
│ ● Jessica · last tick 14m ago · 0 actions      │
│ Bot: paused (manual)   Kill-switch: off        │
│ Heartbeat agent: failed                         │
└─────────────────────────────────────────────────┘
```

Data sources (all already in the app — no new queries):
- `system.lastJessicaDecision` → last tick time + action count (already used on `/copilot`)
- `system.bot`, `system.killSwitchEngaged`, `system.pauseReason` (already in `useSystemState`)
- `agent_health` rows for `jessica` and `jessica_heartbeat` (queried the same way Copilot does)

This immediately tells the operator the most important thing: **is this a real outage or just the bot being paused?** If `bot = paused` or `killSwitchEngaged = true`, render a soft yellow note:
> "Bot is intentionally idle — heartbeat will resume when you start the bot. This alert will clear automatically."

### 2. Inline action buttons (replace the broken "Open Risk Center")

Replace the current primary/secondary nav buttons with **action buttons that actually do something**, rendered in the alert card itself:

| Button | Action | Shown when |
|---|---|---|
| **Resume bot** | `updateSystem({ bot: "running" })` | `bot !== "running"` and kill-switch off |
| **Disarm kill-switch** | `updateSystem({ killSwitchEngaged: false, bot: "paused" })` | `killSwitchEngaged = true` |
| **Run Jessica now** | `supabase.functions.invoke("jessica")` then toast result | Always (this is the "restart it" button — kicks one tick) |
| **Dismiss** | existing dismiss | Always |

After "Run Jessica now" succeeds, refresh `system_state` so the live status block updates in place.

### 3. Keep one nav link, but make it correct

Below the buttons, a single small text link: **"Open Copilot for full agent panel →"** (`/copilot`). Copilot is where the full agent grid lives — that's the real "operations" page for Jessica/Donna/Harvey, not Risk Center.

### 4. Update copy

In `src/lib/alert-classification.ts`, rewrite the cron_health entry's `what` / `why` / `fixes` to match the new mental model:
- **What:** "Jessica (the autonomous decision agent) hasn't ticked in N minutes."
- **Why:** unchanged — still explains the pause-trading consequence
- **Fixes:** rewrite as
  1. If the bot is paused or the kill-switch is on, this is expected — start the bot to clear it.
  2. Otherwise, click **Run Jessica now** to kick a tick. If it succeeds, the heartbeat resets within a minute.
  3. If "Run Jessica now" fails, the edge function itself is down — check the function logs from Copilot or contact support.

## Files

- `src/components/trader/AlertCard.tsx` — when category is `cron_health`, render the live status block + action buttons instead of (or before) the generic primary/secondary buttons. Will need to read `useSystemState`, `useAgentHealth` (small new query against `agent_health`), and call `supabase.functions.invoke("jessica")`.
- `src/lib/alert-classification.ts` — drop `primaryAction`/`secondaryAction` for `cron_health` (the card now renders its own actions); update `fixes` copy.
- *(optional)* tiny new hook `src/hooks/useAgentHealth.ts` if we don't want to inline the query — but a single inline query in the card is fine since it only mounts when expanded.

No DB changes, no new routes, no edge function changes (we just call the existing `jessica` function).

## Result

Click the alert → expand → see exactly what Jessica is doing → press one button to fix it. Risk Center stays in its lane (risk and guardrails); Copilot stays the "agent operations" hub; the alert card becomes a self-contained incident triage surface.