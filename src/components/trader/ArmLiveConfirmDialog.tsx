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
import { useState } from "react";
import { Zap } from "lucide-react";

interface ArmLiveConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
}

/**
 * One-click "are you sure" prompt for arming live trading after the
 * one-time type-to-confirm acknowledgment has already been signed.
 *
 * Flow:
 *   - First-ever flip ON  → LiveMoneyAcknowledgmentDialog (type "I UNDERSTAND")
 *   - Every flip ON after → this dialog (single-click confirm)
 *   - Flip OFF (disarm)   → no friction, instant
 *
 * Disarming is always free; arming always asks. That asymmetry is the point.
 */
export function ArmLiveConfirmDialog({ open, onOpenChange, onConfirm }: ArmLiveConfirmDialogProps) {
  const [busy, setBusy] = useState(false);

  const handleConfirm = async () => {
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
            <Zap className="h-5 w-5 text-status-blocked" />
            Arm live trading?
          </AlertDialogTitle>
          <AlertDialogDescription className="pt-1">
            Real orders. All guardrails active. Disarm any time from this toggle
            or the floating kill switch.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleConfirm();
            }}
            disabled={busy}
            className="bg-status-blocked text-background hover:bg-status-blocked/90"
          >
            {busy ? "Arming…" : "Confirm — arm live"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
