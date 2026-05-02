# Diamond-Tier Doctrine Upgrade

## Today (the honest baseline)

- **One global doctrine row per user** (`doctrine_settings`) + 3 fixed presets (sentinel/active/aggressive) + a 24h cooldown queue (`pending_doctrine_changes`).
- Engine resolves it through `resolveDoctrine()` → `clampSize()` + `evaluateRiskGates()`. Solid.
- Wags can `propose_doctrine_change` with no cooldown; the user editor *does* enforce 24h on loosenings.
- All changes hash-chained into `system_audit_log`. Append-only. Good.

**What's missing for "diamond tier":**
1. Doctrine is **flat** — same caps for BTC mid-day as for SOL during CPI.
2. Doctrine is **static** — doesn't auto-tighten on a losing streak / drawdown / rough regime.
3. Doctrine has **no memory of why** a value is what it is, and no "revert" affordance.
4. **Wags bypasses** the same 24h cooldown the user is held to — that's a tilt vector.
5. Editor shows **no impact preview** ("if this had been live last 30 days you'd have placed N more trades, P&L delta $X").
6. No **per-symbol** overrides, no **time-of-day** windows, no **event lockouts**.
7. The **profile picker** and **doctrine_settings** can drift (picker writes some fields, leaves others stale).

---

## Plan — 7 upgrades, sequenced

### 1. Per-symbol doctrine overrides (BTC ≠ SOL)

New table `doctrine_symbol_overrides (user_id, symbol, max_order_pct?, risk_per_trade_pct?, daily_loss_pct?, max_trades_per_day?, enabled)`. Nullable columns = "inherit global." Resolver becomes `resolveDoctrine(settings, overrides, symbol, equity)` → returns the **effective** doctrine for that symbol. Engine + sizing + risk-gate take symbol as input (they already do), so the change is local.

UI: a small "per-symbol" toggle inside `DoctrineEditSheet` revealing 3 sub-rows (BTC/ETH/SOL) with inheritance chips.

### 2. Regime + event-aware modes

A doctrine has **modes** that are auto-selected each tick — not user-chosen:
```text
calm  → use base doctrine
choppy → ×0.7 size, ×0.5 daily-trade cap
storm  → ×0.4 size, halve risk_per_trade, daily_loss_pct ×0.5
event-lockout (CPI/FOMC/news_flag=critical) → no new entries for N min
```
Selector: a tiny pure function `selectMode(intel, news_flags, vol)` in `_shared/doctrine-modes.ts`. Resolver multiplies the base caps by the mode's coefficients. Modes are **overlay only** — they can never *loosen*, only *tighten*.

UI: Doctrine guardrail tiles get a chip "Adjusted by Storm mode (×0.4)" with a tooltip explaining why.

### 3. Drawdown auto-tighten ladder

If realized DD from start_of_day_equity crosses thresholds, doctrine auto-tightens for the rest of the UTC day (resets at rollover):
```text
-1% DD  → max_trades_per_day −20%
-2% DD  → max_order_pct ×0.5
-3% DD  → halt new entries (existing daily_loss cap already does this)
```
Stored as ephemeral `system_state.doctrine_overlay_today` jsonb. Engine reads `resolved` *after* overlay is applied. Auto-clears on rollover-day cron.

This is "soft kill-switch" that the user actually wants — graduated, not binary.

### 4. Time-of-day & day-of-week windows

`doctrine_windows (user_id, label, days[], start_utc, end_utc, mode)` — e.g. "no trades 13:25–13:35 UTC on FOMC days," or "halve size on weekends." Default windows seeded:
- **Sunday low-liquidity**: `mode=choppy` 02:00–08:00 UTC Sat/Sun
- **CPI 30-min lockout**: a static lockout starting 5 min before the scheduled timestamp (read from a small `economic_calendar` seed)

If no rows, behaves identically to today.

### 5. Wags & user share the same cooldown rules

Today Wags' `propose_doctrine_change` writes through a different path than the user editor and bypasses the 24h cooldown. **Unify them**: Wags' tool internally calls the same `update-doctrine` function. That means:
- Wags **can tighten instantly** (good — anti-tilt).
- Wags **must queue loosenings** with a written rationale that lands in `pending_doctrine_changes.reason` and shows in `PendingDoctrineChangesPanel` so you can cancel.

This closes the only legitimate "AI runs the casino" gap in the current design.

### 6. Editor: live impact preview + diff + revert

Three additions to `DoctrineEditSheet`:

