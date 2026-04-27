-- api_rate_limits — sliding-window per-user rate limit counters.
-- One row per (user, function). Updated atomically by check_and_increment_rate_limit().
CREATE TABLE IF NOT EXISTS public.api_rate_limits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  function_name text NOT NULL,
  window_start  timestamptz NOT NULL DEFAULT now(),
  request_count int NOT NULL DEFAULT 1,
  UNIQUE (user_id, function_name)
);

CREATE INDEX IF NOT EXISTS api_rate_limits_user_fn_idx
  ON public.api_rate_limits(user_id, function_name);

ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;

-- Users can read their own counters (informational). No write policies — only
-- the service role (used by the RPC / edge functions) may mutate.
DROP POLICY IF EXISTS "Users read own rate limits" ON public.api_rate_limits;
CREATE POLICY "Users read own rate limits"
  ON public.api_rate_limits FOR SELECT
  USING (auth.uid() = user_id);

-- Atomic check-and-increment. Uses INSERT ... ON CONFLICT ... DO UPDATE so the
-- row is created or updated in a single statement, eliminating the read-then-
-- write race. The CASE expressions reset the window when expired and only
-- increment when still under the limit.
CREATE OR REPLACE FUNCTION public.check_and_increment_rate_limit(
  p_user_id        uuid,
  p_function_name  text,
  p_max_requests   int,
  p_window_seconds int
)
RETURNS TABLE (allowed boolean, remaining int, reset_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now           timestamptz := now();
  v_window        interval    := make_interval(secs => p_window_seconds);
  v_window_start  timestamptz;
  v_count         int;
  v_allowed       boolean;
BEGIN
  INSERT INTO public.api_rate_limits AS r (user_id, function_name, window_start, request_count)
  VALUES (p_user_id, p_function_name, v_now, 1)
  ON CONFLICT (user_id, function_name) DO UPDATE
  SET
    window_start = CASE
      WHEN r.window_start < v_now - v_window THEN v_now
      ELSE r.window_start
    END,
    request_count = CASE
      WHEN r.window_start < v_now - v_window THEN 1
      WHEN r.request_count < p_max_requests THEN r.request_count + 1
      ELSE r.request_count
    END
  RETURNING r.window_start, r.request_count INTO v_window_start, v_count;

  v_allowed := v_count <= p_max_requests;

  RETURN QUERY SELECT
    v_allowed,
    GREATEST(p_max_requests - v_count, 0),
    v_window_start + v_window;
END;
$$;

REVOKE ALL ON FUNCTION public.check_and_increment_rate_limit(uuid, text, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_and_increment_rate_limit(uuid, text, int, int) TO service_role;