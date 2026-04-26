import { AlertTriangle, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

/**
 * Persistent visual indicator of whether real-money trading is armed.
 *
 * Two visual states (intentionally asymmetric — paper should fade,
 * live should grab the eye):
 *
 *  - LIVE armed: pulsing red badge with an AlertTriangle icon. Mirrors
 *    the FloatingKillSwitch engaged state so the operator can't miss it.
 *  - paper / gated: subtle low-weight badge in the same shape so the
 *    layout doesn't shift, but with much lower visual contrast.
 *
 * Click jumps to /settings where the toggle lives — same target as the
 * adjacent system-mode pill, so muscle memory carries over.
 */
export function LiveModeIndicator({ liveTradingEnabled }: { liveTradingEnabled: boolean }) {
  if (liveTradingEnabled) {
    return (
      <Link
        to="/settings"
        aria-label="Live trading is ARMED. Open settings."
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1",
          "bg-status-blocked text-background animate-pulse",
          "shadow-[0_0_0_1px_hsl(var(--status-blocked)/0.6)]",
          "outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "hover:scale-[1.02] transition-transform",
        )}
      >
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
        <span className="text-[10px] font-bold uppercase tracking-[0.18em]">Live</span>
      </Link>
    );
  }

  return (
    <Link
      to="/settings"
      aria-label="Live trading gated (paper only). Open settings."
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5",
        "border border-border bg-secondary/60 text-muted-foreground",
        "hover:text-foreground hover:bg-secondary transition-colors",
        "outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
      )}
    >
      <ShieldCheck className="h-3 w-3" aria-hidden />
      <span className="text-[10px] font-medium uppercase tracking-[0.18em]">Gated</span>
    </Link>
  );
}
