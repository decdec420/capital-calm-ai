## What's actually wrong

You have **$9.99 equity** (verified in the DB), but the screenshot shows guardrails labeled `$10,000` and `$9,500`. Those numbers are **fake seed strings** baked into the legacy `guardrails` table when your account was created — they are pure display, the engine ignores them entirely.

The header even says so:
> Display-only guardrails for ops awareness. The engine does **not** read these.

So they're not dangerous — but they're confusing, contradictory, and on a $10 account they're flat-out wrong.

## The two sources of $10,000

1. **`handle_new_user()` trigger** seeds 8 rows into `guardrails` with hardcoded strings: `'$10,000'`, `'$9,500'`, `'0.18%'`, `'2.1 bps'`, `'42ms'`, etc. These are the "Custom annotations" tiles you see.
2. **`Welcome.tsx`** onboarding still defaults the equity input to `"10000"` and floor to `"8500"` — irrelevant for you now, but wrong for any new user with a small account.

The **real** guardrails — the ones the engine enforces — live in the **Doctrine guardrails** grid directly above (Max order size, Daily loss cap, Kill-switch floor, etc.), and those already read live from your `doctrine_settings` + `account_state` ($9.99 equity, $8 floor).

## Do the "Custom annotations" make sense for your setup?

**Short answer: no, not in their current form.**

- They were designed as a demo/seed for a $10K paper account. On a $10 live-ish account they're pure noise.
- They duplicate concepts already enforced authoritatively by Doctrine guardrails (Max order, Daily loss, Daily trade cap, Balance floor, Stale data).
- The remaining ones (Spread filter, Drawdown, Latency) are **observability** ideas the engine doesn't actually compute or check anywhere — they're aspirational placeholders.
- Keeping them as static strings means they'll always drift from reality.

**Recommendation:** delete the seed entirely. The section becomes empty by default, and the "Add annotation" button stays available if you ever want to jot a personal note (e.g. "don't trade during FOMC"). Treat custom annotations as *user notes*, not *fake metrics*.

## Plan

### 1. Stop seeding fake guardrails for new users
- Migration: update `handle_new_user()` to remove the 8 hardcoded `INSERT INTO guardrails` rows.
- New users get a clean, empty Custom annotations section. Doctrine guardrails still cover everything real.

### 2. Clear the existing fake rows from your account
- Migration: `DELETE FROM guardrails WHERE current_value IN ('$10,000','$9,500','0.18%','0.27%','2.1 bps','0.4s','-1.2%','42ms') AND user_id = <you>` — scoped & safe (only removes the seeded strings, leaves any real annotations alone).

### 3. Fix the onboarding defaults in `Welcome.tsx`
- Change `useState("10000")` → `useState("")` with placeholder `"e.g. 10.00"`.
- Change `useState("8500")` → `useState("")` with placeholder `"e.g. 8.00"`.
- Keep validation as-is; just stop pre-filling misleading values.

### 4. Remove dead `account_state` defaults (optional, low risk)
- The columns `equity`, `cash`, `start_of_day_equity` default to `10000` and `balance_floor` to `9500` at the schema level. New onboarding now overrides them, but if a user skips onboarding they'd briefly see $10K. Migration: change defaults to `0` (or leave — your call; new-user trigger already inserts a row, and StartingEquityModal forces the user through onboarding).

### 5. Soften the "Custom annotations" copy
- Update the description on RiskCenter to make the *purpose* clearer:
  > "Personal notes and reminders about your setup. The engine doesn't read these — they're just for you. See Doctrine guardrails above for what's actually enforced."

## Files to change

- `supabase/migrations/<new>.sql` — rewrite `handle_new_user()` (drop the guardrails seed) + delete existing seed rows for current users
- `src/pages/Welcome.tsx` — empty defaults + placeholders
- `src/pages/RiskCenter.tsx` — gentler copy on the Custom annotations header

## Out of scope (intentionally)

- Doctrine guardrails grid — already correct, reads $9.99 / $8 live
- Engine logic — never read the legacy table
- Test files / migrations history — leave older migrations untouched (history is immutable)
