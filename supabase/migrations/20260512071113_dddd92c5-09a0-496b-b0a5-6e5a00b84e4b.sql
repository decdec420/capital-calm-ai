REVOKE EXECUTE ON FUNCTION public.prune_war_room_routine_intel(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_war_room_routine_intel(interval) TO service_role;