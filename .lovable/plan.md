# Per-User Scaling Doctrine + Editable Guardrails (with 24h Tilt Protection)

## What you're getting

1. **Doctrine scales to your money.** A $10 funder, a $1,000 funder, and a $100k funder all get the same *percentage* protection (e.g. 0.5% per order, 80% floor) — not the same hardcoded $1/$8 numbers. Caps grow as equity grows.
2. **Three profiles become ratio presets**, not fixed dollars. Sentinel/Active/Aggressive load percentages into your settings; you can then tune them.
3. **Editable doctrine.** A new "Edit doctrine" sheet on Risk Center lets you adjust max-order %, daily-loss %, daily-trade count, kill-switch floor %, and the tilt-protection knobs.
4. **Tilt protection.** Tightening risk applies instantly. **Loosening** risk creates a *pending change* that activates after **24 hours**, with a visible countdown. Cancellable anytime before activation. Every request and every activation is written to `system_audit_log` so Katrina/Rachel can call it out.
5. **Kill-switch floor is per-user.** Default `floor_pct = 0.80` × `starting_equity_usd`. The hardcoded $8 disappears as a per-user rule but stays as an absolute emergency wall (no user floor below $5).
6. **Caps grow with equity (compounding).** Max order = `current_equity × max_order_pct`, then bounded by an absolute hard cap so a fat-fingered equity update can't unleash a $10k order.

---

## Section 1 — Database

### 1A. Extend `doctrine_settings` (already exists, has the right columns)

Add columns the engine doesn't yet have:

```sql
ALTER TABLE public.doctrine_settings
  ADD COLUMN max_order_abs_floor numeric NOT NULL DEFAULT 0.25,   -- never below $0.25/order
  ADD COLUMN floor_abs_min       numeric NOT NULL DEFAULT 5,      -- emergency floor wall
  ADD COLUMN scan_interval_seconds integer NOT NULL DEFAULT 300,
  ADD COLUMN risk_per_trade_pct numeric NOT NULL DEFAULT 0.01,
  ADD COLUMN max_correlated_positions integer NOT NULL DEFAULT 3,
  ADD COLUMN updated_via text NOT NULL DEFAULT 'system';          -- 'user' | 'profile-preset' | 'system' | 'cooldown-activation'
```

Add a CHECK trigger (not constraint) validating: pcts in `[0, 0.5]`, `floor_pct in [0.5, 0.95]`, `max_trades_per_day in [1, 100]`, `consecutive_loss_limit in [1, 10]`.

### 1B. New table — `pending_doctrine_changes`

```sql
CREATE TABLE public.pending_doctrine_changes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  field        text NOT NULL,           -- e.g. 'max_order_pct'
  from_value   numeric,
  to_value     numeric NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  effective_at timestamptz NOT NULL,    -- now() + 24h
  status       text NOT NULL DEFAULT 'pending',  -- pending | activated | cancelled | superseded
  cancelled_at timestamptz,
  activated_at timestamptz,
  reason       text                     -- optional user note
);
```

RLS: own-row CRUD by `auth.uid() = user_id`. INSERT/UPDATE allowed (cancellation), DELETE blocked.

### 1C. Cron + edge function for activation

`activate-doctrine-changes` edge function (token-protected like Jessica/Katrina). Runs every 5 minutes:
- Find rows where `status = 'pending'` and `effective_at <= now()`.
- Apply `to_value` to `doctrine_settings`.
- Mark row `activated`, write `system_audit_log` entry `action='doctrine.loosen.activated'`.
- If a newer pending change for the same field exists, mark older ones `superseded`.

Vault token: `activate_doctrine_changes_cron_token` + RPC `get_activate_doctrine_changes_cron_token()`.

### 1D. `handle_new_user` updates

Already inserts `doctrine_settings` with `starting_equity_usd = 10`. Change default `starting_equity_usd` to **NULL** and force the user to enter it during onboarding (see §3). Until set, the engine uses the hardcoded Sentinel-equivalent ratios with `starting_equity_usd = max(current_equity, 10)` as a safe fallback.

---

## Section 2 — Engine refactor (the core)

### 2A. New `_shared/doctrine-resolver.ts`

Single source of truth for "what are this user's effective caps right now?" Used by every edge function and mirrored in `src/lib/doctrine-resolver.ts` for the browser.

