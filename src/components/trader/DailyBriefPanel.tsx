import { useDailyBrief, type SessionBias } from "@/hooks/useDailyBrief";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { AlertTriangle, Eye, RefreshCw, Sparkles, Sun } from "lucide-react";
import { toast } from "sonner";

const BIAS_META: Record<
  SessionBias,
  { label: string; tone: "safe" | "caution" | "blocked" | "candidate"; icon: typeof Sun }
> = {
  risk_on:  { label: "Risk-on",  tone: "safe",      icon: Sun },
  risk_off: { label: "Risk-off", tone: "blocked",   icon: AlertTriangle },
  neutral:  { label: "Neutral",  tone: "candidate", icon: Eye },
  caution:  { label: "Caution",  tone: "caution",   icon: AlertTriangle },
};

function fmtPrice(n: number | null): string {
  if (n == null) return "—";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function relativeAge(iso: string | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function DailyBriefPanel() {
  const { brief, loading, generating, generate, isToday } = useDailyBrief();

  const handleGenerate = async () => {
    try {
      await generate();
      toast.success("Pre-market brief refreshed.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't generate brief.");
    }
  };

  const meta = brief ? BIAS_META[brief.sessionBias] : null;
  const Icon = meta?.icon ?? Sparkles;

  const showStale = brief && !isToday;

  return (
    <div className="panel p-5 space-y-4 bg-gradient-surface relative overflow-hidden">
      {/* Soft accent glow */}
      <div className="absolute -top-12 -right-12 h-40 w-40 rounded-full bg-primary/10 blur-3xl pointer-events-none" />

      <div className="flex items-start justify-between gap-3 relative">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-10 w-10 rounded-md bg-primary/15 text-primary flex items-center justify-center shrink-0">
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Pre-market brief
              </span>
              {meta && (
                <StatusBadge tone={meta.tone} size="sm" dot>
                  {meta.label}
                </StatusBadge>
              )}
              {showStale && (
                <StatusBadge tone="caution" size="sm">
                  stale · {brief?.briefDate}
                </StatusBadge>
              )}
            </div>
            <div className="text-base font-semibold text-foreground mt-0.5">
              {brief
                ? new Date(brief.briefDate + "T00:00:00Z").toLocaleDateString(undefined, {
                    weekday: "long",
                    month: "short",
                    day: "numeric",
                  })
                : "Today's session"}
            </div>
          </div>
        </div>
        <Button
          size="sm"
          variant={brief ? "outline" : "default"}
          className="gap-1.5 shrink-0"
          onClick={handleGenerate}
          disabled={generating || loading}
        >
          {generating ? (
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          ) : brief ? (
            <RefreshCw className="h-3.5 w-3.5" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {generating ? "Briefing…" : brief ? "Refresh" : "Generate brief"}
        </Button>
      </div>

      {/* Body */}
      <div className="relative">
        {loading && !brief ? (
          <div className="h-20 rounded-md bg-muted/30 animate-pulse" />
        ) : !brief ? (
          <p className="text-sm text-muted-foreground italic">
            No brief yet. Tap <span className="text-foreground font-medium">Generate brief</span> for a 3-4 sentence pre-market read on macro, yesterday's tape, and today's caution flags.
          </p>
        ) : (
          <p className="text-sm leading-relaxed text-foreground whitespace-pre-line">
            {brief.briefText}
          </p>
        )}
      </div>

      {/* Caution flags */}
      {brief && brief.cautionFlags.length > 0 && (
        <div className="relative space-y-1.5">
          <div className="text-[10px] uppercase tracking-wider text-status-caution flex items-center gap-1.5">
            <AlertTriangle className="h-3 w-3" /> Active flags
          </div>
          <div className="flex flex-wrap gap-1.5">
            {brief.cautionFlags.map((f, i) => (
              <span
                key={i}
                className="text-[11px] tabular px-2 py-0.5 rounded border border-status-caution/40 bg-status-caution/10 text-status-caution"
              >
                {f}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Watch + key levels */}
      {brief && brief.watchSymbols.length > 0 && (
        <div className="relative grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
          {brief.watchSymbols.map((sym) => {
            const lv = brief.keyLevels[sym] ?? { support: null, resistance: null };
            return (
              <div
                key={sym}
                className="rounded-md border border-border/60 bg-card/40 px-3 py-2"
              >
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {sym}
                </div>
                <div className="mt-1 flex items-baseline justify-between gap-2 text-xs tabular">
                  <div>
                    <span className="text-muted-foreground">S </span>
                    <span className="text-status-safe">{fmtPrice(lv.support)}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">R </span>
                    <span className="text-status-blocked">{fmtPrice(lv.resistance)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Footer meta */}
      {brief && (
        <div className="relative flex items-center justify-between text-[10px] text-muted-foreground pt-1 border-t border-border/40">
          <span>
            {brief.aiModel.replace("google/", "").replace("openai/", "")}
          </span>
          <span>updated {relativeAge(brief.updatedAt)}</span>
        </div>
      )}
    </div>
  );
}
