import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import {
  Activity,
  Radar,
  ListOrdered,
  BookOpen,
  FlaskConical,
  ShieldCheck,
  GraduationCap,
  Sparkles,
  ArrowRight,
  ArrowLeft,
  Check,
} from "lucide-react";

const WELCOME_KEY = "trader-os:welcome-seen";

type Tab = { icon: typeof Activity; name: string; blurb: string };

type Step = {
  eyebrow: string;
  title: string;
  pitch: string;
  accent: string;
  tabs: Tab[];
};

const STEPS: Step[] = [
  {
    eyebrow: "Step 1 of 5",
    title: "Welcome to Trader OS",
    pitch:
      "Your AI-assisted cockpit for running a disciplined trading bot. Three groups, nine tabs, zero guesswork. We'll walk you through it in 60 seconds.",
    accent: "from-primary/20 to-primary/0",
    tabs: [],
  },
  {
    eyebrow: "Step 2 of 5 · Operations",
    title: "What's happening right now",
    pitch:
      "Your day-to-day cockpit. Start at Overview every session, scan the market, check your trades, review what the bot did and why.",
    accent: "from-status-safe/25 to-status-safe/0",
    tabs: [
      { icon: Activity, name: "Overview", blurb: "Mission control. Equity, P&L, signals at a glance." },
      { icon: Radar, name: "Market Intel", blurb: "Live prices + AI brief. Should you even trade today?" },
      { icon: ListOrdered, name: "Trades", blurb: "Every open & closed position. Where your money sits." },
      { icon: BookOpen, name: "Journals", blurb: "Auto-logged events with AI explanations. The diary." },
    ],
  },
  {
    eyebrow: "Step 3 of 5 · Strategy",
    title: "Get better, don't blow up",
    pitch:
      "The lab and the seatbelt. Tweak rules, backtest, set guardrails, learn from your own patterns over time.",
    accent: "from-status-warn/25 to-status-warn/0",
    tabs: [
      { icon: FlaskConical, name: "Strategy Lab", blurb: "Backtest tweaks. Version your edge." },
      { icon: ShieldCheck, name: "Risk Center", blurb: "Daily loss caps, kill-switch, exposure limits." },
      { icon: GraduationCap, name: "Learning", blurb: "Calibration, win-rate by regime, weak spots." },
    ],
  },
  {
    eyebrow: "Step 4 of 5 · Assistant",
    title: "Your AI second opinion",
    pitch:
      "Copilot knows your trades, journals, and the current market. Ask it anything — 'why did I lose money this week?' is a great opener.",
    accent: "from-primary/25 to-primary/0",
    tabs: [
      { icon: Sparkles, name: "AI Copilot", blurb: "Chat with context-aware AI. No vague answers." },
    ],
  },
  {
    eyebrow: "Step 5 of 5 · Setup",
    title: "Set your paper account",
    pitch: "Takes 30 seconds. You can change these any time in Settings → Paper account.",
    accent: "from-primary/20 to-primary/0",
    tabs: [],
  },
];

