import { useState } from "react";
import { toast } from "sonner";
import { useSystemState } from "@/hooks/useSystemState";
import type { AutonomyLevel } from "@/lib/domain-types";
import { cn } from "@/lib/utils";

const LEVELS: { value: AutonomyLevel; label: string; hint: string }[] = [
  { value: "manual", label: "Manual", hint: "Every signal needs your tap." },
  { value: "assisted", label: "Assisted", hint: "Auto-approve when confidence ≥ 85%." },
  { value: "autonomous", label: "Autonomous", hint: "Auto-approve everything." },
];

export function AutonomyToggle() {
  const { data: system, update } = useSystemState();
  const [busy, setBusy] = useState(false);
  const current = system?.autonomyLevel ?? "manual";
  const isLive = system?.liveTradingEnabled === true;

  const setLevel = async (level: AutonomyLevel) => {
    if (level === current || busy) return;
    setBusy(true);
    try {
      await update({ autonomyLevel: level });
      toast.success(`Autonomy: ${level}`);
    } catch {
      toast.error("Couldn't update autonomy.");
    } finally {
      setBusy(false);
    }
  };

  const dynamicHint = () => {
    const qualifier = isLive ? "real order" : "paper order";
    if (current === "manual") return `You review every signal before any ${qualifier} executes.`;
    if (current === "assisted") return `${qualifier}s auto-execute when confidence ≥ 85%. You review the rest.`;
    return `All signals auto-execute within doctrine limits. No approval needed.`;
  };

  return (
    <div className="panel p-4 space-y-3">
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Autonomy</span>
          {isLive ? (
            <span className="text-[10px] uppercase tracking-wider font-semibold text-status-blocked">
              LIVE — real money
            </span>
          ) : (
            <span className="text-[10px] text-muted-foreground">paper-only until live armed</span>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground">Who approves trades.</p>
      </div>
      <div className="grid grid-cols-3 gap-1 p-1 bg-secondary rounded-md border border-border">
        {LEVELS.map((l) => (
          <button
            key={l.value}
            onClick={() => setLevel(l.value)}
            disabled={busy}
            className={cn(
              "text-xs py-1.5 px-2 rounded-sm transition-colors flex items-center justify-center gap-1",
              current === l.value
                ? "bg-primary text-primary-foreground font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-background",
            )}
          >
            <span>{l.label}</span>
            <span
              className={cn(
                "text-[9px] uppercase tracking-wider font-semibold",
                isLive
                  ? current === l.value
                    ? "text-status-blocked-foreground/90"
                    : "text-status-blocked"
                  : current === l.value
                    ? "opacity-70"
                    : "opacity-60",
              )}
            >
              {isLive ? "(LIVE)" : "(paper)"}
            </span>
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground italic">{dynamicHint()}</p>
      {current === "autonomous" && (
        <div className="text-[10px] uppercase tracking-wider font-semibold text-status-caution bg-status-caution/10 border border-status-caution/30 rounded-sm px-2 py-1 text-center">
          ⚡ All clear signals execute automatically
        </div>
      )}
    </div>
  );
}
