ALTER TABLE public.broker_health
  ADD COLUMN IF NOT EXISTS status_metadata jsonb;

CREATE OR REPLACE FUNCTION public.update_broker_health(
  p_user_id uuid,
  p_status text,
  p_key_name text DEFAULT NULL,
  p_error text DEFAULT NULL,
  p_metadata jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('not_connected','healthy','auth_failed','unknown') THEN
    RAISE EXCEPTION 'invalid status: %', p_status;
  END IF;

  INSERT INTO public.broker_health (
    user_id, status, key_name,
    last_success_at, last_failure_at, last_error, status_metadata, updated_at
  ) VALUES (
    p_user_id, p_status, p_key_name,
    CASE WHEN p_status = 'healthy' THEN now() ELSE NULL END,
    CASE WHEN p_status = 'auth_failed' THEN now() ELSE NULL END,
    p_error,
    p_metadata,
    now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    status          = EXCLUDED.status,
    key_name        = COALESCE(EXCLUDED.key_name, broker_health.key_name),
    last_success_at = COALESCE(EXCLUDED.last_success_at, broker_health.last_success_at),
    last_failure_at = COALESCE(EXCLUDED.last_failure_at, broker_health.last_failure_at),
    last_error      = CASE WHEN EXCLUDED.status = 'healthy' THEN NULL ELSE EXCLUDED.last_error END,
    status_metadata = EXCLUDED.status_metadata,
    updated_at      = now();
END;
$$;

REVOKE ALL ON FUNCTION public.update_broker_health(uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_broker_health(uuid, text, text, text, jsonb) TO service_role;
