import { cn } from "@/lib/utils";
import { StatusBadge } from "./StatusBadge";
import type { JournalEntry } from "@/lib/domain-types";
import { ReasonChip } from "./ReasonChip";

const kindTone = {
  research: "candidate",
  trade: "safe",
  learning: "accent",
  skip: "caution",
  daily: "neutral",
  postmortem: "blocked",
} as const;

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function JournalEventCard({ entry, className }: { entry: JournalEntry; className?: string }) {
  return (
    <div className={cn("panel p-4 space-y-2 hover:border-border/80 transition-colors", className)}>
      <div className="flex items-center justify-between gap-2">
        <StatusBadge tone={kindTone[entry.kind]} size="sm">
          {entry.kind}
        </StatusBadge>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground tabular">
          {timeAgo(entry.timestamp)}
        </span>
      </div>
      <p className="text-sm font-medium text-foreground">{entry.title}</p>
      <p className="text-xs text-muted-foreground leading-relaxed">{entry.summary}</p>
      {entry.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {entry.tags.map((t) => (
            <ReasonChip key={t} label={t} />
          ))}
        </div>
      )}
      {entry.llmExplanation && (
        <div className="mt-2 pt-2 border-t border-border">
          <p className="text-[10px] uppercase tracking-wider text-primary/80 mb-1">Copilot note</p>
          <p className="text-xs text-muted-foreground italic leading-relaxed">{entry.llmExplanation}</p>
        </div>
      )}
    </div>
  );
}
