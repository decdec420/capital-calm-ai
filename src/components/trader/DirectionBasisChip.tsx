import { Sparkles, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DirectionBasis } from "@/lib/domain-types";

/** Inline tag explaining how the engine arrived at the trade direction.
 * Renders nothing for legacy trades that have no direction_basis (so old
 * history doesn't break). For default-long fallbacks we show a loud
 * caution chip — those are low-conviction silent defaults that should
 * never reach a real trade post-fix, but legacy rows may still exist. */
export function DirectionBasisChip({
  basis,
  className,
}: {
  basis: DirectionBasis | null | undefined;
  className?: string;
}) {
  if (!basis) return null;

  if (basis === "default_long_fallback") {
    return (
      <span
        title="The engine did not actively choose long — this is a default fallback. Treat with extra caution."
        className={cn(
          "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold",
          "bg-status-caution/15 text-status-caution border border-status-caution/30",
          className,
        )}
      >
        <AlertTriangle className="h-2.5 w-2.5" />
        Default long
      </span>
    );
  }

  const label = basis === "engine_chose_short" ? "Engine · Short" : "Engine · Long";
  return (
    <span
      title="The engine actively chose this direction based on momentum and macro reads."
      className={cn(
        "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold",
        "bg-primary/10 text-primary border border-primary/20",
        className,
      )}
    >
      <Sparkles className="h-2.5 w-2.5" />
      {label}
    </span>
  );
}
