import { cn } from "@/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";

const statusBadgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium uppercase tracking-wider transition-colors",
  {
    variants: {
      tone: {
        safe: "border-status-safe/30 bg-status-safe/10 text-status-safe",
        caution: "border-status-caution/30 bg-status-caution/10 text-status-caution",
        blocked: "border-status-blocked/30 bg-status-blocked/10 text-status-blocked",
        candidate: "border-status-candidate/30 bg-status-candidate/10 text-status-candidate",
        disabled: "border-status-disabled/30 bg-status-disabled/10 text-status-disabled",
        neutral: "border-border bg-secondary text-muted-foreground",
        accent: "border-primary/30 bg-primary/10 text-primary",
      },
      size: {
        sm: "px-2 py-0.5 text-[10px]",
        md: "px-2.5 py-0.5 text-xs",
      },
    },
    defaultVariants: { tone: "neutral", size: "md" },
  },
);

export interface StatusBadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof statusBadgeVariants> {
  dot?: boolean;
  pulse?: boolean;
}

export function StatusBadge({ className, tone, size, dot, pulse, children, ...props }: StatusBadgeProps) {
  return (
    <span className={cn(statusBadgeVariants({ tone, size }), className)} {...props}>
      {dot && (
        <span
          className={cn(
            "inline-block h-1.5 w-1.5 rounded-full bg-current",
            pulse && "animate-pulse-soft",
          )}
        />
      )}
      {children}
    </span>
  );
}
