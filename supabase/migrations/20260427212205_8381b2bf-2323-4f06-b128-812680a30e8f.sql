-- Lock down remaining SECURITY DEFINER functions: revoke EXECUTE
-- from anon and authenticated. They will still fire as triggers
-- (triggers run regardless of grants) and remain callable by
-- service_role / postgres for edge functions and cron.

REVOKE EXECUTE ON FUNCTION public.alert_on_guardrail_level_change() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.alert_on_kill_switch()             FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.alert_on_new_signal()              FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.alert_on_trade_close()             FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.audit_log_immutable_guard()        FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user()                  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.invoke_post_trade_learn()          FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.touch_conversation_on_message()    FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.realized_pnl_today(uuid)           FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.upsert_copilot_memory(uuid, text, text, numeric, numeric, text, numeric, numeric, numeric, numeric, timestamp with time zone, uuid)        FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.upsert_copilot_memory(uuid, text, text, numeric, numeric, text, numeric, numeric, numeric, numeric, timestamp with time zone, uuid, text)  FROM PUBLIC, anon, authenticated;
