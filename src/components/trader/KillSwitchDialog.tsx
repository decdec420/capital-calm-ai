import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShieldAlert, ShieldCheck } from "lucide-react";

interface KillSwitchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Current state of the switch — drives engage vs disarm copy/flow. */
  engaged: boolean;
  onConfirm: () => void | Promise<void>;
}

const CONFIRM_PHRASE = "DISARM";

/**
 * Engage = simple confirm (you want friction but not a typing tax in a panic).
 * Disarm = type-to-confirm (the "off" state must stay off until you really mean it).
 */
export function KillSwitchDialog({ open, onOpenChange, engaged, onConfirm }: KillSwitchDialogProps) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  // Reset the typed phrase whenever the dialog opens/closes.
  useEffect(() => {
    if (!open) {
      setTyped("");
      setBusy(false);
    }
  }, [open]);

  const isDisarming = engaged;
  const canConfirm = isDisarming ? typed.trim().toUpperCase() === CONFIRM_PHRASE : true;

  const handleConfirm = async () => {
    if (!canConfirm) return;
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="bg-card border-border">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {isDisarming ? (
              <>
                <ShieldCheck className="h-5 w-5 text-status-safe" />
                Disarm kill-switch?
              </>
            ) : (
              <>
                <ShieldAlert className="h-5 w-5 text-status-blocked" />
                Engage kill-switch?
              </>
            )}
          </AlertDialogTitle>
          <AlertDialogDescription className="space-y-2 pt-1">
            {isDisarming ? (
              <>
                <span className="block">
                  This re-arms the bot to accept proposals on the next tick. Open positions are not affected — only new entries.
                </span>
                <span className="block text-foreground">
                  Type <span className="font-mono font-semibold text-primary">{CONFIRM_PHRASE}</span> to confirm.
                </span>
              </>
            ) : (
              <span className="block">
                The bot will halt immediately. The cron sweep will skip your account, no new signals will be proposed,
                and the AI engine will refuse to open positions until you disarm. Open trades remain untouched.
              </span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {isDisarming && (
          <div className="space-y-1.5">
            <Label htmlFor="kill-confirm" className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Confirmation
            </Label>
            <Input
              id="kill-confirm"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={CONFIRM_PHRASE}
              className="font-mono"
              onKeyDown={(e) => {
                if (e.key === "Enter" && canConfirm && !busy) handleConfirm();
              }}
            />
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleConfirm();
            }}
            disabled={!canConfirm || busy}
            className={
              isDisarming
                ? "bg-status-safe text-background hover:bg-status-safe/90"
                : "bg-status-blocked text-background hover:bg-status-blocked/90"
            }
          >
            {busy ? "Working…" : isDisarming ? "Disarm" : "Engage"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
