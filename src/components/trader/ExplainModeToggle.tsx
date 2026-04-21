import { Lightbulb } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useExplainMode } from "@/contexts/ExplainModeContext";
import { cn } from "@/lib/utils";

const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

export function ExplainModeToggle() {
  const { enabled, toggle } = useExplainMode();
  const shortcut = isMac ? "⌘/" : "Ctrl /";

  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={toggle}
          aria-pressed={enabled}
          aria-label="Toggle explain mode"
          className={cn(
            "h-7 inline-flex items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition-all outline-none",
            "focus-visible:ring-2 focus-visible:ring-primary/40",
            enabled
              ? "border-primary/40 bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:text-foreground hover:bg-accent",
          )}
        >
          <Lightbulb className={cn("h-3.5 w-3.5", enabled && "fill-primary/20")} />
          <span className="hidden sm:inline">Explain</span>
          <kbd
            className={cn(
              "hidden md:inline-flex items-center rounded border px-1 font-mono text-[10px] leading-none py-0.5",
              enabled ? "border-primary/30 text-primary/80" : "border-border text-muted-foreground/70",
            )}
          >
            {shortcut}
          </kbd>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {enabled ? "Hide explanations" : "Reveal explanations across the UI"}
      </TooltipContent>
    </Tooltip>
  );
}
