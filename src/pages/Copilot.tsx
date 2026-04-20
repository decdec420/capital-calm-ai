import { useEffect, useMemo, useRef, useState } from "react";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { SignalCard } from "@/components/trader/SignalCard";
import { AutonomyToggle } from "@/components/trader/AutonomyToggle";
import { SignalExplainDialog } from "@/components/trader/SignalExplainDialog";
import { CalibrationChart } from "@/components/trader/CalibrationChart";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useSystemState } from "@/hooks/useSystemState";
import { useAccountState } from "@/hooks/useAccountState";
import { useTrades } from "@/hooks/useTrades";
import { useStrategies } from "@/hooks/useStrategies";
import { useCandles } from "@/hooks/useCandles";
import { useSignals } from "@/hooks/useSignals";
import { computeRegime } from "@/lib/regime";
import { Send, Sparkles, Brain, Play, Check, X, Telescope } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TradeSignal } from "@/lib/domain-types";

type Msg = { role: "user" | "assistant"; content: string };

const SUGGESTED = [
  "What's the current regime telling me?",
  "Should I be sitting on hands right now?",
  "Why did my last trade lose / win?",
  "Which guardrail is closest to tripping?",
];

export default function Copilot() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [running, setRunning] = useState(false);
  const [explainSignal, setExplainSignal] = useState<TradeSignal | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { data: system } = useSystemState();
  const { data: account } = useAccountState();
  const { open, closed } = useTrades();
  const { strategies } = useStrategies();
  const { candles } = useCandles();
  const { pending, history } = useSignals();
  const regime = useMemo(() => computeRegime("BTC-USD", candles), [candles]);
  const activeSignal = pending[0];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const runEngine = async () => {
    if (running) return;
    setRunning(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Sign in first.");
        return;
      }
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/signal-engine`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) {
        if (res.status === 429) toast.error("Rate limited. Give it a sec.");
        else if (res.status === 402) toast.error("AI credits depleted.");
        else toast.error(json.error ?? "Engine failed");
        return;
      }
      if (json.tick === "halted") {
        toast.info(`Halted: ${json.reasons.join(", ")}`);
      } else if (json.tick === "skipped") {
        toast.info("AI chose to skip. Logged to journal.");
      } else if (json.tick === "executed") {
        toast.success("Auto-executed!");
      } else if (json.tick === "proposed") {
        toast.success("New signal proposed.");
      }
    } catch {
      toast.error("Engine connection error.");
    } finally {
      setRunning(false);
    }
  };

  const buildContext = () => ({
    mode: system?.mode,
    bot: system?.bot,
    autonomy: system?.autonomyLevel,
    liveTradingEnabled: system?.liveTradingEnabled,
    killSwitchEngaged: system?.killSwitchEngaged,
    account: account ? { equity: account.equity, balanceFloor: account.balanceFloor } : null,
    regime,
    openPosition: open[0] ?? null,
    pendingSignal: activeSignal ?? null,
    recentClosed: closed.slice(0, 5).map((t) => ({ side: t.side, outcome: t.outcome, pnlPct: t.pnlPct })),
    recentSignals: history.slice(0, 5).map((s) => ({
      side: s.side,
      status: s.status,
      confidence: s.confidence,
      decidedBy: s.decidedBy,
    })),
    approvedStrategy: strategies.find((s) => s.status === "approved"),
  });

  const send = async (text: string) => {
    if (!text.trim() || streaming) return;
    const userMsg: Msg = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setStreaming(true);

    let buffer = "";
    const upsert = (chunk: string) => {
      buffer += chunk;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant") {
          return prev.map((m, i) => (i === prev.length - 1 ? { ...m, content: buffer } : m));
        }
        return [...prev, { role: "assistant", content: buffer }];
      });
    };

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) {
        toast.error("Sign in to use the Copilot.");
        setStreaming(false);
        return;
      }

      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/copilot-chat`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({
          messages: [...messages, userMsg],
          context: buildContext(),
        }),
      });

      if (!resp.ok || !resp.body) {
        if (resp.status === 401) toast.error("Sign in to use the Copilot.");
        else if (resp.status === 429) toast.error("Rate limit reached. Give it a moment.");
        else if (resp.status === 402) toast.error("AI credits depleted. Top up in Settings → Workspace → Usage.");
        else toast.error("Copilot failed to respond.");
        setStreaming(false);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let textBuffer = "";
      let done = false;

      while (!done) {
        const { value, done: rdone } = await reader.read();
        if (rdone) break;
        textBuffer += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = textBuffer.indexOf("\n")) !== -1) {
          let line = textBuffer.slice(0, idx);
          textBuffer = textBuffer.slice(idx + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line.startsWith(":") || line.trim() === "") continue;
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (json === "[DONE]") {
            done = true;
            break;
          }
          try {
            const parsed = JSON.parse(json);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) upsert(delta);
          } catch {
            textBuffer = line + "\n" + textBuffer;
            break;
          }
        }
      }
    } catch (e) {
      console.error(e);
      toast.error("Copilot connection error.");
    } finally {
      setStreaming(false);
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeader
        eyebrow="AI Copilot · Signal Bridge"
        title="Operator console"
        description="The AI watches the tape, reasons over your context, and proposes trades. You approve. The bridge between brain and broker."
        actions={
          <>
            <Button size="sm" onClick={runEngine} disabled={running} className="gap-1.5">
              <Play className="h-3.5 w-3.5" /> {running ? "Thinking…" : "Run engine now"}
            </Button>
            <StatusBadge tone="accent" dot pulse={streaming || running}>
              <Sparkles className="h-3 w-3" /> {running ? "engine" : streaming ? "thinking" : "ready"}
            </StatusBadge>
          </>
        }
      />

      {/* SIGNAL BRIDGE — top of page */}
      {activeSignal ? (
        <SignalCard signal={activeSignal} />
      ) : (
        <div className="panel p-6 text-center border-dashed">
          <div className="h-10 w-10 rounded-md bg-secondary text-muted-foreground flex items-center justify-center mx-auto mb-3">
            <Brain className="h-5 w-5" />
          </div>
          <p className="text-sm font-medium text-foreground">No pending signals</p>
          <p className="text-xs text-muted-foreground mt-1">
            Tap <span className="text-primary">Run engine now</span> to make the AI read the tape and propose (or skip).
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* CHAT */}
        <div className="lg:col-span-3 panel flex flex-col" style={{ minHeight: "55vh" }}>
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-center py-12">
                <div className="h-12 w-12 rounded-md bg-primary/15 text-primary flex items-center justify-center mb-3">
                  <Sparkles className="h-5 w-5" />
                </div>
                <p className="text-sm font-medium text-foreground">Ask the Copilot</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                  Live context (mode, regime, position, signals, autonomy) is auto-attached.
                </p>
                <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-2 w-full max-w-2xl">
                  {SUGGESTED.map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="text-left text-xs px-3 py-2.5 rounded-md border border-border bg-card hover:bg-accent hover:border-primary/30 transition-colors text-muted-foreground hover:text-foreground"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                <div
                  className={cn(
                    "max-w-[85%] rounded-lg px-3.5 py-2.5 text-sm",
                    m.role === "user"
                      ? "bg-primary/15 border border-primary/25 text-foreground"
                      : "bg-secondary border border-border text-foreground",
                  )}
                >
                  {m.role === "assistant" ? (
                    <div className="prose prose-sm prose-invert max-w-none prose-p:my-1.5 prose-li:my-0.5 prose-headings:text-foreground prose-strong:text-foreground prose-code:text-primary">
                      <ReactMarkdown>{m.content || "…"}</ReactMarkdown>
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
                  )}
                </div>
              </div>
            ))}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="border-t border-border p-3 flex gap-2 items-end"
          >
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              placeholder="Ask about the system, market, or a signal…"
              className="min-h-[44px] max-h-32 resize-none bg-background border-border"
              disabled={streaming}
            />
            <Button type="submit" size="icon" disabled={streaming || !input.trim()} className="shrink-0 h-11 w-11">
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>

        {/* SIDE RAIL */}
        <div className="space-y-3">
          <AutonomyToggle />

          <div className="panel p-4">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">Context attached</div>
            <ul className="text-xs text-muted-foreground space-y-1.5">
              <li>• Mode: <span className="text-foreground capitalize">{system?.mode ?? "—"}</span></li>
              <li>• Regime: <span className="text-foreground capitalize">{regime.regime.replace("_", " ")}</span></li>
              <li>• Open: <span className="text-foreground">{open[0] ? `${open[0].side} ${open[0].symbol}` : "none"}</span></li>
              <li>• Pending signal: <span className="text-foreground">{activeSignal ? `${activeSignal.side} (${(activeSignal.confidence*100).toFixed(0)}%)` : "none"}</span></li>
            </ul>
          </div>
        </div>
      </div>

      {/* SIGNAL HISTORY — the AI's report card */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Signal history</div>
          <span className="text-xs text-muted-foreground">{history.length} decisions</span>
        </div>
        {history.length === 0 ? (
          <div className="panel p-6 text-center text-xs text-muted-foreground italic">
            No history yet. Every tick — propose, skip, or halt — lands here.
          </div>
        ) : (
          <div className="space-y-2">
            {history.slice(0, 10).map((s) => (
              <div key={s.id} className="panel p-3 flex items-center gap-3 text-sm">
                <StatusIcon status={s.status} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground capitalize">{s.side} {s.symbol}</span>
                    <span className="text-xs text-muted-foreground">@ ${s.proposedEntry.toFixed(0)}</span>
                    <StatusBadge tone={statusTone(s.status)} size="sm">{s.status}</StatusBadge>
                    {s.decidedBy && <span className="text-[10px] text-muted-foreground">by {s.decidedBy}</span>}
                  </div>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">{s.aiReasoning || s.decisionReason}</p>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs tabular text-foreground">{(s.confidence * 100).toFixed(0)}%</div>
                  <div className="text-[10px] text-muted-foreground">{new Date(s.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === "executed") return <div className="h-7 w-7 rounded-md bg-status-safe/15 text-status-safe flex items-center justify-center shrink-0"><Check className="h-3.5 w-3.5" /></div>;
  if (status === "rejected") return <div className="h-7 w-7 rounded-md bg-status-blocked/15 text-status-blocked flex items-center justify-center shrink-0"><X className="h-3.5 w-3.5" /></div>;
  return <div className="h-7 w-7 rounded-md bg-secondary text-muted-foreground flex items-center justify-center shrink-0"><Brain className="h-3.5 w-3.5" /></div>;
}

function statusTone(status: string): "safe" | "blocked" | "neutral" | "candidate" {
  if (status === "executed") return "safe";
  if (status === "rejected") return "blocked";
  if (status === "pending") return "candidate";
  return "neutral";
}
