import { useEffect, useState } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useSystemState } from "@/hooks/useSystemState";
import { KillSwitchDialog } from "@/components/trader/KillSwitchDialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/**
 * Always-visible kill-switch button anchored to the bottom-right of every
 * authenticated page. Reachable in <2s from anywhere — no nav required.
 *
 * Two visual states:
 *   - DISARMED (default): subtle red shield. Click → engage dialog.
 *   - ENGAGED: pulsing red badge that announces itself. Click → disarm
 *     dialog (type "DISARM" to confirm).
 *
 * Hidden on /auth and /reset-password because the route shell
 * (AppLayout) only mounts inside ProtectedRoute, so this never renders
 * before auth.
 */
export function FloatingKillSwitch() {
  const { data: system, update } = useSystemState();
  const [open, setOpen] = useState(false);

  // Global "k" shortcut dispatched from KeyboardShortcutsOverlay opens this dialog.
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener("lovable:open-kill-switch", handler);
    return () => window.removeEventListener("lovable:open-kill-switch", handler);
  }, []);

  // Don't render until system_state has loaded — no flash of armed state.
  if (!system) return null;

  const engaged = system.killSwitchEngaged;

  const onConfirm = async () => {
    const next = !engaged;
    try {
      await update({
        killSwitchEngaged: next,
        bot: next ? "halted" : "paused",
      });
      toast.success(next ? "Kill-switch ENGAGED." : "Kill-switch disarmed.");
    } catch {
      toast.error("Couldn't toggle kill-switch.");
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={engaged ? "Disarm kill-switch" : "Engage kill-switch"}
        className={cn(
          "fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full",
          "shadow-lg outline-none transition-all duration-150",
          "focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          engaged
            ? "bg-status-blocked text-background px-4 py-2.5 animate-pulse hover:scale-[1.02]"
            : "bg-status-blocked/10 text-status-blocked border border-status-blocked/40 hover:bg-status-blocked/20 hover:border-status-blocked/60 px-3.5 py-2 backdrop-blur",
        )}
      >
        {engaged ? (
          <>
            <ShieldAlert className="h-4 w-4" aria-hidden />
            <span className="text-xs font-semibold uppercase tracking-wider">
              Kill-switch engaged
            </span>
          </>
        ) : (
          <>
            <ShieldCheck className="h-4 w-4" aria-hidden />
            <span className="text-xs font-medium uppercase tracking-wider">
              Kill switch
            </span>
          </>
        )}
      </button>

      <KillSwitchDialog
        open={open}
        onOpenChange={setOpen}
        engaged={engaged}
        onConfirm={onConfirm}
      />
    </>
  );
}
