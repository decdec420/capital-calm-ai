import { StatusBadge } from "@/components/trader/StatusBadge";
import { useBrokerHealth } from "@/hooks/useBrokerHealth";
import { useSystemState } from "@/hooks/useSystemState";
import { cn } from "@/lib/utils";
import { AlertTriangle, ChevronRight, HeartPulse, Link2, ShieldAlert } from "lucide-react";
import { Link, useLocation } from "react-router-dom";

function relativeFromIso(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

export function SharedStatusStrip() {
  const { data: system, lastUpdatedAt } = useSystemState();
  const { health } = useBrokerHealth();
  const location = useLocation();

  const gateReasons = system?.lastEngineSnapshot?.gateReasons ?? [];
  const onRiskOrSettings = location.pathname.startsWith("/risk") || location.pathname.startsWith("/settings");

  return (
    <section className="border-b border-border bg-card/30 px-3 py-2">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-2 text-xs">
        <StatusBadge tone={system?.bot === "running" ? "safe" : system?.bot === "halted" ? "blocked" : "caution"} dot>
          bot {system?.bot ?? "booting"}
        </StatusBadge>
        <StatusBadge tone={system?.dataFeed === "connected" ? "safe" : "blocked"} dot>
          feed {system?.dataFeed ?? "—"}
        </StatusBadge>
        <StatusBadge tone={health.status === "healthy" ? "safe" : health.status === "not_connected" ? "caution" : "blocked"} dot>
          broker {health.status}
        </StatusBadge>
        <StatusBadge tone={gateReasons.length === 0 ? "safe" : "caution"}>
          <AlertTriangle className="h-3 w-3" />
          gates {gateReasons.length}
        </StatusBadge>
        {system?.killSwitchEngaged && (
          <StatusBadge tone="blocked" dot>
            <ShieldAlert className="h-3 w-3" /> kill-switch
          </StatusBadge>
        )}

        <span className="ml-auto text-muted-foreground">
          <HeartPulse className="mr-1 inline h-3 w-3" />system {relativeFromIso(lastUpdatedAt)}
        </span>
        <span className="text-muted-foreground">
          <Link2 className="mr-1 inline h-3 w-3" />broker {relativeFromIso(health.updatedAt ?? health.lastSuccessAt)}
        </span>

        <div className="flex items-center gap-1">
          <Link
            to="/risk"
            className="rounded-md border border-border px-2 py-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            Go to Risk
          </Link>
          <Link
            to="/settings#brokers"
            className="rounded-md border border-border px-2 py-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            Go to Broker Settings
          </Link>
          <Link
            to="/risk#gate-reasons"
            className={cn(
              "rounded-md border px-2 py-1 transition-colors",
              gateReasons.length > 0
                ? "border-status-caution/50 text-status-caution hover:text-status-caution"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            View Gate Reasons <ChevronRight className="ml-1 inline h-3 w-3" />
          </Link>
        </div>
      </div>
      {!onRiskOrSettings && (
        <p className="mx-auto mt-1 max-w-[1600px] text-[11px] text-muted-foreground">
          Read-only status strip. Use Risk Center or Settings for mutating controls.
        </p>
      )}
    </section>
  );
}
