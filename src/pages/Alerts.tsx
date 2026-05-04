import { useMemo, useState } from "react";
import { AlertCircle, AlertTriangle, Info, Search, Trash2, Users2 } from "lucide-react";
import { useAlerts } from "@/hooks/useAlerts";
import { useSystemState } from "@/hooks/useSystemState";
import { AlertCard } from "@/components/trader/AlertCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/trader/EmptyState";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { cn } from "@/lib/utils";
import { Link } from "react-router-dom";
import type { Alert, AlertSeverity } from "@/lib/domain-types";

// ─── grouping (unchanged) ─────────────────────────────────────────────────────

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

// ─── severity → P-tier label ──────────────────────────────────────────────────

const SEV_LABEL: Record<AlertSeverity, string> = {
  critical: "P1",
  warning:  "P2",
  info:     "P3/P4",
};

const FILTERS: { key: FilterKey; label: string; dotClass: string }[] = [
  { key: "all",      label: "All",      dotClass: "bg-muted-foreground/40" },
  { key: "critical", label: "P1 Critical", dotClass: "bg-status-blocked" },
  { key: "warning",  label: "P2 Major",   dotClass: "bg-status-caution" },
  { key: "info",     label: "P3/P4",      dotClass: "bg-status-candidate" },
];

// ─── ops-center summary strip ─────────────────────────────────────────────────

function OpsSummaryStrip({
  counts,
  system,
}: {
  counts: Record<AlertSeverity, number>;
  system: ReturnType<typeof useSystemState>["data"];
}) {
  return (
    <div className="panel p-4 flex flex-wrap items-center gap-x-6 gap-y-3">
      {/* P1 */}
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "h-8 w-8 rounded-md flex items-center justify-center shrink-0",
            counts.critical > 0
              ? "bg-status-blocked/15 text-status-blocked"
              : "bg-secondary text-muted-foreground",
          )}
        >
          <AlertCircle className="h-4 w-4" />
        </span>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">P1 Critical</div>
          <div
            className={cn(
              "text-lg font-semibold font-mono",
              counts.critical > 0 ? "text-status-blocked" : "text-muted-foreground",
            )}
          >
            {counts.critical}
          </div>
        </div>
      </div>

      <div className="h-8 w-px bg-border hidden md:block" />

      {/* P2 */}
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "h-8 w-8 rounded-md flex items-center justify-center shrink-0",
            counts.warning > 0
              ? "bg-status-caution/15 text-status-caution"
              : "bg-secondary text-muted-foreground",
          )}
        >
          <AlertTriangle className="h-4 w-4" />
        </span>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">P2 Major</div>
          <div
            className={cn(
              "text-lg font-semibold font-mono",
              counts.warning > 0 ? "text-status-caution" : "text-muted-foreground",
            )}
          >
            {counts.warning}
          </div>
        </div>
      </div>

      <div className="h-8 w-px bg-border hidden md:block" />

      {/* P3/P4 */}
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "h-8 w-8 rounded-md flex items-center justify-center shrink-0",
            counts.info > 0
              ? "bg-status-candidate/15 text-status-candidate"
              : "bg-secondary text-muted-foreground",
          )}
        >
          <Info className="h-4 w-4" />
        </span>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">P3/P4 Info</div>
          <div
            className={cn(
              "text-lg font-semibold font-mono",
              counts.info > 0 ? "text-status-candidate" : "text-muted-foreground",
            )}
          >
            {counts.info}
          </div>
        </div>
      </div>

      <div className="h-8 w-px bg-border hidden md:block" />

      {/* System health snapshot */}
      <div className="flex flex-col gap-1">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">System</div>
        <div className="flex items-center gap-3 text-[11px] font-mono">
          <span>
            Bot{" "}
            <span
              className={cn(
                system?.bot === "running"
                  ? "text-status-safe"
                  : system?.bot === "halted"
                    ? "text-status-blocked"
                    : "text-status-caution",
              )}
            >
              {system?.bot ?? "—"}
            </span>
          </span>
          <span>
            Feed{" "}
            <span
              className={
                system?.dataFeed === "connected" ? "text-status-safe" : "text-status-blocked"
              }
            >
              {system?.dataFeed ?? "—"}
            </span>
          </span>
          <span>
            KS{" "}
            <span
              className={
                system?.killSwitchEngaged ? "text-status-blocked" : "text-muted-foreground"
              }
            >
              {system?.killSwitchEngaged ? "ENGAGED" : "off"}
            </span>
          </span>
        </div>
      </div>

      {/* Spacer + Company link */}
      <div className="flex-1" />
      <Link
        to="/company"
        className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
      >
        <Users2 className="h-3.5 w-3.5" />
        View agent roster →
      </Link>
    </div>
  );
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default function Alerts() {
  const { alerts, loading, dismiss } = useAlerts();
  const { data: system } = useSystemState();
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
      return a.title.toLowerCase().includes(q) || a.message.toLowerCase().includes(q);
    });
  }, [alerts, filter, query]);

  // Sort: critical first, then warning, then info
  const sortedFiltered = useMemo(() => {
    const SEV_ORDER: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
    return [...filtered].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  }, [filtered]);

  const dismissAllVisible = async () => {
    if (!filtered.length) return;
    setBulkRunning(true);
    try {
      for (const a of filtered) await dismiss(a.id).catch(() => {});
    } finally {
      setBulkRunning(false);
    }
  };

  return (
    <div className="space-y-5 animate-fade-in">
      <SectionHeader
        eyebrow="Risk Center"
        title="Alerts"
        description="Operations center. P1 incidents surface first. Every alert shows who owns it and what to do."
      />

      {/* Ops summary strip */}
      <OpsSummaryStrip counts={counts} system={system} />

      {/* Filter + search bar */}
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
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/40",
                )}
              >
                <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", f.dotClass)} />
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
            placeholder="Search by title or message…"
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

      {/* Alert list */}
      <div className="space-y-2">
        {loading ? (
          <div className="panel p-6 text-xs text-muted-foreground italic">Loading alerts…</div>
        ) : sortedFiltered.length === 0 ? (
          <EmptyState
            title={alerts.length === 0 ? "Ops center clear" : "No alerts match this filter"}
            description={
              alerts.length === 0
                ? "No active incidents. All agents reporting nominal."
                : "Try a different severity filter or clear the search."
            }
          />
        ) : (
          groupAlerts(sortedFiltered).map((g) => (
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

