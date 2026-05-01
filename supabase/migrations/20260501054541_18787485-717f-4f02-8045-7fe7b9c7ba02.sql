CREATE POLICY "telegram_bot_state_no_client_access"
  ON public.telegram_bot_state
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE public.telegram_bot_state IS
  'Service-role only. Tracks Telegram long-poll offset. Clients have no access (deny-all policy).';