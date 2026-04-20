import { useState } from "react";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { ProfileEditor } from "@/components/trader/ProfileEditor";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle } from "lucide-react";
import { useSystemState } from "@/hooks/useSystemState";
import { useAccountState } from "@/hooks/useAccountState";
import type { SystemMode } from "@/lib/domain-types";
import { toast } from "sonner";

export default function Settings() {
  const { data: system, update: updateSystem } = useSystemState();
  const { data: account, update: updateAccount } = useAccountState();

  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeader eyebrow="Settings" title="Workspace & runtime" description="Manage paper account, mode controls, and runtime config." />

      <Section title="Workspace">
        <ProfileEditor />
      </Section>

      {account && (
        <Section title="Paper account">
          <AccountControls
            equity={account.equity}
            cash={account.cash}
            startOfDayEquity={account.startOfDayEquity}
            balanceFloor={account.balanceFloor}
            onSave={async (patch) => {
              try {
                await updateAccount(patch);
                toast.success("Account updated.");
              } catch {
                toast.error("Couldn't update account.");
              }
            }}
          />
        </Section>
      )}

      {system && (
        <Section title="Mode controls">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">Mode</Label>
              <Select
                value={system.mode}
                onValueChange={async (v) => {
                  try {
                    await updateSystem({ mode: v as SystemMode });
                    toast.success(`Mode → ${v}.`);
                  } catch {
                    toast.error("Couldn't change mode.");
                  }
                }}
              >
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="research">Research</SelectItem>
                  <SelectItem value="paper">Paper</SelectItem>
                  <SelectItem value="learning">Learning</SelectItem>
                  <SelectItem value="live" disabled={!system.liveTradingEnabled}>
                    Live {!system.liveTradingEnabled && "(gated)"}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-foreground">Kill-switch engaged</div>
                <div className="text-xs text-muted-foreground">Halts the bot immediately. Toggle off only when you mean it.</div>
              </div>
              <Switch
                checked={system.killSwitchEngaged}
                onCheckedChange={async (v) => {
                  try {
                    await updateSystem({ killSwitchEngaged: v, bot: v ? "halted" : "paused" });
                    toast.success(v ? "Kill-switch ENGAGED." : "Kill-switch disarmed.");
                  } catch {
                    toast.error("Couldn't toggle.");
                  }
                }}
              />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-foreground flex items-center gap-2">
                  Live trading enabled
                  <StatusBadge tone={system.liveTradingEnabled ? "safe" : "blocked"} size="sm">
                    {system.liveTradingEnabled ? "armed" : "gated"}
                  </StatusBadge>
                </div>
                <div className="text-xs text-muted-foreground">Requires every guardrail to pass. Real money. Be sure.</div>
              </div>
              <Switch
                checked={system.liveTradingEnabled}
                onCheckedChange={async (v) => {
                  try {
                    await updateSystem({ liveTradingEnabled: v });
                    toast.success(v ? "Live trading ARMED." : "Live trading disarmed.");
                  } catch {
                    toast.error("Couldn't toggle.");
                  }
                }}
              />
            </div>
          </div>

          <div className="mt-4 rounded-md border border-status-blocked/30 bg-status-blocked/5 p-3 flex items-start gap-3">
            <AlertTriangle className="h-4 w-4 text-status-blocked mt-0.5 shrink-0" />
            <p className="text-xs text-muted-foreground">
              Lovable doesn't ship a broker integration. Toggling live mode arms the UI gate but no real orders are sent — wire your own bot to read these flags.
            </p>
          </div>
        </Section>
      )}

      <Section title="Brokers (placeholder)">
        <Row label="Paper broker" value="Connected (UI only)" tone="safe" />
        <Row label="Live broker" value="Not configured" tone="blocked" />
      </Section>

      <Section title="Data sources">
        <Row label="Market data feed" value="Coinbase public (BTC-USD)" tone="safe" />
        <Row label="Indicator engine" value="In-browser, derived from candles" tone="safe" />
        <Row label="Refresh" value="every 30s" />
      </Section>

      <Section title="LLM provider">
        <Row label="AI Gateway" value="Lovable AI · gemini-3-flash-preview" tone="safe" />
        <Row label="Functions" value="copilot-chat · market-brief · journal-explain" />
      </Section>

      <Section title="Auth emails">
        <p className="text-xs text-muted-foreground">
          Currently using default Lovable auth emails. When you add a custom domain, ping me and I'll wire branded templates that match the Trader OS look.
        </p>
      </Section>
    </div>
  );
}

function AccountControls({
  equity,
  cash,
  startOfDayEquity,
  balanceFloor,
  onSave,
}: {
  equity: number;
  cash: number;
  startOfDayEquity: number;
  balanceFloor: number;
  onSave: (patch: { equity?: number; cash?: number; startOfDayEquity?: number; balanceFloor?: number }) => void;
}) {
  const [eq, setEq] = useState(String(equity));
  const [csh, setCsh] = useState(String(cash));
  const [sod, setSod] = useState(String(startOfDayEquity));
  const [floor, setFloor] = useState(String(balanceFloor));

  const dirty =
    Number(eq) !== equity || Number(csh) !== cash || Number(sod) !== startOfDayEquity || Number(floor) !== balanceFloor;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <NumField label="Equity" value={eq} onChange={setEq} />
        <NumField label="Cash" value={csh} onChange={setCsh} />
        <NumField label="Start of day" value={sod} onChange={setSod} />
        <NumField label="Balance floor" value={floor} onChange={setFloor} />
      </div>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground italic">
          Numbers are paper. Adjust to simulate any starting condition.
        </p>
        <Button
          size="sm"
          disabled={!dirty}
          onClick={() => onSave({ equity: Number(eq), cash: Number(csh), startOfDayEquity: Number(sod), balanceFloor: Number(floor) })}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</Label>
      <Input type="number" step="0.01" value={value} onChange={(e) => onChange(e.target.value)} />
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
