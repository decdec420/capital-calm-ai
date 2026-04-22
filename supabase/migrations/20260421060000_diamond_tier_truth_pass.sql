-- ============================================================
-- Diamond Tier — Truth Pass (Phase 0)
-- ============================================================
-- Removes demo/lies from handle_new_user.
-- New users now start with honest nulls/zeros so the UI renders
-- "—" instead of fabricated metrics.
--
-- Also enforces server-authoritative writes on money-critical
-- columns: only the service role (edge functions) may write
-- trades.exit_price, trades.pnl, trades.pnl_pct, trades.closed_at,
-- trades.outcome, and account_state.cash. The authenticated role
-- may still read them via existing policies.
-- ============================================================

-- ----------------------------------------------------------------
-- 1. Honest handle_new_user. Starter account row only. No demo
--    strategy, no seeded guardrails. Those are populated on first
--    real use (e.g. when a user names their first strategy).
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Profile
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1))
  );

  -- Account state at $0. User funds explicitly from UI or seed script.
  INSERT INTO public.account_state (
    user_id, equity, cash, start_of_day_equity, balance_floor
  ) VALUES (
    NEW.id, 0, 0, 0, 8  -- $8 kill-switch floor from doctrine
  );

  -- System state. Paper mode, paused, no fabricated latency.
  INSERT INTO public.system_state (user_id) VALUES (NEW.id);

  -- No seeded strategy. No seeded guardrails. The UI reads zeros
  -- and renders "—" via null-safe fallbacks.

  RETURN NEW;
END;
$function$;

-- ----------------------------------------------------------------
-- 2. Authoritative PnL / equity writes: authenticated role cannot
--    touch money columns directly. Only service_role (edge functions
--    using the service key) may update them.
-- ----------------------------------------------------------------

-- Trades: clients may still UPDATE notes, reason_tags, strategy_version,
-- etc. via their own policy, but not the computed money fields.
-- We implement this with a BEFORE UPDATE trigger that snapshots the
-- original values for any non-service caller.

CREATE OR REPLACE FUNCTION public.prevent_client_pnl_tamper()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := current_setting('request.jwt.claims', true)::jsonb->>'role';
BEGIN
  -- service_role bypass (edge functions + server-side scripts)
  IF v_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Revert any client attempt to mutate money columns
  NEW.exit_price   := OLD.exit_price;
  NEW.pnl          := OLD.pnl;
  NEW.pnl_pct      := OLD.pnl_pct;
  NEW.closed_at    := OLD.closed_at;
  NEW.outcome      := OLD.outcome;
  NEW.tp1_filled   := OLD.tp1_filled;
  NEW.original_size := OLD.original_size;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trades_prevent_client_pnl_tamper ON public.trades;
CREATE TRIGGER trades_prevent_client_pnl_tamper
BEFORE UPDATE ON public.trades
FOR EACH ROW EXECUTE FUNCTION public.prevent_client_pnl_tamper();

-- Account state: clients cannot directly edit cash / equity /
-- start_of_day_equity. Only service_role.
CREATE OR REPLACE FUNCTION public.prevent_client_balance_tamper()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := current_setting('request.jwt.claims', true)::jsonb->>'role';
BEGIN
  IF v_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  NEW.cash                 := OLD.cash;
  NEW.equity               := OLD.equity;
  NEW.start_of_day_equity  := OLD.start_of_day_equity;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS account_state_prevent_client_balance_tamper ON public.account_state;
CREATE TRIGGER account_state_prevent_client_balance_tamper
BEFORE UPDATE ON public.account_state
FOR EACH ROW EXECUTE FUNCTION public.prevent_client_balance_tamper();

-- ----------------------------------------------------------------
-- 3. Closed trades rollup view — feeds pattern memory in Phase 3.
--    Per user, per symbol, per regime (stored in context_snapshot).
--    Last 50 closed trades form the window.
-- ----------------------------------------------------------------
CREATE OR REPLACE VIEW public.closed_trades_rollup AS
WITH recent AS (
  SELECT
    user_id,
    symbol,
    side,
    pnl,
    pnl_pct,
    outcome,
    closed_at,
    ROW_NUMBER() OVER (PARTITION BY user_id, symbol ORDER BY closed_at DESC) AS rn
  FROM public.trades
  WHERE status = 'closed' AND closed_at IS NOT NULL
)
SELECT
  user_id,
  symbol,
  COUNT(*) FILTER (WHERE pnl IS NOT NULL) AS trade_count,
  COUNT(*) FILTER (WHERE pnl > 0) AS wins,
  COUNT(*) FILTER (WHERE pnl < 0) AS losses,
  COALESCE(AVG(pnl) FILTER (WHERE pnl IS NOT NULL), 0)::numeric AS avg_pnl,
  COALESCE(SUM(pnl) FILTER (WHERE pnl IS NOT NULL), 0)::numeric AS net_pnl,
  COALESCE(
    (COUNT(*) FILTER (WHERE pnl > 0))::numeric
    / NULLIF(COUNT(*) FILTER (WHERE pnl IS NOT NULL), 0),
    0
  )::numeric AS win_rate
FROM recent
WHERE rn <= 50
GROUP BY user_id, symbol;

-- Authenticated users can read their own rollup
GRANT SELECT ON public.closed_trades_rollup TO authenticated;

-- ----------------------------------------------------------------
-- 4. Strategy metrics: rebuild strategies.metrics from real closed
--    trades whenever a trade closes. Keeps the UI honest.
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recompute_strategy_metrics()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_metrics jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status <> 'closed' AND NEW.status = 'closed' AND NEW.strategy_id IS NOT NULL THEN
    SELECT jsonb_build_object(
      'trades', COUNT(*),
      'wins', COUNT(*) FILTER (WHERE pnl > 0),
      'losses', COUNT(*) FILTER (WHERE pnl < 0),
      'netPnl', COALESCE(SUM(pnl), 0),
      'avgPnl', COALESCE(AVG(pnl), 0),
      'expectancy', COALESCE(AVG(pnl), 0),
      'winRate', COALESCE((COUNT(*) FILTER (WHERE pnl > 0))::numeric / NULLIF(COUNT(*), 0), 0),
      'lastUpdatedAt', to_jsonb(now())
    )
    INTO v_metrics
    FROM public.trades
    WHERE strategy_id = NEW.strategy_id
      AND user_id = NEW.user_id
      AND status = 'closed';

    UPDATE public.strategies
    SET metrics = v_metrics, updated_at = now()
    WHERE id = NEW.strategy_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trades_recompute_strategy_metrics ON public.trades;
CREATE TRIGGER trades_recompute_strategy_metrics
AFTER UPDATE ON public.trades
FOR EACH ROW EXECUTE FUNCTION public.recompute_strategy_metrics();
