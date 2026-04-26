import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
    eyebrow: "Step 4 of 4 · Assistant",
    title: "Your AI second opinion",
    pitch:
      "Copilot knows your trades, journals, and the current market. Ask it anything — 'why did I lose money this week?' is a great opener.",
    accent: "from-primary/25 to-primary/0",
    tabs: [
      { icon: Sparkles, name: "AI Copilot", blurb: "Chat with context-aware AI. No vague answers." },
    ],
  },
];

export default function Welcome() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;
  const isFirst = step === 0;

  const finish = () => {
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
                <Button size="sm" onClick={finish}>
                  <Check className="h-3.5 w-3.5" />
                  Take me to Overview
                </Button>
              )}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

export { WELCOME_KEY };
