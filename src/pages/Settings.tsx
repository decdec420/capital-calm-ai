import { SectionHeader } from "@/components/trader/SectionHeader";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { systemState } from "@/mocks/data";
import { AlertTriangle } from "lucide-react";

export default function Settings() {
  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeader eyebrow="Settings" title="Integrations & runtime" description="Read-only view of broker, data, and runtime configuration." />

      <Section title="Brokers">
        <Row label="Paper broker" value="Connected" tone="safe" />
        <Row label="Robinhood (live)" value="Shell only — not connected" tone="blocked" />
      </Section>

      <Section title="Mode controls">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-foreground">Paper mode</div>
              <div className="text-xs text-muted-foreground">Default safe mode for testing strategies.</div>
            </div>
            <Switch defaultChecked />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-foreground">Learning mode</div>
              <div className="text-xs text-muted-foreground">Allow controlled experiments to run.</div>
            </div>
            <Switch defaultChecked />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-foreground flex items-center gap-2">
                Live mode
                <StatusBadge tone="blocked" size="sm">gated</StatusBadge>
              </div>
              <div className="text-xs text-muted-foreground">Requires gate clearance + explicit confirmation.</div>
            </div>
            <Switch disabled />
          </div>
        </div>

        <div className="mt-4 rounded-md border border-status-blocked/30 bg-status-blocked/5 p-3 flex items-start gap-3">
          <AlertTriangle className="h-4 w-4 text-status-blocked mt-0.5 shrink-0" />
          <p className="text-xs text-muted-foreground">
            Enabling live mode requires every check in the Risk Center to pass and a typed confirmation phrase. This is intentional friction.
          </p>
        </div>
      </Section>

      <Section title="Data sources">
        <Row label="Market data feed" value={systemState.dataFeed} tone={systemState.dataFeed === "connected" ? "safe" : "blocked"} />
        <Row label="Indicator engine" value="online" tone="safe" />
        <Row label="Tick latency" value={`${systemState.latencyMs}ms`} />
      </Section>

      <Section title="LLM provider">
        <Row label="AI Gateway" value="Lovable AI · gemini-3-flash-preview" tone="safe" />
        <Row label="System prompt" value="Operator console · risk-first" />
      </Section>

      <Section title="Runtime config (read-only)">
        <pre className="text-xs font-mono text-muted-foreground bg-secondary/50 border border-border rounded-md p-3 overflow-x-auto">
{`symbol: BTC-USD
mode: ${systemState.mode}
strategy: trend-rev v1.3
max_order_pct: 0.25
daily_loss_cap_pct: 1.50
daily_trade_cap: 6
balance_floor: 9500
spread_max_bps: 5.0
stale_data_max_s: 5.0`}
        </pre>
      </Section>

      <Section title="Feature flags">
        <FlagRow label="Multi-strategy framework" enabled={false} />
        <FlagRow label="Auto-promotion" enabled={false} />
        <FlagRow label="Volatility-adjusted sizing" enabled={true} />
        <FlagRow label="LLM postmortems" enabled={true} />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="panel p-5">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3">{title}</div>
      {children}
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: "safe" | "blocked" | "caution" }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      {tone ? (
        <StatusBadge tone={tone} size="sm" dot>
          {value}
        </StatusBadge>
      ) : (
        <span className="text-sm tabular text-foreground">{value}</span>
      )}
    </div>
  );
}

function FlagRow({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-sm text-foreground">{label}</span>
      <Switch checked={enabled} />
    </div>
  );
}
