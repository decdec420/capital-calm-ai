import { SectionHeader } from "@/components/trader/SectionHeader";
import { GuardrailRow } from "@/components/trader/GuardrailRow";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { Button } from "@/components/ui/button";
import { riskGuardrails } from "@/mocks/data";
import { ShieldAlert, ShieldCheck } from "lucide-react";

export default function RiskCenter() {
  const blocked = riskGuardrails.filter((g) => g.level === "blocked").length;
  const caution = riskGuardrails.filter((g) => g.level === "caution").length;

  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeader
        eyebrow="Risk Control"
        title="Guardrails & kill-switches"
        description="Capital preservation by default. Live trading is dangerous and explicitly gated."
        actions={
          <Button variant="outline" size="sm" className="gap-1.5 text-status-blocked border-status-blocked/40 hover:bg-status-blocked/10 hover:text-status-blocked">
            <ShieldAlert className="h-3.5 w-3.5" /> Engage kill-switch
          </Button>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="panel p-4 flex items-center gap-3">
          <div className="h-10 w-10 rounded-md bg-status-safe/15 text-status-safe flex items-center justify-center">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Overall posture</div>
            <div className="text-base font-semibold text-foreground">Capital protected</div>
          </div>
        </div>
        <div className="panel p-4">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Blocked checks</div>
          <div className="text-2xl font-semibold tabular text-status-blocked">{blocked}</div>
        </div>
        <div className="panel p-4">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Caution checks</div>
          <div className="text-2xl font-semibold tabular text-status-caution">{caution}</div>
        </div>
      </div>

      <div>
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3">All guardrails</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {riskGuardrails.map((g) => (
            <GuardrailRow key={g.id} guardrail={g} />
          ))}
        </div>
      </div>

      <div className="panel p-5 space-y-3 border-status-blocked/30">
        <div className="flex items-center gap-2">
          <StatusBadge tone="blocked" dot>live trading gate</StatusBadge>
          <span className="text-sm font-medium text-foreground">Currently blocked</span>
        </div>
        <ul className="text-sm space-y-1.5 text-muted-foreground">
          <li>✗ Approved strategy v1.3 has not completed 30 days of continuous paper trading</li>
          <li>✗ Live broker (Robinhood) connection is in shell mode only</li>
          <li>✓ Daily loss cap configured</li>
          <li>✓ Kill-switch armed</li>
          <li>✓ Balance floor set</li>
        </ul>
        <p className="text-xs text-muted-foreground italic pt-2 border-t border-border">
          Promotion to live mode requires every check above to pass and explicit operator confirmation.
        </p>
      </div>
    </div>
  );
}
