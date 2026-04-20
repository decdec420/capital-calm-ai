import { StatusBadge } from "./StatusBadge";
import type { Regime } from "@/lib/domain-types";

const regimeLabel: Record<Regime, string> = {
  trending_up: "Trending ↑",
  trending_down: "Trending ↓",
  range: "Range",
  chop: "Chop",
  breakout: "Breakout",
};

const regimeTone: Record<Regime, "safe" | "caution" | "neutral" | "candidate"> = {
  trending_up: "safe",
  trending_down: "caution",
  range: "neutral",
  chop: "caution",
  breakout: "candidate",
};

export function RegimeBadge({ regime, confidence }: { regime: Regime; confidence?: number }) {
  return (
    <StatusBadge tone={regimeTone[regime]} dot>
      {regimeLabel[regime]}
      {confidence !== undefined && (
        <span className="ml-1 opacity-70 tabular">{(confidence * 100).toFixed(0)}%</span>
      )}
    </StatusBadge>
  );
}
