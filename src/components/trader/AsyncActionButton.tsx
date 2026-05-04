import { useState } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

type RiskTier = "low" | "medium" | "high";

type Props = Omit<ButtonProps, "onClick"> & {
  onAction: () => Promise<void>;
  idleLabel: string;
  pendingLabel: string;
  successMessage: string;
  errorMessage: string;
  riskTier?: RiskTier;
  confirmLabel?: string;
};

const confirmByTier = (riskTier: RiskTier, label: string): boolean => {
  if (riskTier === "low") return true;
  if (riskTier === "medium") {
    return window.confirm(`Confirm action: ${label}?`);
  }
  const typed = window.prompt(`High-risk action. Type CONFIRM to continue: ${label}`);
  return typed === "CONFIRM";
};

export function AsyncActionButton({
  onAction,
  idleLabel,
  pendingLabel,
  successMessage,
  errorMessage,
  riskTier = "low",
  confirmLabel,
  disabled,
  children,
  ...rest
}: Props) {
  const [pending, setPending] = useState(false);

  const run = async () => {
    if (pending) return;
    const allowed = confirmByTier(riskTier, confirmLabel ?? idleLabel);
    if (!allowed) return;
    setPending(true);
    try {
      await onAction();
      toast.success(successMessage);
    } catch (e) {
      const detail = e instanceof Error ? e.message : errorMessage;
      toast.error(errorMessage, { description: detail });
    } finally {
      setPending(false);
    }
  };

  return (
    <Button {...rest} onClick={run} disabled={disabled || pending}>
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : children}
      {pending ? pendingLabel : idleLabel}
    </Button>
  );
}
