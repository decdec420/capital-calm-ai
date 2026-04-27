# Copilot — Cap chat height & explain the right column

## The two issues

### 1. Chat scroll is broken
Right now the chat panel uses `minHeight: 65vh` with no max — so the panel grows
forever as messages accumulate, the **page** scrolls instead of the chat, and
the input box gets pushed off-screen. That's the "endless" feeling you saw.

### 2. Right column isn't self-explanatory
You asked what those two right-side panels are. They are:

- **Autonomy** — sets _who_ approves trades:
  - **Manual** — every signal needs your tap
  - **Assisted** — auto-approves when AI confidence ≥ 85%
  - **Autonomous** — auto-approves all signals within doctrine limits
  - The "(paper)" / "(LIVE)" tag tells you whether approvals fire paper or real orders.

- **Live context** — a read-only snapshot of what gets auto-attached to
  every chat message you send (mode, equity, current engine pick + regime,
  open position, pending signal, correlation cap). It's how Max "knows" your
  state without you re-typing it.

The labels are correct but the _why_ is invisible. We'll add small explainer
lines so it's obvious at a glance.

---

## Changes (only `src/pages/Copilot.tsx` + `src/components/trader/AutonomyToggle.tsx`)

### Fix A — Bound the chat panel
Change the chat container from `minHeight: 65vh` (unbounded) to a fixed
`height: min(72vh, 760px)` with `overflow: hidden` on the panel. The inner
messages list (`overflow-y-auto`) will then scroll _inside_ the panel, the
input stays pinned to the bottom, and the page no longer grows.

For Signal Log and AI Accuracy tabs, same fix applies automatically since
they share the same panel wrapper.

### Fix B — Make the right column legible
- **Autonomy panel**: add a one-line subtitle under the header — _"Who
  approves trades."_ Keep the existing dynamic hint at the bottom (already
  describes the active mode).
- **Live context panel**: change the header to **"What Max sees"** with a
  one-line subtitle — _"Auto-attached to every message."_ Move the existing
  italic footer note up into the subtitle (avoids duplication).

### Fix C — Minor polish
- Keep "+ New chat" button where it is (tab header).
- No new dependencies. No backend changes. No test changes.

---

## What stays the same

- All edge functions, hooks, data flow
- Tab structure (Chat / Signal Log / AI Accuracy)
- Autonomy logic, Live context data
- Signal bridge card at top, conversation sidebar at bottom
- All 84 tests still pass

## Files touched

- `src/pages/Copilot.tsx` — bound chat panel height, relabel right-column headers
- `src/components/trader/AutonomyToggle.tsx` — add one-line subtitle