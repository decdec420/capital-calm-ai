import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useHelpMode } from "@/contexts/HelpModeContext";
import { cn } from "@/lib/utils";

interface ExplainProps {
  /** Tooltip body — what this thing actually means in plain English. */
  hint: ReactNode;
  /** Optional bold title shown above the hint. */
  title?: string;
  /** Element being explained. */
  children: ReactNode;
  /** Side of the tooltip. */
  side?: "top" | "right" | "bottom" | "left";
  /** Render as inline-block when wrapping inline content. */
  inline?: boolean;
  className?: string;
}

/**
 * Wraps any UI bit with a contextual tooltip that ONLY renders when the user
 * has flipped on global "What's this?" help mode from the TopBar.
 *
 * When help mode is off, this is a zero-cost passthrough.
 */
export function Explain({ hint, title, children, side = "top", inline, className }: ExplainProps) {
  const { enabled } = useHelpMode();

  if (!enabled) return <>{children}</>;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            inline ? "inline-block" : "block",
            "ring-1 ring-primary/40 ring-offset-1 ring-offset-background rounded-sm cursor-help transition-shadow hover:ring-primary/70",
            className,
          )}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-xs text-xs leading-relaxed">
        {title && <div className="font-semibold text-foreground mb-1">{title}</div>}
        <div className="text-muted-foreground">{hint}</div>
      </TooltipContent>
    </Tooltip>
  );
}