a. **Backtest delta** — when the user drags a slider, an edge function `doctrine-impact` replays the last 30 days of `trade_signals` against the draft doctrine and returns: `{ tradesAllowed, tradesBlocked, hypotheticalPnlDelta, biggestRefusal }`. Cached 5 min per user.

b. **Side-by-side diff** — always show current vs draft column. Loosenings highlighted amber, tightenings green. Already partially there; finish it.

c. **Revert to last activated** button (per field) — reads the last `doctrine.tighten` / `doctrine.loosen.activated` audit row for that field and restores it. Confirms with a one-line summary of when/why it was changed.

### 7. Doctrine versioning + named snapshots

New table `doctrine_versions (id, user_id, version_no, settings_jsonb, overrides_jsonb, label, created_at, source)`. Every applied change writes a new row. User can:

- **Name a version**: "Pre-FOMC-Apr26", "Post-Taylor-tightening".
- **Diff any two versions** (UI: dropdown + dropdown + diff card).
- **Restore a version** (still routes through `update-doctrine` so loosenings still queue).

Solves "I don't remember what changed three days ago."

---

## Cross-cutting mechanics

- **Resolver becomes the only path.** Profile picker stops writing partial fields directly; it calls `update-doctrine` with the full preset diff so cooldown rules apply uniformly.
- **Invariants** (`validateDoctrineInvariants`) extend to assert that any *resolved + overlayed* doctrine still ≤ aggressive ceiling. Modes/overlays/per-symbol overrides cannot escape the wall.
- **Audit log** captures `actor=user|wags|system|mode|drawdown|window` so the timeline reads like a log, not a mystery.
- **Tests** — extend `doctrine.test.ts` with: per-symbol resolution, mode multipliers compounded with overlays, "loosening through any path queues 24h," "Wags cannot bypass cooldown."

---

## Sequencing (ship in this order; each is independently shippable)

```text
Phase 1  (foundations)
  1.1  Schema: doctrine_symbol_overrides, doctrine_windows, doctrine_versions
  1.2  Resolver signature change → (settings, overrides, symbol, equity, mode)
  1.3  Versioning auto-snapshot on every applied change
  1.4  Tests + invariant extensions

Phase 2  (auto behaviors)
  2.1  Drawdown overlay (ephemeral, resets at UTC rollover)
  2.2  Regime/event mode selector + multiplier overlay
  2.3  Time-of-day window engine + seeded weekend rule
  2.4  UI chips on guardrail tiles showing active overlays

Phase 3  (operator surface)
  3.1  DoctrineEditSheet: per-symbol toggle + diff column
  3.2  doctrine-impact edge function + sparkline preview in editor
  3.3  Per-field "Revert" button reading audit log
  3.4  Versions browser (list, name, diff, restore)

Phase 4  (governance)
  4.1  Wags propose_doctrine_change → routes through update-doctrine
  4.2  Pending changes panel shows actor=wags rows with rationale
  4.3  Audit-log viewer page (read-only timeline)
```

Phase 1 + 2 are the highest-value and lowest-UI-risk; if you want to stop after those, you already have a meaningfully smarter doctrine.

---

## Technical details (for the engineer)

- **Files touched (Phase 1):**
  - `supabase/migrations/<ts>_doctrine_diamond.sql` (3 tables + RLS)
  - `supabase/functions/_shared/doctrine-resolver.ts` + browser mirror
  - `supabase/functions/_shared/doctrine-modes.ts` (new, pure)
  - `supabase/functions/signal-engine/index.ts` (pass symbol+mode into resolve)
  - `supabase/functions/_shared/doctrine.test.ts` (extend)
- **Mode multipliers live in code, not DB** — they're invariants, not user-tunable. (Users can still pick which symbols/windows trigger which mode.)
- **Drawdown overlay** is computed in `signal-engine` once per tick, written to `system_state.doctrine_overlay_today`, read by every consumer (Wags context, UI) so everyone sees the same number.
- **`doctrine-impact`** uses existing `trade_signals` rows + `clampSize()`/`evaluateRiskGates()` directly — no new market data fetch, just deterministic replay.
- **Wags unification**: `propose_doctrine_change` becomes a thin wrapper that calls `update-doctrine` with `actor='wags'`. The function already returns `{instant, pending}` — Wags reports honestly which it got.
- **No breaking changes** for current users: empty overrides + no windows + no overlays = today's behavior exactly.

---

## What this gets you

- The doctrine **adapts to conditions** instead of you adapting it manually.
- You can **see and undo** what Wags did, with the same friction Wags faces.
- You can ask "what would happen if…" before pulling the trigger.
- BTC stops being treated like SOL.
- The kill-switch stops being the only protection between "fine" and "halted."
