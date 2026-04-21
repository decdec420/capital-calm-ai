import { useCallback, useRef } from "react";
import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

interface NumberStepperProps {
  value: string;
  onChange: (value: string) => void;
  step?: number;
  /** Multiplier applied when Shift is held. Defaults to 10. */
  shiftMultiplier?: number;
  min?: number;
  max?: number;
  placeholder?: string;
  /** Decimal places to clamp to. Inferred from step if omitted. */
  precision?: number;
  /** Optional prefix shown inside the input (e.g. "$"). */
  prefix?: string;
  /** Optional suffix shown inside the input (e.g. "%"). */
  suffix?: string;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
}

function inferPrecision(step: number): number {
  if (!isFinite(step) || step <= 0) return 2;
  const s = step.toString();
  if (s.includes("e-")) return parseInt(s.split("e-")[1], 10);
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

export function NumberStepper({
  value,
  onChange,
  step = 1,
  shiftMultiplier = 10,
  min,
  max,
  placeholder,
  precision,
  prefix,
  suffix,
  className,
  disabled,
  "aria-label": ariaLabel,
}: NumberStepperProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const decimals = precision ?? inferPrecision(step);

  const clamp = useCallback(
    (n: number): number => {
      let v = n;
      if (typeof min === "number") v = Math.max(min, v);
      if (typeof max === "number") v = Math.min(max, v);
      return v;
    },
    [min, max],
  );

  const nudge = useCallback(
    (direction: 1 | -1, big: boolean) => {
      const current = value === "" || value === "-" ? 0 : parseFloat(value);
      const base = isNaN(current) ? 0 : current;
      const delta = step * (big ? shiftMultiplier : 1) * direction;
      const next = clamp(base + delta);
      // Avoid floating-point fuzz like 0.30000000000004
      onChange(next.toFixed(decimals));
    },
    [value, step, shiftMultiplier, decimals, clamp, onChange],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      nudge(1, e.shiftKey);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      nudge(-1, e.shiftKey);
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLInputElement>) => {
    // Only step on wheel when the input is focused — prevents accidental scroll edits.
    if (document.activeElement !== inputRef.current) return;
    e.preventDefault();
    nudge(e.deltaY < 0 ? 1 : -1, e.shiftKey);
  };

  return (
    <div
      className={cn(
        "group flex items-center h-10 rounded-md border border-input bg-background",
        "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-0",
        "transition-colors",
        disabled && "opacity-60 pointer-events-none",
        className,
      )}
    >
      <button
        type="button"
        tabIndex={-1}
        onClick={(e) => nudge(-1, e.shiftKey)}
        disabled={disabled}
        aria-label="Decrease"
        title="Decrease (hold Shift for x10)"
        className={cn(
          "h-full w-9 flex items-center justify-center rounded-l-md",
          "text-muted-foreground hover:text-foreground hover:bg-secondary",
          "border-r border-input transition-colors active:bg-secondary/80",
        )}
      >
        <Minus className="h-3.5 w-3.5" />
      </button>

      <div className="flex-1 flex items-center px-2 min-w-0">
        {prefix && (
          <span className="text-sm text-muted-foreground tabular pr-1 select-none">{prefix}</span>
        )}
        <input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            // Allow empty, sign, digits, single dot
            if (v === "" || /^-?\d*\.?\d*$/.test(v)) onChange(v);
          }}
          onKeyDown={handleKeyDown}
          onWheel={handleWheel}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={ariaLabel}
          className={cn(
            "w-full bg-transparent border-0 outline-none text-sm tabular text-foreground text-center",
            "placeholder:text-muted-foreground/60",
          )}
        />
        {suffix && (
          <span className="text-sm text-muted-foreground tabular pl-1 select-none">{suffix}</span>
        )}
      </div>

      <button
        type="button"
        tabIndex={-1}
        onClick={(e) => nudge(1, e.shiftKey)}
        disabled={disabled}
        aria-label="Increase"
        title="Increase (hold Shift for x10)"
        className={cn(
          "h-full w-9 flex items-center justify-center rounded-r-md",
          "text-muted-foreground hover:text-foreground hover:bg-secondary",
          "border-l border-input transition-colors active:bg-secondary/80",
        )}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
