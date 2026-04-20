import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface ExplainProps {
  /** Tooltip body — what this thing actually means in plain English. */
  hint: ReactNode;
  /** Optional bold title shown above the hint. */
  title?: string;
  /** Element being explained. Wrapped element triggers tooltip on hover/focus. */
  children: ReactNode;
  /** Side of the tooltip. */
  side?: "top" | "right" | "bottom" | "left";
  /** Render as inline-block when wrapping inline content. */
  inline?: boolean;
  className?: string;
}

/**
 * Hover/focus tooltip — Robinhood-style info-label pattern. Always available,
 * no global mode. The wrapped element gets a `cursor-help` so users discover
 * that hovering reveals more context.
 */
export function Explain({ hint, title, children, side = "top", inline, className }: ExplainProps) {
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn(
            inline ? "inline-block" : "block",
            "cursor-help outline-none focus-visible:ring-2 focus-visible:ring-primary/50 rounded-sm",
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

/**
 * Tiny ⓘ icon for use inline next to a metric label. Shows tooltip on hover/focus.
 * Use this when you want the discoverability cue (the icon) rather than wrapping
 * the whole element.
 */
export function ExplainIcon({
  hint,
  title,
  side = "top",
  className,
}: Omit<ExplainProps, "children" | "inline">) {
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={title ? `What is ${title}?` : "More info"}
          className={cn(
            "inline-flex items-center justify-center text-muted-foreground/60 hover:text-foreground transition-colors cursor-help outline-none focus-visible:text-foreground",
            className,
          )}
        >
          <Info className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-xs text-xs leading-relaxed">
        {title && <div className="font-semibold text-foreground mb-1">{title}</div>}
        <div className="text-muted-foreground">{hint}</div>
      </TooltipContent>
    </Tooltip>
  );
}
