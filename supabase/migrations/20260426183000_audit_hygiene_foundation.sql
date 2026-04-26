-- ============================================================
-- PR #2 — Audit / hygiene foundation
-- ------------------------------------------------------------
-- Two things in one migration:
--
--   P1-D  Tighten privileges on the mark-to-market cron token
--         RPC so it matches the signal-engine cron token RPC
--         (REVOKE from anon + authenticated, not just PUBLIC).
--
--   P4-F  Add DB-level CHECK constraints on the FSM phase
--         columns. The lifecycle.ts FSM is the source of truth;
--         the database now refuses any value that isn't in it.
--         This is defense-in-depth on top of the BEFORE UPDATE
--         triggers introduced in 20260421060000.
--
-- Idempotent. Safe to re-apply.
-- ============================================================

-- ─── P1-D: cron-token RPC privilege parity ───────────────────────
--
-- 20260420180546 already did the right thing for
-- get_signal_engine_cron_token: revoked from public, anon,
-- authenticated and granted to service_role only.
--
-- 20260421070000 only revoked from PUBLIC for
-- get_mark_to_market_cron_token, leaving the door open for an
-- anon or authenticated caller to execute it if Postgres' default
-- function-grant behavior ever flipped. This locks it down for
-- defense-in-depth.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'get_mark_to_market_cron_token'
  ) THEN
    REVOKE EXECUTE ON FUNCTION public.get_mark_to_market_cron_token()
      FROM PUBLIC, anon, authenticated;
    GRANT  EXECUTE ON FUNCTION public.get_mark_to_market_cron_token()
      TO service_role;
  END IF;
END $$;

-- ─── P4-F: FSM CHECK constraints ─────────────────────────────────
--
-- The FSM in supabase/functions/_shared/lifecycle.ts owns the
-- legal phase strings. We mirror them here so a stray INSERT/UPDATE
-- from any path (legitimate or not) can't put the table into a state
-- the FSM doesn't recognise.

-- trade_signals.lifecycle_phase
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'trade_signals_lifecycle_phase_chk'
  ) THEN
    ALTER TABLE public.trade_signals
      ADD CONSTRAINT trade_signals_lifecycle_phase_chk
      CHECK (lifecycle_phase IN (
        'proposed', 'approved', 'rejected', 'expired', 'executed'
      ));
  END IF;
END $$;

-- trades.lifecycle_phase
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'trades_lifecycle_phase_chk'
  ) THEN
    ALTER TABLE public.trades
      ADD CONSTRAINT trades_lifecycle_phase_chk
      CHECK (lifecycle_phase IN (
        'entered', 'monitored', 'tp1_hit', 'exited', 'archived'
      ));
  END IF;
END $$;

-- strategies.status
--
-- Frontend StrategyStatus only uses {approved, candidate, archived}
-- but the server-side StrategyStage FSM defines
-- {seeded, candidate, approved, live, archived, retired}. We honour
-- the FSM (the broader set) so server-driven promotions to 'live'
-- and seedling rows from automation can land cleanly.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'strategies_status_chk'
  ) THEN
    ALTER TABLE public.strategies
      ADD CONSTRAINT strategies_status_chk
      CHECK (status IN (
        'seeded', 'candidate', 'approved', 'live', 'archived', 'retired'
      ));
  END IF;
END $$;
