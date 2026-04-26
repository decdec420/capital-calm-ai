-- ============================================================
-- PR #3 — Visible safety controls
-- ------------------------------------------------------------
-- Adds the live-money acknowledgment timestamp + the trigger
-- that enforces it server-side.
--
--   P1-C   Gate live_trading_enabled behind a one-time
--          live_money_acknowledged_at signature. Browser flow
--          opens an acknowledgment dialog; this trigger is the
--          backstop that refuses the write if a client bypasses
--          the UI.
--
-- Idempotent. Safe to re-apply.
-- ============================================================

-- ─── Column ──────────────────────────────────────────────────────
ALTER TABLE public.system_state
  ADD COLUMN IF NOT EXISTS live_money_acknowledged_at timestamptz NULL;

COMMENT ON COLUMN public.system_state.live_money_acknowledged_at IS
  'Set the first time the operator signs the live-money acknowledgment.
   Required to be non-null before live_trading_enabled can flip true.
   Cleared only via service_role.';

-- ─── Acknowledge RPC (browser-callable) ──────────────────────────
--
-- Browser writes the timestamp through this RPC instead of an UPDATE
-- so the column itself can be locked down to service_role-only writes
-- via a future trigger if we ever want stricter control. For now the
-- write goes through Supabase RLS (own-row only); the RPC just gives
-- us a stable contract.
CREATE OR REPLACE FUNCTION public.acknowledge_live_money()
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_at  timestamptz := now();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'acknowledge_live_money() requires an authenticated caller';
  END IF;

  UPDATE public.system_state
  SET    live_money_acknowledged_at = v_at,
         updated_at = v_at
  WHERE  user_id = v_uid;

  RETURN v_at;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.acknowledge_live_money() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.acknowledge_live_money() TO authenticated;

-- ─── BEFORE UPDATE trigger: enforce the gate server-side ─────────
--
-- Defense-in-depth on top of the UI dialog. If `live_trading_enabled`
-- is being flipped from false → true and the row has never been
-- acknowledged, raise. Service role bypasses (cron paths still need
-- to be able to flip the flag during emergency rollbacks).
CREATE OR REPLACE FUNCTION public.system_state_live_money_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := current_setting('request.jwt.claims', true)::jsonb->>'role';
BEGIN
  -- Service role always passes. Cron + admin operations stay free.
  IF v_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Only check on the false → true edge.
  IF (OLD.live_trading_enabled IS DISTINCT FROM NEW.live_trading_enabled)
     AND NEW.live_trading_enabled = TRUE
     AND NEW.live_money_acknowledged_at IS NULL THEN
    RAISE EXCEPTION
      'live_trading_enabled cannot turn on without live_money_acknowledged_at — call acknowledge_live_money() first';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_system_state_live_money_gate ON public.system_state;
CREATE TRIGGER trg_system_state_live_money_gate
  BEFORE UPDATE ON public.system_state
  FOR EACH ROW
  EXECUTE FUNCTION public.system_state_live_money_gate();
