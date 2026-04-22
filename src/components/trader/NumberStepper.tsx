import { useCallback, useRef } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

interface NumberStepperProps {
  value: string;
  onChange: (value: string) => void;
  /**
   * Base step. If omitted, the stepper auto-scales to the magnitude of the
   * current value (e.g. $43,000 → step $10, $4.21 → step $0.01).
   */
  step?: number;
  /** Multiplier applied when Shift is held. Defaults to 10. */
  shiftMultiplier?: number;
  min?: number;
  max?: number;
  placeholder?: string;
  /** Decimal places to clamp to. Inferred from step (or value magnitude) if omitted. */
  precision?: number;
  /** Optional prefix shown inside the input (e.g. "$"). */
  prefix?: string;
  /** Optional suffix shown inside the input (e.g. "%"). */
  suffix?: string;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
}

/** Step that scales with the magnitude of the value — no more penny-clicking on $43k. */
function autoStep(n: number): number {
  const abs = Math.abs(n);
  if (abs >= 10000) return 10;
  if (abs >= 1000) return 1;
  if (abs >= 100) return 0.5;
  if (abs >= 10) return 0.1;
  if (abs >= 1) return 0.01;
  return 0.001;
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
  step,
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
      const effectiveStep = step ?? autoStep(base);
      const decimals = precision ?? inferPrecision(effectiveStep);
      const delta = effectiveStep * (big ? shiftMultiplier : 1) * direction;
      const next = clamp(base + delta);
      onChange(next.toFixed(decimals));
    },
    [value, step, shiftMultiplier, precision, clamp, onChange],
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

  return (
    <div
      className={cn(
        "group relative flex items-center h-10 rounded-md border border-input bg-background",
        "focus-within:ring-2 focus-within:ring-ring focus-within:border-ring",
        "transition-all hover:border-ring/40",
        disabled && "opacity-60 pointer-events-none",
        className,
      )}
      onClick={() => inputRef.current?.focus()}
    >
      {prefix && (
        <span className="pl-3 text-sm text-muted-foreground tabular select-none">{prefix}</span>
      )}
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "" || /^-?\d*\.?\d*$/.test(v)) onChange(v);
        }}
        onKeyDown={handleKeyDown}
        onFocus={(e) => e.currentTarget.select()}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        className={cn(
          "flex-1 min-w-0 h-full bg-transparent border-0 outline-none px-3 text-sm tabular text-foreground",
          "placeholder:text-muted-foreground/60",
          prefix && "pl-1",
          suffix && "pr-1",
        )}
      />
      {suffix && (
        <span className="pr-1 text-sm text-muted-foreground tabular select-none">{suffix}</span>
      )}

      {/* Subtle stacked steppers — visible on hover/focus, out of the way otherwise */}
      <div
        className={cn(
          "flex flex-col h-full border-l border-input/60 ml-1",
          "opacity-40 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity",
        )}
      >
        <button
          type="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            nudge(1, e.shiftKey);
          }}
          disabled={disabled}
          aria-label="Increase"
          title="Increase (↑ or Shift+↑ for x10)"
          className="flex-1 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary rounded-tr-md transition-colors"
        >
          <ChevronUp className="h-3 w-3" />
        </button>
        <button
          type="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            nudge(-1, e.shiftKey);
          }}
          disabled={disabled}
          aria-label="Decrease"
          title="Decrease (↓ or Shift+↓ for x10)"
          className="flex-1 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary rounded-br-md border-t border-input/60 transition-colors"
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
