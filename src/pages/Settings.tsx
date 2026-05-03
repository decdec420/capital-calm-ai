import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { ProfileEditor } from "@/components/trader/ProfileEditor";
import { KillSwitchDialog } from "@/components/trader/KillSwitchDialog";
import { LiveMoneyAcknowledgmentDialog } from "@/components/trader/LiveMoneyAcknowledgmentDialog";
import { ArmLiveConfirmDialog } from "@/components/trader/ArmLiveConfirmDialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { NumberStepper } from "@/components/trader/NumberStepper";
import { Label } from "@/components/ui/label";

import { AlertTriangle, Compass, Plug, Wallet } from "lucide-react";
import { useSystemState } from "@/hooks/useSystemState";
import { useAccountState } from "@/hooks/useAccountState";
import { WELCOME_KEY } from "@/pages/Welcome";
import { BrokerConnectionCard } from "@/components/trader/BrokerConnectionCard";
import { supabase } from "@/integrations/supabase/client";

import { toast } from "sonner";

export default function Settings() {
  const { data: system, update: updateSystem, acknowledgeLiveMoney } = useSystemState();
  const { data: account, update: updateAccount, refetch: refetchAccount } = useAccountState();
  const [killOpen, setKillOpen] = useState(false);
  const [ackOpen, setAckOpen] = useState(false);
  const [armConfirmOpen, setArmConfirmOpen] = useState(false);
  const navigate = useNavigate();

  const replayTour = () => {
    localStorage.removeItem(WELCOME_KEY);
    navigate("/welcome");
  };

  const confirmKill = async () => {
    if (!system) return;
    const v = !system.killSwitchEngaged;
    try {
      await updateSystem({ killSwitchEngaged: v, bot: v ? "halted" : "paused" });
      toast.success(v ? "Kill-switch ENGAGED." : "Kill-switch disarmed.");
    } catch {
      toast.error("Couldn't toggle.");
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeader eyebrow="Settings" title="Workspace & runtime" description="Manage paper account, bot controls, and runtime config." />

      <Section title="Workspace">
        <ProfileEditor />
      </Section>

      {account && (
        <Section id="paper-account" title="Paper account">
          <AccountControls
            equity={account.equity}
            cash={account.cash}
            startOfDayEquity={account.startOfDayEquity}
            balanceFloor={account.balanceFloor}
            liveArmed={!!system?.liveTradingEnabled}
            onSaveFloor={async (floor) => {
              try {
                await updateAccount({ balanceFloor: floor });
                toast.success("Balance floor updated.");
              } catch {
                toast.error("Couldn't update balance floor.");
              }
            }}
            onTopUp={async (amount) => {
              const { data, error } = await supabase.functions.invoke("topup-paper-balance", {
                body: { amount_usd: amount },
              });
              if (error || (data && (data as { error?: string }).error)) {
                const msg = (data as { error?: string } | null)?.error ?? error?.message ?? "Top-up failed";
                toast.error(msg);
                return;
              }
              toast.success(`Added $${amount.toLocaleString()} to paper balance.`);
              await refetchAccount();
            }}
          />
        </Section>
      )}

      {system && (
        <Section title="Bot controls">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-foreground">Kill-switch engaged</div>
                <div className="text-xs text-muted-foreground">Halts the bot immediately. Toggle off only when you mean it.</div>
              </div>
              <Switch
                checked={system.killSwitchEngaged}
                onCheckedChange={() => setKillOpen(true)}
              />
            </div>

            <div>
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
                  // P5-F: cannot arm without a real broker connection.
                  // Disarming (on→off) is always allowed regardless.
                  disabled={!system.liveTradingEnabled && system.brokerConnection !== "connected"}
                  onCheckedChange={async (v) => {
                    // Disarm path: free, instant, no friction.
                    if (!v) {
                      try {
                        await updateSystem({ liveTradingEnabled: false });
                        toast.success("Live trading disarmed.");
                      } catch {
                        toast.error("Couldn't toggle.");
                      }
                      return;
                    }
                    // Arm path: first-ever flip → type-to-confirm acknowledgment.
                    if (!system.liveMoneyAcknowledgedAt) {
                      setAckOpen(true);
                      return;
                    }
                    // Arm path: every subsequent flip → simple click-to-confirm.
                    setArmConfirmOpen(true);
                  }}
                />
              </div>

              {system.brokerConnection !== "connected" && (
                <p className="mt-2 text-xs text-muted-foreground flex items-center gap-1.5">
                  <Plug className="h-3 w-3 text-status-caution shrink-0" />
                  Connect a broker before arming live trading.{" "}
                  <a
                    href="#brokers"
                    className="text-primary hover:underline"
                    onClick={(e) => {
                      e.preventDefault();
                      document.getElementById("brokers")?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                  >
                    Configure brokers →
                  </a>
                </p>
              )}
            </div>
          </div>

          <div className="mt-4 rounded-md border border-status-blocked/30 bg-status-blocked/5 p-3 flex items-start gap-3">
            <AlertTriangle className="h-4 w-4 text-status-blocked mt-0.5 shrink-0" />
            <p className="text-xs text-muted-foreground">
              Live mode arms the server-side gate. The execution path exists but stays paper-only until a broker is configured and the autonomy acknowledgment is signed. Every order is still subject to the doctrine, sizing, and risk guardrails.
            </p>
          </div>
        </Section>
      )}

      <Section id="brokers" title="Broker connection">
        <BrokerConnectionCard />
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

      <Section title="Onboarding">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-foreground">Replay the welcome tour</div>
            <div className="text-xs text-muted-foreground">Forgot what each tab does? Take the 60-second walkthrough again.</div>
          </div>
          <Button variant="outline" size="sm" onClick={replayTour}>
            <Compass className="h-3.5 w-3.5" />
            Replay tour
          </Button>
        </div>
      </Section>

      {system && (
        <KillSwitchDialog
          open={killOpen}
          onOpenChange={setKillOpen}
          engaged={system.killSwitchEngaged}
          onConfirm={confirmKill}
        />
      )}

      <LiveMoneyAcknowledgmentDialog
        open={ackOpen}
        onOpenChange={setAckOpen}
        onConfirm={async () => {
          try {
            await acknowledgeLiveMoney();
            await updateSystem({ liveTradingEnabled: true });
            toast.success("Live trading ARMED.");
          } catch {
            toast.error("Couldn't sign acknowledgment.");
          }
        }}
      />

      <ArmLiveConfirmDialog
        open={armConfirmOpen}
        onOpenChange={setArmConfirmOpen}
        onConfirm={async () => {
          try {
            await updateSystem({ liveTradingEnabled: true });
            toast.success("Live trading ARMED.");
          } catch {
            toast.error("Couldn't arm live trading.");
          }
        }}
      />
    </div>
  );
}

function AccountControls({
  equity,
  cash,
  startOfDayEquity,
  balanceFloor,
  onSaveFloor,
}: {
  equity: number;
  cash: number;
  startOfDayEquity: number;
  balanceFloor: number;
  onSaveFloor: (floor: number) => void;
}) {
  const [floor, setFloor] = useState(String(balanceFloor));
  const dirty = Number(floor) !== balanceFloor;

  const dailyPnl = equity - startOfDayEquity;
  const dailyPnlPct = startOfDayEquity > 0 ? (dailyPnl / startOfDayEquity) * 100 : 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <ReadOnlyField label="Equity" value={`$${equity.toFixed(2)}`} />
        <ReadOnlyField label="Cash" value={`$${cash.toFixed(2)}`} />
        <ReadOnlyField label="Start of day" value={`$${startOfDayEquity.toFixed(2)}`} />
        <NumField label="Balance floor" value={floor} onChange={setFloor} />
      </div>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground italic">
          Equity, cash, and start-of-day are computed server-side from real fills — the
          browser can't edit them. Only the balance floor is yours to move.
        </p>
        <Button
          size="sm"
          disabled={!dirty}
          onClick={() => onSaveFloor(Number(floor))}
        >
          Save floor
        </Button>
      </div>

      <div className="rounded-md border border-border/60 bg-muted/20 p-3">
        <div className="text-sm font-medium text-foreground">Today's P&amp;L</div>
        <div className="text-xs text-muted-foreground">
          <span className="tabular">{dailyPnl >= 0 ? "+" : ""}${dailyPnl.toFixed(2)}</span>{" "}
          ({dailyPnlPct >= 0 ? "+" : ""}{dailyPnlPct.toFixed(2)}%) on the day.
          Start-of-day snapshot is rolled automatically by the mark-to-market cron at 00:00 UTC.
        </div>
      </div>
    </div>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</Label>
      <div className="text-sm tabular rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-foreground">
        {value}
      </div>
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</Label>
      <NumberStepper value={value} onChange={onChange} step={0.01} shiftMultiplier={10} precision={2} />
    </div>
  );
}

function Section({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return (
    <div id={id} className="panel p-5 scroll-mt-20">
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
