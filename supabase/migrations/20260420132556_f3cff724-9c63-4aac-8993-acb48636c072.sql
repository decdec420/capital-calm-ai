-- Trade closed alerts
CREATE OR REPLACE FUNCTION public.alert_on_trade_close()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  pnl_text TEXT;
  pnl_pct_text TEXT;
BEGIN
  IF (TG_OP = 'UPDATE' AND OLD.status <> 'closed' AND NEW.status = 'closed') THEN
    pnl_text := CASE
      WHEN NEW.pnl IS NULL THEN '0.00'
      WHEN NEW.pnl >= 0 THEN '+$' || to_char(NEW.pnl, 'FM999999990.00')
      ELSE '-$' || to_char(abs(NEW.pnl), 'FM999999990.00')
    END;
    pnl_pct_text := CASE
      WHEN NEW.pnl_pct IS NULL THEN ''
      WHEN NEW.pnl_pct >= 0 THEN ' (+' || to_char(NEW.pnl_pct, 'FM990.00') || '%)'
      ELSE ' (' || to_char(NEW.pnl_pct, 'FM990.00') || '%)'
    END;

    INSERT INTO public.alerts (user_id, severity, title, message)
    VALUES (
      NEW.user_id,
      'info',
      'Trade closed · ' || NEW.symbol,
      upper(NEW.side) || ' closed ' || pnl_text || pnl_pct_text || ' · ' || COALESCE(NEW.outcome, 'done')
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trades_alert_on_close ON public.trades;
CREATE TRIGGER trades_alert_on_close
AFTER UPDATE ON public.trades
FOR EACH ROW
EXECUTE FUNCTION public.alert_on_trade_close();

-- Guardrail level change alerts
CREATE OR REPLACE FUNCTION public.alert_on_guardrail_level_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (TG_OP = 'UPDATE' AND OLD.level IS DISTINCT FROM NEW.level) THEN
    IF NEW.level = 'caution' THEN
      INSERT INTO public.alerts (user_id, severity, title, message)
      VALUES (
        NEW.user_id,
        'warning',
        'Guardrail caution · ' || NEW.label,
        NEW.label || ' tripped to caution. Current ' || COALESCE(NEW.current_value, '?') || ' vs limit ' || COALESCE(NEW.limit_value, '?') || '.'
      );
    ELSIF NEW.level = 'blocked' THEN
      INSERT INTO public.alerts (user_id, severity, title, message)
      VALUES (
        NEW.user_id,
        'critical',
        'Guardrail BLOCKED · ' || NEW.label,
        NEW.label || ' is blocking trades. Current ' || COALESCE(NEW.current_value, '?') || ' vs limit ' || COALESCE(NEW.limit_value, '?') || '.'
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guardrails_alert_on_level_change ON public.guardrails;
CREATE TRIGGER guardrails_alert_on_level_change
AFTER UPDATE ON public.guardrails
FOR EACH ROW
EXECUTE FUNCTION public.alert_on_guardrail_level_change();

-- Kill-switch engaged alerts
CREATE OR REPLACE FUNCTION public.alert_on_kill_switch()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (TG_OP = 'UPDATE' AND OLD.kill_switch_engaged = false AND NEW.kill_switch_engaged = true) THEN
    INSERT INTO public.alerts (user_id, severity, title, message)
    VALUES (
      NEW.user_id,
      'critical',
      'Kill-switch ENGAGED',
      'Bot halted. No new orders will be placed until the kill-switch is disarmed.'
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS system_state_alert_on_kill_switch ON public.system_state;
CREATE TRIGGER system_state_alert_on_kill_switch
AFTER UPDATE ON public.system_state
FOR EACH ROW
EXECUTE FUNCTION public.alert_on_kill_switch();