-- ============================================================
-- Phase 2 — Server-Authoritative Execution
-- ============================================================
-- The Phase 0 truth-pass migration locked down:
--   trades: exit_price, pnl, pnl_pct, closed_at, outcome,
--           tp1_filled, original_size
--   account_state: cash, equity, start_of_day_equity
--
-- But mark-to-market and lifecycle advancement were still
-- running in the browser. This migration extends the
-- trades trigger so that non-service callers also can't
-- mutate:
--   current_price, unrealized_pnl, unrealized_pnl_pct,
--   stop_loss, take_profit, tp1_price, size,
--   lifecycle_phase, lifecycle_transitions, strategy_id,
--   strategy_version
--
-- Clients can still UPDATE notes and reason_tags (operator
-- annotations are fair game). Everything else is
-- service-role-only.
-- ============================================================

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

  -- Money / realized outcome — never client-writable.
  NEW.exit_price         := OLD.exit_price;
  NEW.pnl                := OLD.pnl;
  NEW.pnl_pct            := OLD.pnl_pct;
  NEW.closed_at          := OLD.closed_at;
  NEW.outcome            := OLD.outcome;

  -- Unrealized PnL is recomputed by the mark-to-market edge function.
  NEW.current_price      := OLD.current_price;
  NEW.unrealized_pnl     := OLD.unrealized_pnl;
  NEW.unrealized_pnl_pct := OLD.unrealized_pnl_pct;

  -- Risk parameters — only the server can ratchet stops or rewrite TP.
  NEW.stop_loss          := OLD.stop_loss;
  NEW.take_profit        := OLD.take_profit;
  NEW.tp1_price          := OLD.tp1_price;

  -- Position size / ladder — only the server can close half at TP1, etc.
  NEW.size               := OLD.size;
  NEW.original_size      := OLD.original_size;
  NEW.tp1_filled         := OLD.tp1_filled;

  -- Identity / lineage columns — client can't forge strategy attribution.
  NEW.strategy_id        := OLD.strategy_id;
  NEW.strategy_version   := OLD.strategy_version;

  -- Lifecycle advancement is server-only.
  NEW.lifecycle_phase    := OLD.lifecycle_phase;
  NEW.lifecycle_transitions := OLD.lifecycle_transitions;

  -- Status transitions happen server-side too (trade-close edge function).
  NEW.status             := OLD.status;

  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------
-- pg_cron: mark-to-market every 15 seconds for all running bots.
-- The edge function reads the vault token, so rotating it is a
-- matter of updating the vault + this job.
-- ----------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Store / rotate a cron token in Vault. The edge function compares
-- the header against this value to accept the cron invocation.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.secrets WHERE name = 'mark_to_market_cron_token'
  ) THEN
    PERFORM vault.create_secret(
      encode(gen_random_bytes(32), 'hex'),
      'mark_to_market_cron_token',
      'mark-to-market cron invocation token'
    );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.get_mark_to_market_cron_token()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, vault
AS $$
  SELECT decrypted_secret
  FROM vault.decrypted_secrets
  WHERE name = 'mark_to_market_cron_token'
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_mark_to_market_cron_token() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_mark_to_market_cron_token() TO service_role;

-- Schedule (commented until the edge function URL is wired in env).
-- SELECT cron.schedule(
--   'mark-to-market',
--   '*/15 * * * * *',  -- every 15s (pg_cron 1.6+)
--   $$SELECT net.http_post(
--       url := current_setting('app.mark_to_market_url', true),
--       headers := jsonb_build_object(
--         'Authorization', 'Bearer ' || public.get_mark_to_market_cron_token(),
--         'Content-Type', 'application/json'
--       ),
--       body := jsonb_build_object('cronAll', true)
--     )$$
-- );
