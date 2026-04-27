CREATE OR REPLACE FUNCTION public.check_jessica_heartbeat()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row         RECORD;
  v_ran_at      timestamptz;
  v_age_minutes int;
  v_status      text;
  v_error       text;
  v_intentional boolean;
BEGIN
  FOR v_row IN
    SELECT user_id, last_jessica_decision, bot, kill_switch_engaged
    FROM public.system_state
    WHERE user_id IS NOT NULL
  LOOP
    v_intentional := COALESCE(v_row.kill_switch_engaged, false)
                     OR v_row.bot = 'paused';

    v_ran_at := NULLIF(v_row.last_jessica_decision->>'ran_at', '')::timestamptz;

    IF v_ran_at IS NULL THEN
      v_age_minutes := 9999;
    ELSE
      v_age_minutes := EXTRACT(EPOCH FROM (now() - v_ran_at))::int / 60;
    END IF;

    -- Tolerant thresholds: cron runs every minute, watchdog every 3.
    -- 8 minutes covers 2 missed ticks plus jitter. When the bot is
    -- intentionally idle (paused / kill-switch) we mark degraded but
    -- never raise a critical alert — that's an operator state, not an outage.
    IF v_intentional THEN
      IF v_age_minutes > 8 THEN
        v_status := 'degraded';
        v_error  := format(
          'Jessica heartbeat is %s minutes old, but bot is intentionally idle (kill-switch=%s, bot=%s).',
          v_age_minutes, v_row.kill_switch_engaged, v_row.bot
        );
      ELSE
        v_status := 'healthy';
        v_error  := NULL;
      END IF;
    ELSE
      IF v_ran_at IS NULL THEN
        v_status := 'failed';
        v_error  := 'Jessica has never recorded a decision — cron may not be running.';
      ELSIF v_age_minutes > 8 THEN
        v_status := 'failed';
        v_error  := format('Jessica has not ticked in %s minutes — cron may be down.', v_age_minutes);
      ELSE
        v_status := 'healthy';
        v_error  := NULL;
      END IF;
    END IF;

    INSERT INTO public.agent_health (
      user_id, agent_name, status, last_success, last_failure,
      failure_count, last_error, checked_at
    ) VALUES (
      v_row.user_id,
      'jessica_heartbeat',
      v_status,
      CASE WHEN v_status = 'healthy' THEN now() ELSE NULL END,
      CASE WHEN v_status = 'failed'  THEN now() ELSE NULL END,
      CASE WHEN v_status = 'failed'  THEN 1 ELSE 0 END,
      v_error,
      now()
    )
    ON CONFLICT (user_id, agent_name) DO UPDATE SET
      status        = EXCLUDED.status,
      last_success  = COALESCE(EXCLUDED.last_success,  agent_health.last_success),
      last_failure  = COALESCE(EXCLUDED.last_failure,  agent_health.last_failure),
      failure_count = CASE
                        WHEN EXCLUDED.status = 'failed'
                          THEN agent_health.failure_count + 1
                        ELSE 0
                      END,
      last_error    = EXCLUDED.last_error,
      checked_at    = EXCLUDED.checked_at;

    -- Only alert on true outages, not operator-intended idle states.
    IF v_status = 'failed' THEN
      INSERT INTO public.alerts (user_id, severity, title, message)
      SELECT
        v_row.user_id,
        'critical',
        'Jessica heartbeat lost',
        COALESCE(v_error, 'Jessica is not ticking.')
      WHERE NOT EXISTS (
        SELECT 1 FROM public.alerts
        WHERE user_id = v_row.user_id
          AND title = 'Jessica heartbeat lost'
          AND created_at > now() - interval '30 minutes'
      );
    END IF;
  END LOOP;
END;
$function$;