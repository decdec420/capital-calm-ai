-- =============================================================================
-- Guardrails Overhaul — May 5 2026
-- =============================================================================
-- Context: Two long-running data inconsistencies were suppressing all trades:
--
--   1. starting_equity_usd = $10 but account_state.equity = $50 (paper top-up
--      never updated the doctrine baseline). Kill-switch floor was $8 instead
--      of $40. Daily loss cap was $0.15/day instead of $1.00/day.
--
--   2. daily_loss_pct still at the sentinel onboarding default (0.3%). Three
--      tiny losing trades ($0.05 each) halted the bot for the entire day.
--
-- This migration fixes BOTH problems for all existing users and aligns the
-- doctrine defaults with sane autonomous-trading standards.
-- =============================================================================

-- ── 1. Sync starting_equity_usd → account_state.equity ────────────────────
-- Rule: the kill-switch floor must protect the capital you actually have.
-- If equity > starting_equity_usd (because of top-ups or trading gains),
-- the floor baseline should rise to match. This is a one-time catch-up
-- for all users who topped up paper balance after the initial onboarding.
--
-- After this migration, topup-paper-balance automatically keeps them in sync
-- going forward (see the edge function update in the same PR).

UPDATE public.doctrine_settings ds
SET
  starting_equity_usd = a.equity,
  updated_via         = 'guardrails_overhaul_migration',
  updated_at          = now()
FROM public.account_state a
WHERE a.user_id     = ds.user_id
  AND a.equity      > COALESCE(ds.starting_equity_usd, 0)
  AND a.equity      > 0;

-- ── 2. Raise daily_loss_pct from the sentinel onboarding default (0.3%) ───
-- The sentinel preset was conservatively set to 0.3% daily loss. For a $50
-- paper account that means $0.15/day cap — three tiny losses halts the bot.
--
-- Industry standard for paper/early-stage systematic strategies: 2-5% daily.
-- We raise to 2% (0.02) for any user who hasn't manually changed this field.
--
-- Guard: only update where daily_loss_pct <= 0.005 AND updated_via != 'user'
-- so deliberate user edits are never overwritten.

UPDATE public.doctrine_settings
SET
  daily_loss_pct = 0.02,
  updated_via    = 'guardrails_overhaul_migration',
  updated_at     = now()
WHERE daily_loss_pct <= 0.005
  AND (updated_via IS NULL OR updated_via != 'user');

-- ── 3. Raise consecutive_loss_limit for sentinel users at old default ──────
-- The old sentinel default was 2 consecutive losses before cooldown, which
-- is far too tight for a bot learning to trade 5 positions/day. Raise to 3.

UPDATE public.doctrine_settings
SET
  consecutive_loss_limit = 3,
  updated_via            = 'guardrails_overhaul_migration',
  updated_at             = now()
WHERE consecutive_loss_limit <= 2
  AND (updated_via IS NULL OR updated_via != 'user');

-- ── Verify: show what changed (helpful for review) ────────────────────────
-- (these are comments only — remove if running in production CI)
-- SELECT user_id, starting_equity_usd, daily_loss_pct, consecutive_loss_limit
-- FROM public.doctrine_settings
-- WHERE updated_via = 'guardrails_overhaul_migration';
