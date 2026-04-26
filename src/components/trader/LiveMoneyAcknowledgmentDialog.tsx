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
import { ShieldAlert } from "lucide-react";

interface LiveMoneyAcknowledgmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called only after the user types the confirm phrase and clicks sign. */
  onConfirm: () => void | Promise<void>;
}

const CONFIRM_PHRASE = "I UNDERSTAND";

/**
 * One-time-per-account acknowledgment that gates `live_trading_enabled`
 * from flipping true. The DB has a BEFORE UPDATE trigger that refuses
 * the flip until system_state.live_money_acknowledged_at is set;
 * this dialog is the UI side that asks for the signature.
 *
 * Friction is intentional. Real money. Type-to-confirm.
 */
export function LiveMoneyAcknowledgmentDialog({
  open,
  onOpenChange,
  onConfirm,
}: LiveMoneyAcknowledgmentDialogProps) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setTyped("");
      setBusy(false);
    }
  }, [open]);

  const canConfirm = typed.trim().toUpperCase() === CONFIRM_PHRASE;

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
            <ShieldAlert className="h-5 w-5 text-status-blocked" />
            Arm live trading?
          </AlertDialogTitle>
          <AlertDialogDescription className="space-y-3 pt-1">
            <span className="block">
              Flipping this on lets the system place real orders with real money.
              Every doctrine guardrail still applies — but past this gate, mistakes
              cost money instead of paper.
            </span>
            <span className="block">
              You're signing once to acknowledge that. After today the toggle
              flips freely; the kill-switch is always one click away.
            </span>
            <span className="block text-foreground">
              Type <span className="font-mono font-semibold text-primary">{CONFIRM_PHRASE}</span> to sign.
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-1.5">
          <Label
            htmlFor="ack-confirm"
            className="text-[11px] uppercase tracking-wider text-muted-foreground"
          >
            Confirmation
          </Label>
          <Input
            id="ack-confirm"
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

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleConfirm();
            }}
            disabled={!canConfirm || busy}
            className="bg-status-blocked text-background hover:bg-status-blocked/90"
          >
            {busy ? "Signing…" : "Sign and arm"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
