import { Wifi, WifiOff, AlertTriangle } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import type { ConnectionState } from "@/lib/domain-types";

/**
 * Inline broker connection pill for action pages (Overview, Trades) where
 * someone might actually decide to fire an order. The TopBar shows broker
 * state too, but only above md breakpoint and easy to gloss over — this
 * one sits right under the SectionHeader so it can't be missed.
 *
 * When `liveArmed` is true and the broker is not connected, also surface
 * a one-line warning that real orders will fail. This catches the
 * footgun where someone arms live mode then forgets the broker isn't wired.
 */
export function BrokerStatusInline({
  connection,
  liveArmed,
}: {
  connection: ConnectionState;
  liveArmed: boolean;
}) {
  // Until a real broker integration ships, EVERY trade is paper. Showing
  // "Broker: Connected" reads as a hardcoded DB default lie. Until P4-E
  // wires real broker keys via Vault, this badge always reads "Paper Mode".
  const meta = {
    icon: <Wifi className="h-3.5 w-3.5" />,
    label: "Paper Mode · no broker",
    cls: "border-status-caution/30 bg-status-caution/10 text-status-caution",
  };
  // connection arg retained for future wiring (real broker integration).
  void connection;

  return (
    <div className="space-y-2 -mt-2">
      <Link
        to="/settings"
        aria-label={`${meta.label}. Open settings.`}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
          "transition-opacity hover:opacity-80 outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
          meta.cls,
        )}
      >
        {meta.icon}
        <span className="tabular">{meta.label}</span>
      </Link>

      {showWarning && (
        <div className="flex items-start gap-2 rounded-md border border-status-blocked/30 bg-status-blocked/5 px-3 py-2 text-xs text-status-blocked">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            Live trading is armed but the broker is not connected — orders will fail.
          </span>
        </div>
      )}
    </div>
  );
}
