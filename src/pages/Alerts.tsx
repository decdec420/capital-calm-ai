import { useMemo, useState } from "react";
import { AlertCircle, AlertTriangle, Info, Search, Trash2 } from "lucide-react";
import { useAlerts } from "@/hooks/useAlerts";
import { AlertCard } from "@/components/trader/AlertCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/trader/EmptyState";
import { cn } from "@/lib/utils";
import type { Alert, AlertSeverity } from "@/lib/domain-types";

/**
 * Group consecutive *info* alerts that share the same title into a single
 * card. Critical and warning alerts are never grouped — each one stays
 * individually visible and dismissable.
 */
type AlertGroup = { lead: Alert; members: Alert[] };

function groupAlerts(alerts: Alert[]): AlertGroup[] {
  const out: AlertGroup[] = [];
  for (const a of alerts) {
    const last = out[out.length - 1];
    const canMerge =
      last &&
      a.severity === "info" &&
      last.lead.severity === "info" &&
      last.lead.title === a.title;
    if (canMerge) {
      last.members.push(a);
    } else {
      out.push({ lead: a, members: [] });
    }
  }
  return out;
}

type FilterKey = "all" | AlertSeverity;

const FILTERS: { key: FilterKey; label: string; tone: string }[] = [
  { key: "all", label: "All", tone: "text-foreground" },
  { key: "critical", label: "Critical", tone: "text-status-blocked" },
  { key: "warning", label: "Warning", tone: "text-status-caution" },
  { key: "info", label: "Info", tone: "text-status-candidate" },
];

const ICON: Record<AlertSeverity, React.ReactNode> = {
  critical: <AlertCircle className="h-3.5 w-3.5" />,
  warning: <AlertTriangle className="h-3.5 w-3.5" />,
  info: <Info className="h-3.5 w-3.5" />,
};

export default function Alerts() {
  const { alerts, loading, dismiss } = useAlerts();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");
  const [bulkRunning, setBulkRunning] = useState(false);

  const dismissMany = async (ids: string[]) => {
    for (const id of ids) await dismiss(id).catch(() => {});
  };

  const counts = useMemo(() => {
    const c: Record<AlertSeverity, number> = { info: 0, warning: 0, critical: 0 };
    for (const a of alerts) c[a.severity] = (c[a.severity] ?? 0) + 1;
    return c;
  }, [alerts]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return alerts.filter((a) => {
      if (filter !== "all" && a.severity !== filter) return false;
      if (!q) return true;
      return (
        a.title.toLowerCase().includes(q) || a.message.toLowerCase().includes(q)
      );
    });
  }, [alerts, filter, query]);

  const dismissAllVisible = async () => {
    if (!filtered.length) return;
    setBulkRunning(true);
    try {
      for (const a of filtered) {
        await dismiss(a.id).catch(() => {});
      }
    } finally {
      setBulkRunning(false);
    }
  };

  return (
    <div className="space-y-4 p-4 md:p-6">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Alerts</h1>
          <p className="text-xs text-muted-foreground">
            System and trade notifications. Click any alert for context and a deep link.
          </p>
        </div>
        <div className="flex items-center gap-3 text-[11px] tabular">
          <span className="inline-flex items-center gap-1 text-status-blocked">
            <span className="h-1.5 w-1.5 rounded-full bg-status-blocked" />
            {counts.critical} critical
          </span>
          <span className="inline-flex items-center gap-1 text-status-caution">
            <span className="h-1.5 w-1.5 rounded-full bg-status-caution" />
            {counts.warning} warning
          </span>
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-status-candidate" />
            {counts.info} info
          </span>
        </div>
      </header>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1 panel p-1">
          {FILTERS.map((f) => {
            const isActive = filter === f.key;
            const n = f.key === "all" ? alerts.length : counts[f.key as AlertSeverity];
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={cn(
                  "px-2.5 py-1 text-xs rounded-sm transition-colors inline-flex items-center gap-1.5",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/40",
                )}
              >
                {f.key !== "all" && <span className={f.tone}>{ICON[f.key as AlertSeverity]}</span>}
                {f.label}
                <span className="text-[10px] text-muted-foreground tabular">{n}</span>
              </button>
            );
          })}
        </div>

        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search alerts…"
            className="pl-7 h-8 text-xs"
          />
        </div>

        <Button
          variant="outline"
          size="sm"
          disabled={!filtered.length || bulkRunning}
          onClick={dismissAllVisible}
          className="ml-auto"
        >
          <Trash2 className="h-3.5 w-3.5 mr-1.5" />
          Dismiss visible ({filtered.length})
        </Button>
      </div>

      <div className="space-y-2">
        {loading ? (
          <div className="panel p-6 text-xs text-muted-foreground italic">Loading alerts…</div>
        ) : filtered.length === 0 ? (
          <EmptyState
            title={alerts.length === 0 ? "No alerts" : "No alerts match this filter"}
            description={
              alerts.length === 0
                ? "Quiet is good. The desk has nothing to flag right now."
                : "Try a different severity or clear the search."
            }
          />
        ) : (
      groupAlerts(filtered).map((g) => (
            <AlertCard
              key={g.lead.id}
              alert={g.lead}
              groupCount={1 + g.members.length}
              groupMembers={g.members}
              onDismiss={(id) => dismiss(id)}
              onDismissGroup={(ids) => dismissMany(ids)}
            />
          ))
        )}
      </div>
    </div>
  );
}
