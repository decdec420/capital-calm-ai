-- 1. trade_signals table
CREATE TABLE public.trade_signals (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  symbol TEXT NOT NULL DEFAULT 'BTC-USD',
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  confidence NUMERIC NOT NULL DEFAULT 0,
  setup_score NUMERIC NOT NULL DEFAULT 0,
  regime TEXT NOT NULL DEFAULT 'unknown',
  proposed_entry NUMERIC NOT NULL,
  proposed_stop NUMERIC,
  proposed_target NUMERIC,
  size_usd NUMERIC NOT NULL DEFAULT 0,
  size_pct NUMERIC NOT NULL DEFAULT 0,
  ai_reasoning TEXT NOT NULL DEFAULT '',
  ai_model TEXT NOT NULL DEFAULT 'google/gemini-3-flash-preview',
  context_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired','executed','halted')),
  decided_by TEXT CHECK (decided_by IN ('user','auto','expired','system')),
  decision_reason TEXT,
  executed_trade_id UUID,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '15 minutes'),
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.trade_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own signals select" ON public.trade_signals FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own signals insert" ON public.trade_signals FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own signals update" ON public.trade_signals FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "own signals delete" ON public.trade_signals FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX idx_trade_signals_user_status ON public.trade_signals(user_id, status, created_at DESC);
CREATE INDEX idx_trade_signals_pending ON public.trade_signals(user_id, expires_at) WHERE status = 'pending';

CREATE TRIGGER update_trade_signals_updated_at
  BEFORE UPDATE ON public.trade_signals
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. autonomy_level on system_state
ALTER TABLE public.system_state
  ADD COLUMN autonomy_level TEXT NOT NULL DEFAULT 'manual'
  CHECK (autonomy_level IN ('manual','assisted','autonomous'));

-- 3. Alert when a new pending signal is created
CREATE OR REPLACE FUNCTION public.alert_on_new_signal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (NEW.status = 'pending') THEN
    INSERT INTO public.alerts (user_id, severity, title, message)
    VALUES (
      NEW.user_id,
      'info',
      'Signal proposed · ' || NEW.symbol,
      upper(NEW.side) || ' @ ' || to_char(NEW.proposed_entry, 'FM999999990.00')
        || ' · confidence ' || to_char(NEW.confidence * 100, 'FM990') || '%'
        || ' · expires in 15m'
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trade_signals_alert_on_insert
  AFTER INSERT ON public.trade_signals
  FOR EACH ROW EXECUTE FUNCTION public.alert_on_new_signal();

-- 4. Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.trade_signals;
ALTER TABLE public.trade_signals REPLICA IDENTITY FULL;