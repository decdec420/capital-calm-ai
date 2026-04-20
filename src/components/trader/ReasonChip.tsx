import { cn } from "@/lib/utils";

interface ReasonChipProps {
  label: string;
  tone?: "safe" | "caution" | "blocked" | "neutral" | "candidate";
  className?: string;
}

const toneClass: Record<NonNullable<ReasonChipProps["tone"]>, string> = {
  safe: "bg-status-safe/10 text-status-safe border-status-safe/20",
  caution: "bg-status-caution/10 text-status-caution border-status-caution/20",
  blocked: "bg-status-blocked/10 text-status-blocked border-status-blocked/20",
  candidate: "bg-status-candidate/10 text-status-candidate border-status-candidate/20",
  neutral: "bg-secondary text-muted-foreground border-border",
};

export function ReasonChip({ label, tone = "neutral", className }: ReasonChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium tracking-wide",
        toneClass[tone],
        className,
      )}
    >
      {label}
    </span>
  );
}
