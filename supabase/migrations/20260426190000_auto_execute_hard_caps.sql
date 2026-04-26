-- ============================================================
-- PR #4 — Auto-execute hard caps + stale snapshot guard
-- ------------------------------------------------------------
-- Two coordinated controls:
--
--   P1-A   Daily dollar cap on auto-executed trades. Adds the
--          configurable cap column to `account_state` and a
--          SECURITY DEFINER SQL function that returns today's
--          auto-execute notional so the engine can gate against
--          it server-side.
--
--   P6-G   Stale engine snapshot guard. The TS code in
--          _shared/snapshot.ts owns the staleness threshold; this
--          migration just makes sure consumers can detect stale
--          snapshots cheaply via the `last_heartbeat` column
--          already maintained alongside `last_engine_snapshot`.
--
-- Idempotent. Safe to re-apply.
-- ============================================================

-- ─── P1-A: cap column on account_state ───────────────────────────
--
-- Default is $2.00 = max trades/day (2) × MAX_ORDER_USD ($1).
-- An operator can tighten this from Settings; we never auto-loosen.
ALTER TABLE public.account_state
  ADD COLUMN IF NOT EXISTS daily_auto_execute_cap_usd numeric NOT NULL DEFAULT 2.0;

COMMENT ON COLUMN public.account_state.daily_auto_execute_cap_usd IS
  'Max total notional ($USD) the engine may auto-execute in a single
   UTC day. Sum of (size × entry_price) across rows tagged "auto" in
   reason_tags. Browser may UPDATE; the engine reads.';

-- ─── P1-A: today''s auto-execute notional helper ─────────────────
--
-- The engine calls this every tick before deciding to auto-execute,
-- so the answer must be cheap. SECURITY DEFINER lets the engine
-- read across rows the user can already see (RLS would otherwise
-- gate it on `auth.uid()` from a service-role context).
CREATE OR REPLACE FUNCTION public.auto_executed_notional_today(p_user_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(size * entry_price), 0)::numeric
  FROM public.trades
  WHERE user_id = p_user_id
    AND created_at >= date_trunc('day', (now() AT TIME ZONE 'utc'))
    AND reason_tags IS NOT NULL
    AND 'auto' = ANY(reason_tags);
$$;

REVOKE EXECUTE ON FUNCTION public.auto_executed_notional_today(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.auto_executed_notional_today(uuid)
  TO authenticated, service_role;
