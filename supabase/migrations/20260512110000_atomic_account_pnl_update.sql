-- Atomic account P&L update to prevent race conditions in mark-to-market.
--
-- mark-to-market runs every 15s and previously did a read-modify-write:
--   1. SELECT cash FROM account_state
--   2. newCash = cash + realizedDelta
--   3. UPDATE account_state SET cash = newCash, equity = newCash + unrealized
--
-- If two concurrent MTM ticks overlapped, the second write would overwrite the
-- first and one trade's realized P&L would be silently lost.
--
-- This function performs the cash increment and equity recompute atomically
-- inside a single UPDATE, eliminating the race window.

CREATE OR REPLACE FUNCTION update_account_pnl(
  p_user_id         uuid,
  p_realized_delta  numeric,
  p_unrealized_total numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- All right-hand-side expressions reference the row BEFORE the update,
  -- so (cash + p_realized_delta) uses the old cash value. Both columns
  -- compute consistently against the same snapshot.
  UPDATE account_state
  SET
    cash       = cash + p_realized_delta,
    equity     = (cash + p_realized_delta) + p_unrealized_total,
    updated_at = now()
  WHERE user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION update_account_pnl(uuid, numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION update_account_pnl(uuid, numeric, numeric) TO service_role;
