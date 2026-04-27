## What you're seeing

Two separate bugs, both real:

### 1. "View all 20 alerts in Journals" link is a dead end
The Overview page links overflow alerts to `/journals`, but the Journals page never renders alerts — it only shows journal entries. So you click and see nothing alert-related. There is no dedicated alerts viewer in the app today.

### 2. The "Jessica heartbeat lost" alerts are false alarms
I checked the cron jobs and the database:

- `jessica-tick` cron is firing **every minute, succeeding every time** (last 10 runs all `succeeded`, most recent at 22:02 UTC).
- But `system_state.last_jessica_decision.ran_at` is **24 minutes stale**.
- The Postgres heartbeat checker (`check_jessica_heartbeat`, runs every 3 min) reads `ran_at`, sees it's >4 min old, and raises a "critical" alert — deduped to once per 30 min, which matches exactly what you're seeing (02:48, 02:18, 01:45, 01:12 …).

**Root cause**: in `supabase/functions/jessica/index.ts` (lines 342–355), Jessica returns early with `{ skipped: true, reason: "kill_switch_engaged" | "bot_paused" | "paused until …" | "equity_critical_near_floor" }` **before** writing `last_jessica_decision`. Your bot is currently paused, so every tick exits early, `ran_at` never updates, and the watchdog screams. Cron is fine. Jessica is fine. The heartbeat signal is broken.

---

## Plan

### Fix 1 — Make alerts a first-class page

- Add `/alerts` route and `src/pages/Alerts.tsx`:
  - Full list of alerts (paginated/scrollable), filter chips for `critical / warning / info`, search box.
  - Each row opens the existing `AlertDetailSheet` (already supports deep-links and dismiss).
  - "Dismiss" and "Dismiss all read" actions wired through `useAlerts`.
- Add `/alerts` to `AppSidebar` nav.
- Update `src/pages/Overview.tsx` line 541: change `to="/journals"` → `to="/alerts"` and the label to "View all N alerts →".
- (Optional but cheap) Add a "Mark all dismissed" bulk action on the Alerts page.

### Fix 2 — Stop the false Jessica heartbeat alarms

Two-part fix so the watchdog stays useful but stops crying wolf:

**a) Always update `ran_at`, even on skipped ticks** (`supabase/functions/jessica/index.ts`)
Refactor the four early-return branches (lines 342–355) so they write a minimal decision summary first:
```ts
{ ran_at, skipped: true, reason: "bot_paused", actions: 0 }
```
This is the correct heartbeat semantics: "the function ran" is what we want to track, not "the function took an action."

**b) Make the heartbeat checker tolerant** (`check_jessica_heartbeat` SQL function, via migration)
- Bump the staleness threshold from 4 min → 8 min (cron runs every 1 min, watchdog every 3 min — 8 min covers two missed ticks plus jitter).
- When `system_state.bot = 'paused'` or `kill_switch_engaged = true`, mark health as `degraded` instead of `failed` and **do not raise an alert** — these are operator-intended states, not outages.
- Keep the existing 30-min alert dedupe.

### Cleanup
- Delete the existing 16 stale "Jessica heartbeat lost" critical alerts so the count drops to the real 3 info alerts. (One-shot SQL via migration.)

---

## Files touched

- `src/App.tsx` — add `/alerts` route
- `src/pages/Alerts.tsx` — new
- `src/components/trader/AppSidebar.tsx` — add nav entry
- `src/pages/Overview.tsx` — repoint "View all" link to `/alerts`
- `supabase/functions/jessica/index.ts` — write `ran_at` on skip paths
- `supabase/migrations/<new>.sql` — update `check_jessica_heartbeat()` thresholds + paused-state handling, and delete stale heartbeat alerts

No schema changes, no new tables, no impact on tools/Harvey/cron wiring.

---

## Verification after build

1. Click "View all alerts" on Overview → lands on `/alerts` showing all 20.
2. Confirm filter + dismiss work; sheet opens on row click.
3. Within ~3 min of deploy: `system_state.last_jessica_decision.ran_at` updates every minute even though bot is paused.
4. No new "Jessica heartbeat lost" alert appears within the next 30 min while paused.
5. Manually flip cron off (or simulate by stopping ran_at writes) → confirm watchdog still fires after 8 min — i.e. it's tolerant, not blind.
