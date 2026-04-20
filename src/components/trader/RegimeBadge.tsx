import { StatusBadge } from "./StatusBadge";
import { Explain } from "./Explain";
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

const regimeHint: Record<Regime, string> = {
  trending_up: "Price is making higher highs — momentum strategies tend to work, mean-reversion gets steamrolled.",
  trending_down: "Price is making lower lows — shorts favored, longs are catching knives.",
  range: "Price is bouncing in a band. Fade extremes, don't chase breakouts that fail.",
  chop: "No clean direction. Hardest regime to trade — consider sitting on hands.",
  breakout: "Price just escaped a range. High-conviction window, but false breakouts punish late entries.",
};

export function RegimeBadge({ regime, confidence }: { regime: Regime; confidence?: number }) {
  return (
    <Explain
      inline
      title={`Market regime: ${regimeLabel[regime]}`}
      hint={
        <>
          {regimeHint[regime]}
          {confidence !== undefined && (
            <div className="mt-1.5 text-[11px]">
              Confidence {(confidence * 100).toFixed(0)}% — how sure the classifier is. Below ~60% means treat with salt.
            </div>
          )}
        </>
      }
    >
      <StatusBadge tone={regimeTone[regime]} dot>
        {regimeLabel[regime]}
        {confidence !== undefined && (
          <span className="ml-1 opacity-70 tabular">{(confidence * 100).toFixed(0)}%</span>
        )}
      </StatusBadge>
    </Explain>
  );
}