export default function Welcome() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [equity, setEquity] = useState("");
  const [floor, setFloor] = useState("");
  const [lossCap, setLossCap] = useState("1.5");
  const [saving, setSaving] = useState(false);
  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;
  const isFirst = step === 0;

  const equityNum = parseFloat(equity);
  const floorNum = parseFloat(floor);
  const lossCapNum = parseFloat(lossCap);
  const validSetup =
    Number.isFinite(equityNum) && equityNum > 0 &&
    Number.isFinite(floorNum) && floorNum >= 0 && floorNum < equityNum &&
    Number.isFinite(lossCapNum) && lossCapNum > 0 && lossCapNum <= 100;
  const floorPct = validSetup ? (floorNum / equityNum) * 100 : null;
  const maxDailyLoss = validSetup ? (equityNum * lossCapNum) / 100 : null;

  // Setup-step button is disabled when any of the three fields is empty,
  // non-numeric, or floor is >= equity (which would make the floor pointless).
  const setupBlocked =
    !Number.isFinite(equityNum) || equityNum <= 0 ||
    !Number.isFinite(floorNum) || floorNum < 0 ||
    !Number.isFinite(lossCapNum) || lossCapNum <= 0 ||
    floorNum >= equityNum;
  const finishDisabled = saving || (step === 4 && setupBlocked);

  const finish = async () => {
    if (step === 4) {
      setSaving(true);
      try {
        const { data: sess } = await supabase.auth.getUser();
        const uid = sess.user?.id;
        if (uid) {
          const { error } = await supabase
            .from("account_state")
            .update({
              equity: equityNum,
              cash: equityNum,
              start_of_day_equity: equityNum,
              balance_floor: floorNum,
            })
            .eq("user_id", uid);
          if (error) console.error("[Welcome] account_state update failed:", error);
        }
      } catch (e) {
        // Non-blocking — onboarding completes even if the write fails.
        console.error("[Welcome] setup save error:", e);
      } finally {
        setSaving(false);
      }
    }
    localStorage.setItem(WELCOME_KEY, "1");
    navigate("/", { replace: true });
  };

  const skip = () => {
    localStorage.setItem(WELCOME_KEY, "1");
    navigate("/", { replace: true });
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">Trader OS · Onboarding</div>
        <Button variant="ghost" size="sm" onClick={skip} className="text-xs">
          Skip the tour
        </Button>
      </div>

      {/* Body */}
      <div className="flex-1 flex items-center justify-center p-6">
        <Card className="w-full max-w-3xl overflow-hidden border-border">
          {/* Accent header */}
          <div className={`bg-gradient-to-br ${current.accent} px-8 pt-8 pb-6`}>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
              {current.eyebrow}
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-foreground mb-3">{current.title}</h1>
            <p className="text-sm text-muted-foreground leading-relaxed max-w-2xl">{current.pitch}</p>
          </div>

          {/* Tabs grid */}
          {current.tabs.length > 0 && (
            <div className="px-8 py-6 grid gap-3 sm:grid-cols-2">
              {current.tabs.map((tab) => {
                const Icon = tab.icon;
                return (
                  <div
                    key={tab.name}
                    className="flex gap-3 rounded-md border border-border bg-card/40 p-3 hover:border-primary/40 transition-colors"
                  >
                    <div className="h-9 w-9 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                      <Icon className="h-4 w-4 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground">{tab.name}</div>
                      <div className="text-xs text-muted-foreground leading-snug">{tab.blurb}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Setup form for step 5 */}
          {step === 4 && (
            <div className="px-8 py-6 space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="welcome-equity" className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    Starting paper equity
                  </Label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                    <Input
                      id="welcome-equity"
                      inputMode="decimal"
                      type="number"
                      min="0"
                      placeholder="e.g. 10.00"
                      value={equity}
                      onChange={(e) => setEquity(e.target.value)}
                      className="pl-7 font-mono"
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="welcome-floor" className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    Balance floor
                  </Label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                    <Input
                      id="welcome-floor"
                      inputMode="decimal"
                      type="number"
                      min="0"
                      placeholder="e.g. 8.00"
                      value={floor}
                      onChange={(e) => setFloor(e.target.value)}
                      className="pl-7 font-mono"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {floorPct !== null
                      ? `${floorPct.toFixed(1)}% of starting equity. Bot halts if equity touches this.`
                      : "Bot halts if equity touches this."}
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="welcome-losscap" className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Daily loss cap (%)
                </Label>
                <div className="relative max-w-[180px]">
                  <Input
                    id="welcome-losscap"
                    inputMode="decimal"
                    type="number"
                    min="0"
                    step="0.1"
                    value={lossCap}
                    onChange={(e) => setLossCap(e.target.value)}
                    className="pr-7 font-mono"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Bot halts when daily loss exceeds this of starting equity.
                </p>
              </div>

              {validSetup && (
                <div className="rounded-md border border-primary/30 bg-primary/5 p-4 grid grid-cols-3 gap-3">
                  <PreviewStat label="Equity" value={`$${equityNum.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
                  <PreviewStat label="Floor" value={`$${floorNum.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
                  <PreviewStat
                    label="Max daily loss"
                    value={`$${(maxDailyLoss ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
                  />
                </div>
              )}
            </div>
          )}

          {/* Hero illustration for step 1 */}
          {isFirst && (
            <div className="px-8 py-10 grid grid-cols-3 gap-3 text-center">
              {[
                { label: "Operations", desc: "Run the day", icon: Activity },
                { label: "Strategy", desc: "Sharpen the edge", icon: FlaskConical },
                { label: "Assistant", desc: "Think out loud", icon: Sparkles },
              ].map((g) => {
                const Icon = g.icon;
                return (
                  <div key={g.label} className="rounded-md border border-border bg-card/40 p-4">
                    <div className="h-10 w-10 mx-auto rounded-md bg-primary/10 flex items-center justify-center mb-2">
                      <Icon className="h-5 w-5 text-primary" />
                    </div>
                    <div className="text-sm font-medium text-foreground">{g.label}</div>
                    <div className="text-[11px] text-muted-foreground">{g.desc}</div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Footer / nav */}
          <div className="border-t border-border px-8 py-4 flex items-center justify-between">
            {/* Progress dots */}
            <div className="flex gap-1.5">
              {STEPS.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setStep(i)}
                  aria-label={`Go to step ${i + 1}`}
                  className={`h-1.5 rounded-full transition-all ${
                    i === step ? "w-6 bg-primary" : "w-1.5 bg-muted-foreground/30 hover:bg-muted-foreground/60"
                  }`}
                />
              ))}
            </div>

            <div className="flex items-center gap-2">
              {!isFirst && (
                <Button variant="ghost" size="sm" onClick={() => setStep(step - 1)}>
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back
                </Button>
              )}
              {!isLast ? (
                <Button size="sm" onClick={() => setStep(step + 1)}>
                  Next
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              ) : (
                <Button size="sm" onClick={finish} disabled={finishDisabled}>
                  <Check className="h-3.5 w-3.5" />
                  {saving ? "Setting up…" : "Take me to Overview"}
                </Button>
              )}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function PreviewStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm font-mono text-foreground tabular">{value}</div>
    </div>
  );
}

export { WELCOME_KEY };
