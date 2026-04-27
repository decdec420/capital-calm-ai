## Problem

The Alerts page has action buttons that link to routes that don't exist in the app:

- `/health` — used by **cron heartbeat** alerts (primary action). 404.
- `/doctrine` — used by **guardrail** alerts (secondary action). 404.

Both produce the NotFound page when clicked. Verified by grepping `src/App.tsx` — no `health` or `doctrine` routes are registered.

## Fix

Repoint these to the closest existing pages in `src/lib/alert-classification.ts`:

### Cron / heartbeat alerts
- Primary action: `Open Health → /health` becomes `Open Risk Center → /risk` (system state, kill-switch, and guardrails all live there; it's the de-facto operations page).
- Secondary action: `Open Settings → /settings` (where bot autonomy / pause state is controlled — relevant since "paused" is the most common cause of a missed heartbeat).
- Update the `fixes` copy to reference Risk Center instead of Health.

### Guardrail alerts
- Primary action: stays `Open Risk Center → /risk` (already valid).
- Secondary action: `Open Doctrine → /doctrine` becomes `Open Strategy Lab → /strategy` (closest match — guardrails are tuned alongside strategy parameters; there is no standalone Doctrine page).
- Update the `fixes` copy to reference Strategy Lab.

### Other categories
Audited — `/copilot`, `/trades`, `/journals`, `/risk` are all valid routes. No other changes needed.

## Files

- `src/lib/alert-classification.ts` — update two `primaryAction`/`secondaryAction` blocks plus their `fixes` copy.

No new pages, no routing changes, no DB changes. Pure copy/link fix.
