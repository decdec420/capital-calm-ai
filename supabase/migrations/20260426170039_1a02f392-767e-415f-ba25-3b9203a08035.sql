-- Drop the duplicate mark-to-market cron job. Keep the canonical
-- 'mark-to-market-15s' job (jobid 5) and unschedule the duplicate
-- 'mark-to-market' job (jobid 8) so the function isn't double-fired.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cron.job
    WHERE jobname = 'mark-to-market'
      AND schedule = '15 seconds'
  ) THEN
    PERFORM cron.unschedule('mark-to-market');
  END IF;
END $$;