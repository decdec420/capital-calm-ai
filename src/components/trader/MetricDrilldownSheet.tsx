import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface MetricDrilldownSheetProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * Shared right-side sheet for drilling into a metric card.
 * Keeps the visual language identical to the Trades sheet.
 */
export function MetricDrilldownSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
}: MetricDrilldownSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className={cn("bg-card border-border w-full sm:max-w-lg overflow-y-auto", className)}
      >
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <div className="mt-6 space-y-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

export function DrilldownStat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  tone?: "default" | "safe" | "blocked" | "caution";
}) {
  const color =
    tone === "safe"
      ? "text-status-safe"
      : tone === "blocked"
        ? "text-status-blocked"
        : tone === "caution"
          ? "text-status-caution"
          : "text-foreground";
  return (
    <div className="rounded-md border border-border bg-background/40 px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("text-sm tabular font-medium mt-0.5", color)}>{value}</div>
    </div>
  );
}

export function DrilldownSection({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}
