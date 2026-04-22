import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useExplainMode } from "@/contexts/ExplainModeContext";

interface ExplainProps {
  /** Plain-English meaning of this thing. */
  hint: ReactNode;
  /** Optional bold title shown above the hint. */
  title?: string;
  /** Element being explained. */
  children: ReactNode;
  /** Side of the popover when open. */
  side?: "top" | "right" | "bottom" | "left";
  /** Render as inline-block when wrapping inline content. */
  inline?: boolean;
  className?: string;
}

/**
 * Opt-in explainer. Invisible by default — children render bare, no cursor change,
 * no icons, no hover tooltip. When the user enables Explain mode (⌘/ or the toggle
 * in the TopBar), every Explain wrapper gets a subtle highlight and becomes
 * click-to-reveal via a popover. Inspired by Figma's "?" overlay and Raycast's
 * keyboard-first surfacing.
 */
export function Explain({ hint, title, children, side = "bottom", inline, className }: ExplainProps) {
  const { enabled } = useExplainMode();

  if (!enabled) {
    // Off: render children completely bare. No wrapper styling at all to avoid
    // shifting layout vs. when the component isn't used.
    return <>{children}</>;
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <span
          tabIndex={0}
          role="button"
          aria-label={title ? `Explain: ${title}` : "Explain"}
          className={cn(
            inline ? "inline-flex" : "flex",
            "items-center cursor-pointer rounded-md outline-none transition-colors",
            "ring-1 ring-primary/30 bg-primary/5 hover:bg-primary/10",
            "focus-visible:ring-2 focus-visible:ring-primary/60",
            className,
          )}
        >
          {children}
        </span>
      </PopoverTrigger>
      <PopoverContent side={side} className="w-72 text-xs leading-relaxed p-3">
        {title && <div className="font-semibold text-foreground mb-1">{title}</div>}
        <div className="text-muted-foreground">{hint}</div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * For places (like MetricCard labels) that previously rendered a tiny ⓘ icon
 * even when no one was looking. We keep the API for backwards compat but it now
 * just delegates to <Explain> wrapping a single space — when explain mode is on,
 * a small chip appears next to the label; when off, nothing renders.
 */
export function ExplainIcon({
  hint,
  title,
  side = "bottom",
  className,
}: Omit<ExplainProps, "children" | "inline">) {
  const { enabled } = useExplainMode();
  if (!enabled) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={title ? `Explain ${title}` : "Explain"}
          className={cn(
            "inline-flex h-4 items-center justify-center rounded-full px-1.5 text-[9px] font-semibold uppercase tracking-wider",
            "bg-primary/15 text-primary hover:bg-primary/25 transition-colors outline-none",
            "focus-visible:ring-2 focus-visible:ring-primary/60",
            className,
          )}
        >
          ?
        </button>
      </PopoverTrigger>
      <PopoverContent side={side} className="w-72 text-xs leading-relaxed p-3">
        {title && <div className="font-semibold text-foreground mb-1">{title}</div>}
        <div className="text-muted-foreground">{hint}</div>
      </PopoverContent>
    </Popover>
  );
}
