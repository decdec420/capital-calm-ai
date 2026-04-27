-- ============================================================
-- Security hardening: lock down SECURITY DEFINER functions and
-- fix realtime topic policy.
-- ============================================================

-- ── 1. upsert_copilot_memory: add ownership guard ─────────────
-- Both overloads. auth.uid() is NULL when called via service_role,
-- so we explicitly allow that path for the edge function caller.

CREATE OR REPLACE FUNCTION public.upsert_copilot_memory(
  p_user_id uuid, p_parameter text, p_direction text,
  p_from_value numeric, p_to_value numeric, p_outcome text,
  p_exp_delta numeric, p_win_rate_delta numeric,
  p_sharpe_delta numeric, p_drawdown_delta numeric,
  p_retry_after timestamp with time zone,
  p_experiment_id uuid DEFAULT NULL::uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_role text := current_setting('request.jwt.claims', true)::jsonb->>'role';
BEGIN
  -- Only the owner (via authenticated JWT) or service_role may write.
  IF v_role IS DISTINCT FROM 'service_role'
     AND (auth.uid() IS NULL OR auth.uid() <> p_user_id) THEN
    RAISE EXCEPTION 'Unauthorized: cannot write copilot memory for another user';
  END IF;

  INSERT INTO public.copilot_memory (
    user_id, parameter, direction, from_value, to_value,
    outcome, exp_delta, win_rate_delta, sharpe_delta, drawdown_delta,
    retry_after, experiment_id, attempt_count, last_tried_at
  ) VALUES (
    p_user_id, p_parameter, p_direction, p_from_value, p_to_value,
    p_outcome, p_exp_delta, p_win_rate_delta, p_sharpe_delta, p_drawdown_delta,
    p_retry_after, p_experiment_id, 1, now()
  )
  ON CONFLICT (user_id, parameter, direction) DO UPDATE SET
    attempt_count = public.copilot_memory.attempt_count + 1,
    last_tried_at = now(),
    from_value = EXCLUDED.from_value,
    to_value = EXCLUDED.to_value,
    outcome = EXCLUDED.outcome,
    exp_delta = EXCLUDED.exp_delta,
    win_rate_delta = EXCLUDED.win_rate_delta,
    sharpe_delta = EXCLUDED.sharpe_delta,
    drawdown_delta = EXCLUDED.drawdown_delta,
    retry_after = EXCLUDED.retry_after,
    experiment_id = COALESCE(EXCLUDED.experiment_id, public.copilot_memory.experiment_id),
    updated_at = now();
END;
$function$;

CREATE OR REPLACE FUNCTION public.upsert_copilot_memory(
  p_user_id uuid, p_parameter text, p_direction text,
  p_from_value numeric, p_to_value numeric, p_outcome text,
  p_exp_delta numeric, p_win_rate_delta numeric,
  p_sharpe_delta numeric, p_drawdown_delta numeric,
  p_retry_after timestamp with time zone,
  p_experiment_id uuid DEFAULT NULL::uuid,
  p_symbol text DEFAULT 'ALL'::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_role text := current_setting('request.jwt.claims', true)::jsonb->>'role';
BEGIN
  IF v_role IS DISTINCT FROM 'service_role'
     AND (auth.uid() IS NULL OR auth.uid() <> p_user_id) THEN
    RAISE EXCEPTION 'Unauthorized: cannot write copilot memory for another user';
  END IF;

  INSERT INTO public.copilot_memory (
    user_id, parameter, direction, symbol,
    from_value, to_value,
    outcome, exp_delta, win_rate_delta, sharpe_delta, drawdown_delta,
    retry_after, experiment_id, attempt_count, last_tried_at
  ) VALUES (
    p_user_id, p_parameter, p_direction, COALESCE(p_symbol, 'ALL'),
    p_from_value, p_to_value,
    p_outcome, p_exp_delta, p_win_rate_delta, p_sharpe_delta, p_drawdown_delta,
    p_retry_after, p_experiment_id, 1, now()
  )
  ON CONFLICT (user_id, parameter, direction, symbol) DO UPDATE SET
    attempt_count = public.copilot_memory.attempt_count + 1,
    last_tried_at = now(),
    from_value = EXCLUDED.from_value,
    to_value = EXCLUDED.to_value,
    outcome = EXCLUDED.outcome,
    exp_delta = EXCLUDED.exp_delta,
    win_rate_delta = EXCLUDED.win_rate_delta,
    sharpe_delta = EXCLUDED.sharpe_delta,
    drawdown_delta = EXCLUDED.drawdown_delta,
    retry_after = EXCLUDED.retry_after,
    experiment_id = COALESCE(EXCLUDED.experiment_id, public.copilot_memory.experiment_id),
    updated_at = now();
END;
$function$;

-- ── 2. Revoke EXECUTE from anon/authenticated on sensitive
-- SECURITY DEFINER functions. These are only meant to be called
-- by triggers, cron jobs (service_role), or edge functions
-- (service_role). None should ever be RPC-callable by clients.

-- Cron token getters — leak vault secrets if callable!
REVOKE EXECUTE ON FUNCTION public.get_activate_doctrine_changes_cron_token() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_daily_brief_cron_token()             FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_evaluate_candidate_cron_token()      FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_jessica_cron_token()                 FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_journal_digest_cron_token()          FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_katrina_cron_token()                 FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_mark_to_market_cron_token()          FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_post_trade_learn_token()             FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_rollover_day_cron_token()            FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_signal_engine_cron_token()           FROM PUBLIC, anon, authenticated;

-- Internal helpers / writers — service_role only
REVOKE EXECUTE ON FUNCTION public.append_audit_log(uuid, text, text, uuid, text, numeric, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_telegram(uuid, text, text, text, text)                  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_and_increment_rate_limit(uuid, text, integer, integer)   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_jessica_heartbeat()                                       FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.users_on_profile(text)                                          FROM PUBLIC, anon, authenticated;

-- upsert_copilot_memory (both overloads) — guarded internally,
-- but also revoke from anon to fail-fast on unauth callers.
REVOKE EXECUTE ON FUNCTION public.upsert_copilot_memory(uuid, text, text, numeric, numeric, text, numeric, numeric, numeric, numeric, timestamp with time zone, uuid)        FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.upsert_copilot_memory(uuid, text, text, numeric, numeric, text, numeric, numeric, numeric, numeric, timestamp with time zone, uuid, text)  FROM PUBLIC, anon;

-- realized_pnl_today: read-only owner data; allow authenticated
-- but it already filters by p_user_id parameter — tighten to require self.
-- Simpler: revoke from anon, leave for authenticated (it returns numeric for any uuid,
-- which is an info leak). Wrap with guard.
CREATE OR REPLACE FUNCTION public.realized_pnl_today(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_role text := current_setting('request.jwt.claims', true)::jsonb->>'role';
BEGIN
  IF v_role IS DISTINCT FROM 'service_role'
     AND (auth.uid() IS NULL OR auth.uid() <> p_user_id) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  RETURN COALESCE((
    SELECT SUM(pnl)
    FROM public.trades
    WHERE user_id = p_user_id
      AND closed_at IS NOT NULL
      AND closed_at >= date_trunc('day', (now() AT TIME ZONE 'utc'))
  ), 0)::numeric;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.realized_pnl_today(uuid) FROM PUBLIC, anon;

-- ── 3. Realtime topic policy: tighten LIKE pattern to a strict
-- prefix match so users cannot subscribe to topics that merely
-- contain another user's UUID as a substring.

DROP POLICY IF EXISTS "own user topic select" ON realtime.messages;
DROP POLICY IF EXISTS "own user topic insert" ON realtime.messages;

CREATE POLICY "own user topic select"
  ON realtime.messages
  FOR SELECT
  TO authenticated
  USING (
    (auth.uid() IS NOT NULL)
    AND (
      realtime.topic() LIKE (auth.uid()::text || ':%')
      OR realtime.topic() = auth.uid()::text
    )
  );

CREATE POLICY "own user topic insert"
  ON realtime.messages
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (auth.uid() IS NOT NULL)
    AND (
      realtime.topic() LIKE (auth.uid()::text || ':%')
      OR realtime.topic() = auth.uid()::text
    )
  );