```ts
resolveDoctrine({ settings, currentEquityUsd }) → {
  maxOrderUsd:        clamp(currentEquityUsd × settings.max_order_pct, settings.max_order_abs_floor, settings.max_order_abs_cap),
  killSwitchFloorUsd: max(settings.starting_equity_usd × settings.floor_pct, settings.floor_abs_min),
  dailyLossUsd:       currentEquityUsd × settings.daily_loss_pct,
  maxTradesPerDay:    settings.max_trades_per_day,
  riskPerTradePct:    settings.risk_per_trade_pct,
  ...
}
```

This is the new home of every number that used to come from `TRADING_PROFILES`.

### 2B. Rewire callers (no behaviour change for existing users)

Replace direct profile reads in:
- `supabase/functions/_shared/risk.ts` (`evaluateRiskGates`) — accept `resolvedDoctrine` instead of `profile`.
- `supabase/functions/_shared/sizing.ts` (`clampSize`, `notionalFromRiskPct`) — same.
- `supabase/functions/signal-engine/index.ts` — fetch `doctrine_settings` per tick, call resolver, pass downstream. Update the AI prompt to inject the *resolved* numbers (no more hardcoded `$${MAX_ORDER_USD}`).
- `supabase/functions/jessica/index.ts` — read resolved doctrine for postmortems.

### 2C. Profiles become presets, not enforcement

`active_profile` stays in `system_state` but is informational/UX-only. Selecting a profile in `ProfilePicker` writes the preset *ratios* into `doctrine_settings` (one shot) and shows a toast: "Loaded Sentinel preset — tune in Edit doctrine."

```ts
SENTINEL_PRESET   = { max_order_pct: 0.001, daily_loss_pct: 0.003, floor_pct: 0.80, max_trades_per_day: 5,  risk_per_trade_pct: 0.01,  scan_interval_seconds: 300 }
ACTIVE_PRESET     = { max_order_pct: 0.005, daily_loss_pct: 0.01,  floor_pct: 0.75, max_trades_per_day: 15, risk_per_trade_pct: 0.015, scan_interval_seconds: 120 }
AGGRESSIVE_PRESET = { max_order_pct: 0.025, daily_loss_pct: 0.03,  floor_pct: 0.60, max_trades_per_day: 30, risk_per_trade_pct: 0.02,  scan_interval_seconds: 60 }
```

Loading a preset uses the same tighten-instant / loosen-cooldown path as a manual edit.

### 2D. Tighten vs loosen classifier

A small helper in `doctrine-resolver.ts`:
```ts
isLoosening(field, fromValue, toValue) → boolean
```
- `max_order_pct` ↑ loosens
- `daily_loss_pct` ↑ loosens
- `max_trades_per_day` ↑ loosens
- `floor_pct` ↓ loosens
- `risk_per_trade_pct` ↑ loosens
- `consecutive_loss_limit` ↑ loosens
- `loss_cooldown_minutes` ↓ loosens

Edge function `update-doctrine`:
- For each field changed, if tightening → write directly to `doctrine_settings` + audit log (`doctrine.tighten`).
- If loosening → insert into `pending_doctrine_changes` with `effective_at = now() + 24h` + audit log (`doctrine.loosen.requested`).
- Reject if user is in a paused-by-risk / kill-switch state? **No** — per your spec, tightening still works in those states; loosening is just delayed as normal (the 24h wait is the protection).

---

## Section 3 — Onboarding: capture starting equity

When a new user lands, if `doctrine_settings.starting_equity_usd IS NULL`, show a one-time modal on first visit to Risk Center / Overview:

- Single field: "How much capital are you funding this account with?" ($1 minimum, no max)
- Default profile preset: Sentinel
- On submit: write `starting_equity_usd`, apply Sentinel preset ratios, derive caps.
- Helper text shows the resulting numbers live: *"At $1,000 funding: $1.00 max order, $3 daily loss cap, $800 kill-switch floor."*

---

## Section 4 — UI: Risk Center

### 4A. `DoctrineGuardrailGrid` becomes editable

- Replace the static `DOCTRINE` reads with a new `useDoctrineSettings()` hook (reads `doctrine_settings` + computes resolved caps via the shared resolver).
- Each tile gets a small pencil icon → opens the Edit Doctrine sheet focused on that field.
- Show **two numbers** for `max_order_pct`-type rows: percent (e.g. `0.50%`) and dollar derivation (e.g. `$5.00 of $1,000 equity`).
- Show **both percent and dollar** for the kill-switch floor tile.

### 4B. New "Edit doctrine" sheet (`DoctrineEditSheet.tsx`)

