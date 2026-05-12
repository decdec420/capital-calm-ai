-- War Room triage: prune routine intel, keep all high-signal forever

CREATE OR REPLACE FUNCTION public.prune_war_room_routine_intel(cutoff_interval interval)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count integer;
BEGIN
  WITH del AS (
    DELETE FROM public.war_room_messages
    WHERE message_type = 'intel'
      AND priority IN ('normal', 'low')
      AND from_agent IN ('mafee', 'dollar_bill', 'hall')
      AND acted_on = false
      AND created_at < now() - cutoff_interval
    RETURNING 1
  )
  SELECT count(*) INTO deleted_count FROM del;
  RETURN deleted_count;
END;
$$;

-- One-time backfill: keep last 24h of routine intel as transition buffer
SELECT public.prune_war_room_routine_intel(interval '24 hours');

-- Ensure cron extension is enabled
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Remove any prior schedule with the same name, then schedule nightly sweep (04:00 UTC)
-- Keeps a 7-day debug window for any routine intel that slips through.
DO $$
BEGIN
  PERFORM cron.unschedule('war-room-routine-prune')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'war-room-routine-prune');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'war-room-routine-prune',
  '0 4 * * *',
  $cron$SELECT public.prune_war_room_routine_intel(interval '7 days');$cron$
);