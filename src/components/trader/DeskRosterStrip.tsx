// DeskRosterStrip — Feature 6: Agent Portfolio / Strategy as team roster
// Shows each active strategy as a "desk role" card — Starter, Prospect, Benchwarmer.
// Inspired by the Billions team roster feel: names, grades, roles, win rates.

import { Link } from "react-router-dom";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { StrategyGradeBadge, computeStrategyScore } from "@/components/trader/StrategyGradeBadge";
import type { StrategyVersion } from "@/lib/domain-types";

const ROLE_META = {
  approved: {
    role:   "Starter",
    badge:  "safe" as const,
    pulse:  false,
  },
  candidate: {
    role:   "Prospect",
    badge:  "candidate" as const,
    pulse:  true,
  },
  archived: {
    role:   "Alumni",
    badge:  "blocked" as const,
    pulse:  false,
  },
} as const;

function displayNameFor(s: StrategyVersion): string {
  return s.displayName ?? `${s.name} ${s.version}`;
}

function RosterCard({ strategy }: { strategy: StrategyVersion }) {
  const meta    = ROLE_META[strategy.status];
  const m       = strategy.metrics;
  const trades  = m.trades ?? 0;
  const { grade, gradeColor } = computeStrategyScore(m);

  return (
    <div className="rounded-md border border-border/60 bg-card/50 p-3 space-y-2 min-w-[150px]">
      {/* Role badge */}
      <div className="flex items-center justify-between gap-1">
        <StatusBadge tone={meta.badge} size="sm" dot={meta.pulse} pulse={meta.pulse}>
          {meta.role}
        </StatusBadge>
        <span className={`text-base font-bold tabular ${gradeColor}`}>{grade}</span>
      </div>

      {/* Name */}
      <div>
        <div className="text-sm font-medium text-foreground leading-tight truncate">
          {displayNameFor(strategy)}
        </div>
        <div className="text-[10px] font-mono text-muted-foreground">
          {strategy.name} {strategy.version}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
        <div>
          <span className="text-muted-foreground">Win rate </span>
          <span className="text-foreground tabular">
            {trades === 0 ? "—" : `${(m.winRate * 100).toFixed(0)}%`}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">Exp </span>
          <span className="text-foreground tabular">
            {trades === 0 ? "—" : `${m.expectancy.toFixed(2)}R`}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">Trades </span>
          <span className="text-foreground tabular">{trades || "—"}</span>
        </div>
        <div>
          <span className="text-muted-foreground">DD </span>
          <span className="text-foreground tabular">
            {trades === 0 ? "—" : `${(m.maxDrawdown * 100).toFixed(0)}%`}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Shows approved + candidate strategies as team roster cards.
 * Appears on the Overview home screen.
 */
export function DeskRosterStrip({
  approved,
  candidates,
}: {
  approved: StrategyVersion | null;
  candidates: StrategyVersion[];
}) {
  // Show at most: 1 starter + 3 prospects
  const prospects = candidates.slice(0, 3);

  if (!approved && prospects.length === 0) return null;

  return (
    <div className="panel p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Strategy desk</div>
          <div className="text-sm font-medium text-foreground">Team roster</div>
        </div>
        <Link to="/strategy" className="text-xs text-primary hover:underline">
          Open Lab →
        </Link>
      </div>

      {/* Cards */}
      <div className="flex gap-3 overflow-x-auto pb-1 scrollbar-thin">
        {approved && <RosterCard key={approved.id} strategy={approved} />}
        {prospects.map((s) => (
          <RosterCard key={s.id} strategy={s} />
        ))}
      </div>

      {/* Grade key */}
      <div className="text-[10px] text-muted-foreground flex items-center gap-2 flex-wrap pt-0.5">
        <span>Grade key:</span>
        <span className="text-status-safe">A/A+</span><span>= strong edge</span>
        <span className="text-primary">B</span><span>= solid</span>
        <span className="text-status-caution">C</span><span>= borderline</span>
        <span className="text-status-blocked">D/F</span><span>= retire</span>
      </div>
    </div>
  );
}