Right-side sheet with grouped sliders/steppers:
- **Per-order risk**: `max_order_pct` (0–5%), absolute hard cap ($)
- **Daily limits**: `daily_loss_pct` (0–10%), `max_trades_per_day` (1–50)
- **Floor**: `floor_pct` (50–95%), live-derived dollar value below
- **Per-trade**: `risk_per_trade_pct` (0–3%)
- **Tilt protection**: `consecutive_loss_limit`, `loss_cooldown_minutes`

Each row shows: current value, draft value, and an inline tag — **"Applies instantly"** (green) for tightening, **"Activates in 24h"** (amber) for loosening. A footer summary lists all pending changes before save.

### 4C. New "Pending changes" panel

Sits above `DoctrineGuardrailGrid` if any pending rows exist:
- For each row: field name, from→to, "Activates in 23h 14m" countdown, **Cancel** button.
- Cancelling marks the row `cancelled` + writes `doctrine.loosen.cancelled` to audit log.

### 4D. Profile picker

Keep the three-card picker but relabel:
- Title: "Profile presets"
- On click: confirmation dialog showing every field that will tighten (instant) or loosen (24h delay), then dispatches to `update-doctrine` per field.

---

## Section 5 — Wiring up the rest

- **Copilot (Harvey)** + **Jessica** + **Katrina** + **Rachel**: their context builders already pull `system_state` + (some) doctrine numbers. Update them to pull from the resolver so they reference the user's *actual* caps, not Sentinel defaults. Katrina should mention pending loosenings in her weekly review ("you raised max-order from 0.5% to 1% on Tue — N trades since, win rate Δ X%").
- **AI agents cannot bypass cooldown.** The `update-doctrine` edge function only accepts `actor='user'`. Copilot tool calls that try to mutate doctrine route through the same function and follow the same rules.
- **Custom annotations** (existing `guardrails` table): unchanged. Already editable. Clarify the description: "Display-only — engine reads Doctrine guardrails above."

---

## Section 6 — Tests + safety

- New unit tests in `_shared/doctrine.test.ts`:
  - resolver math at $10, $1k, $100k equity
  - tighten classifier
  - absolute caps still bound a runaway equity number
  - kill-switch floor never below `floor_abs_min`
- New integration test for the cooldown flow: request → 24h passes → cron activates → settings updated → audit log entries present.
- Keep the existing 88-test suite green.

---

## Files touched

**New**
- `supabase/migrations/<ts>_doctrine_per_user_scaling.sql`
- `supabase/functions/_shared/doctrine-resolver.ts`
- `supabase/functions/update-doctrine/index.ts`
- `supabase/functions/activate-doctrine-changes/index.ts`
- `src/lib/doctrine-resolver.ts` (browser mirror)
- `src/hooks/useDoctrineSettings.ts`
- `src/hooks/usePendingDoctrineChanges.ts`
- `src/components/trader/DoctrineEditSheet.tsx`
- `src/components/trader/PendingDoctrineChangesPanel.tsx`
- `src/components/onboarding/StartingEquityModal.tsx`

**Edited**
- `supabase/functions/_shared/risk.ts`
- `supabase/functions/_shared/sizing.ts`
- `supabase/functions/_shared/doctrine.ts` (deprecate hardcoded numbers, keep types)
- `supabase/functions/signal-engine/index.ts`
- `supabase/functions/jessica/index.ts`
- `supabase/functions/katrina/index.ts`
- `supabase/functions/copilot-chat/index.ts`
- `src/lib/doctrine-constants.ts` (presets only; runtime caps come from resolver)
- `src/components/trader/DoctrineGuardrailGrid.tsx`
- `src/components/trader/ProfilePicker.tsx`
- `src/pages/RiskCenter.tsx`
- Tests: `_shared/doctrine.test.ts`, `src/test/doctrine.test.ts`, `src/test/lifecycle-integration.test.ts`

---

## Acceptance checks

1. New $1,000 user sees max order $5, kill-switch floor $800 — not $1/$8.
2. Lowering `floor_pct` from 0.80 → 0.70 in the sheet shows "Activates in 24h", appears in pending panel, can be cancelled.
3. Raising `floor_pct` from 0.80 → 0.85 saves instantly with a "Applied" toast.
4. After 24h, cron activates the pending change; `system_audit_log` shows request + activation rows.
5. Switching to Aggressive preset on a $1k account fans out to per-field tighten/loosen routing (most fields loosen → 24h delay).
6. Engine logs show the *resolved* numbers (`maxOrderUsd: 5.00`) per tick, not hardcoded constants.
7. All 88 existing tests still pass; new resolver/cooldown tests pass.

Approve and I'll build it end-to-end.