CREATE INDEX IF NOT EXISTS idx_war_room_messages_user_unread
  ON public.war_room_messages (user_id, created_at DESC)
  WHERE read_by_bobby = false;

CREATE INDEX IF NOT EXISTS idx_war_room_messages_user_created
  ON public.war_room_messages (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bobby_directives_user_status
  ON public.bobby_directives (user_id, status, issued_at DESC);

CREATE INDEX IF NOT EXISTS idx_trade_signals_user_status
  ON public.trade_signals (user_id, status, created_at DESC);

ANALYZE public.war_room_messages;
ANALYZE public.bobby_directives;
ANALYZE public.trade_signals;