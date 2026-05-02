// ============================================================
// DoctrineOverlayBanner — surfaces the live overlay (mode + DD)
// computed by signal-engine and stored on system_state.
// Tells the operator WHY their effective doctrine may be tighter
// than what they see in the editor.
// ============================================================
import { Activity, AlertOctagon, CloudLightning, Wind } from "lucide-react";
import { useSystemState } from "@/hooks/useSystemState";

type Mode = "calm" | "choppy" | "storm" | "lockout";

interface OverlayShape {
  mode?: Mode;
  drawdownStep?: 0 | 1 | 2 | 3;
  sizeMult?: number;
  tradesMult?: number;
  riskMult?: number;
  dailyLossMult?: number;
  blockNewEntries?: boolean;
  reasons?: string[];
  computedAt?: string;
}

const MODE_META: Record<Mode, { label: string; tone: string; Icon: typeof Activity }> = {
  calm:    { label: "Calm",    tone: "text-status-safe border-status-safe/40 bg-status-safe/10",       Icon: Activity },
  choppy:  { label: "Choppy",  tone: "text-status-caution border-status-caution/40 bg-status-caution/10", Icon: Wind },
  storm:   { label: "Storm",   tone: "text-status-blocked border-status-blocked/40 bg-status-blocked/10", Icon: CloudLightning },
  lockout: { label: "Lockout", tone: "text-status-blocked border-status-blocked/60 bg-status-blocked/15", Icon: AlertOctagon },
};

function pct(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${Math.round(v * 100)}%`;
}

export function DoctrineOverlayBanner() {
  const { data: system } = useSystemState();
  const overlay: OverlayShape | undefined =
    (system?.doctrineOverlayToday as OverlayShape | null) ??
    ((system?.lastEngineSnapshot as unknown as { overlay?: OverlayShape } | null)?.overlay);

  if (!overlay || !overlay.mode) return null;

  const mode = overlay.mode;
  // Hide when nothing is actually tightening — keeps the panel quiet on calm days.
  const tightening =
    mode !== "calm" ||
    (overlay.drawdownStep ?? 0) > 0 ||
    overlay.blockNewEntries === true;
  if (!tightening) return null;

  const meta = MODE_META[mode];

  return (
    <div className={`panel p-4 border ${meta.tone}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <meta.Icon className="h-4 w-4" />
          <div>
            <div className="text-sm font-semibold">
              Doctrine overlay active · {meta.label}
              {overlay.blockNewEntries && <span className="ml-2 text-[10px] uppercase tracking-wider">no new entries</span>}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Effective caps are tighter than your editor values right now. Lifts when conditions clear.
            </p>
          </div>
        </div>
        {overlay.computedAt && (
          <span className="text-[10px] text-muted-foreground tabular shrink-0">
            {new Date(overlay.computedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
        <Mult label="Order size" value={overlay.sizeMult} />
        <Mult label="Trades / day" value={overlay.tradesMult} />
        <Mult label="Risk / trade" value={overlay.riskMult} />
        <Mult label="Daily loss cap" value={overlay.dailyLossMult} />
      </div>

      {overlay.reasons && overlay.reasons.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {overlay.reasons.map((r) => (
            <span key={r} className="text-[10px] px-1.5 py-0.5 rounded bg-background/60 border border-border/60 text-muted-foreground tabular">
              {r}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Mult({ label, value }: { label: string; value: number | undefined }) {
  const v = value ?? 1;
  const dimmed = v >= 1;
  return (
    <div className="text-xs">
      <div className="uppercase tracking-wider text-[10px] text-muted-foreground">{label}</div>
      <div className={`tabular font-semibold ${dimmed ? "text-muted-foreground" : "text-foreground"}`}>
        × {pct(v)}
      </div>
    </div>
  );
}
