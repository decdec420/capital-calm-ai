import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useBrokerHealth } from "@/hooks/useBrokerHealth";
import { Button } from "@/components/ui/button";
import { AlertTriangle, X } from "lucide-react";

const DISMISS_KEY = "broker-reconnect-dismissed-until";

/**
 * Global banner that surfaces broker auth failures across the app.
 * Renders only when broker_health.status = 'auth_failed' and the user
 * hasn't dismissed within the last hour.
 */
export function BrokerReconnectBanner() {
  const { health } = useBrokerHealth();
  const navigate = useNavigate();
  const [, force] = useState(0);

  if (health.status !== "auth_failed") return null;

  const dismissedUntil = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
  if (Date.now() < dismissedUntil) return null;

  const onDismiss = () => {
    localStorage.setItem(DISMISS_KEY, String(Date.now() + 60 * 60 * 1000));
    force((n) => n + 1);
  };

  return (
    <div className="border-b border-status-blocked/30 bg-status-blocked/5">
      <div className="max-w-[1600px] mx-auto px-6 py-2.5 flex items-center gap-3">
        <AlertTriangle className="h-4 w-4 text-status-blocked shrink-0" />
        <div className="flex-1 min-w-0 text-xs">
          <span className="font-medium text-status-blocked">Broker authentication failed.</span>{" "}
          <span className="text-muted-foreground">
            Coinbase rejected the stored credentials — live trading and market reads are blocked until you reconnect.
          </span>
        </div>
        <Button size="sm" onClick={() => navigate("/settings#brokers")}>
          Reconnect
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss} aria-label="Dismiss for 1 hour">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
