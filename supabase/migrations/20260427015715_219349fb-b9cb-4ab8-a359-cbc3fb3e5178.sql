REVOKE EXECUTE ON FUNCTION public.get_daily_brief_cron_token() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_daily_brief_cron_token() TO service_role;