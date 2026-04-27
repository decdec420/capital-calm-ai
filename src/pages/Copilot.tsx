import { useEffect, useMemo, useRef, useState } from "react";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { SignalCard } from "@/components/trader/SignalCard";
import { AutonomyToggle } from "@/components/trader/AutonomyToggle";
import { SignalExplainDialog } from "@/components/trader/SignalExplainDialog";
import { CalibrationChart } from "@/components/trader/CalibrationChart";
import { MultiSymbolStrip } from "@/components/trader/MultiSymbolStrip";
import { MarketIntelligencePanel } from "@/components/trader/MarketIntelligencePanel";
import { GateReasonList, gateIconFor, gateToneFor } from "@/components/trader/GateReasonRow";
import { ConversationSidebar } from "@/components/trader/ConversationSidebar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { RegimeBadge } from "@/components/trader/RegimeBadge";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useSystemState } from "@/hooks/useSystemState";
import { useAccountState } from "@/hooks/useAccountState";
import { useTrades } from "@/hooks/useTrades";
import { useStrategies } from "@/hooks/useStrategies";
import { useExperiments } from "@/hooks/useExperiments";
import { useSignals } from "@/hooks/useSignals";
import { useConversations } from "@/hooks/useConversations";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { Send, Sparkles, Brain, Play, Check, X, Telescope, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { getProfile } from "@/lib/doctrine-constants";
import type { TradeSignal, GateReason } from "@/lib/domain-types";

const SUGGESTED = [
  "What's the board looking like right now?",
  "Should I be sitting on hands?",
  "What broke on my last trade?",
  "Which guardrail is closest to tripping?",
];

export default function Copilot() {
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [explainSignal, setExplainSignal] = useState<TradeSignal | null>(null);
  const [intelTimestamps, setIntelTimestamps] = useState<Record<string, string>>({});
  const [pipelineStep, setPipelineStep] = useState<
    null | "braintrust" | "engine" | "briefing" | "done" | "error"
  >(null);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { data: system } = useSystemState();
  const { data: account } = useAccountState();
  const { open, closed } = useTrades();
  const { strategies } = useStrategies();
  const { counts: expCounts, needsReview: expNeedsReview, recentlyAutoResolved: expRecent } = useExperiments();
  const { pending, history } = useSignals();
  const {
    conversations,
    activeId,
    setActiveId,
    messages,
    loading: convLoading,
    loadingMessages,
    createConversation,
    renameConversation,
    deleteConversation,
    appendLocalMessage,
    updateLastAssistant,
    reloadActiveMessages,
  } = useConversations();
  const snapshot = system?.lastEngineSnapshot ?? null;
  const chosenSym = snapshot?.chosenSymbol ?? null;
  const chosenRow =
    snapshot?.perSymbol.find((p) => p.symbol === chosenSym) ??
    snapshot?.perSymbol[0] ??
    null;
  const lastGateReasons: GateReason[] = snapshot?.gateReasons ?? [];
  const activeSignal = pending[0];
  const activeProfile = getProfile(system?.activeProfile);

  const lastBrainTrustRun = useMemo(() => {
    const times = Object.values(intelTimestamps).map((t) => new Date(t).getTime()).filter(Boolean);
    if (times.length === 0) return null;
    return new Date(Math.max(...times));
  }, [intelTimestamps]);

  const lastEngineRun = useMemo(() => {
    const ts = (system?.lastEngineSnapshot as { ranAt?: string } | null)?.ranAt;
    return ts ? new Date(ts) : null;
  }, [system]);

  const formatAge = (d: Date | null): string => {
    if (!d) return "never";
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from("market_intelligence")
        .select("symbol, generated_at");
      if (data) {
        const map: Record<string, string> = {};
        for (const row of data) {
          if (row.symbol && row.generated_at) map[row.symbol] = row.generated_at;
        }
        setIntelTimestamps(map);
      }
    };
    load();
  }, []);

  // Agent health — refreshed every 30s. Drives pipeline-strip dot colors.
  const [agentHealth, setAgentHealth] = useState<
    Record<string, { status: string; staleMinutes: number | null }>
  >({});
  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from("agent_health")
        .select("agent_name, status, last_success, checked_at");
      if (data) {
        const map: Record<string, { status: string; staleMinutes: number | null }> = {};
        for (const row of data) {
          const staleMinutes = row.last_success
            ? Math.floor((Date.now() - new Date(row.last_success).getTime()) / 60000)
            : null;
          map[row.agent_name] = { status: row.status, staleMinutes };
        }
        setAgentHealth(map);
      }
    };
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, []);

  // Map an agent's health.status → tailwind dot class.
  // 'healthy' → green · 'stale' → amber · 'degraded' → amber pulse · 'failed' → red pulse.
  // Returns null if no health row exists yet so callers can fall back to timestamp-based logic.
  const healthDot = (agentKey: string): string | null => {
    const h = agentHealth[agentKey];
    if (!h) return null;
    if (h.status === "healthy") return "bg-status-safe";
    if (h.status === "stale") return "bg-status-caution";
    if (h.status === "degraded") return "bg-status-caution animate-pulse";
    return "bg-status-blocked animate-pulse";
  };

  // Render a single structured gate reason as a sonner toast.
  const toastForGate = (g: GateReason) => {
    const Icon = gateIconFor(g.code);
    const tone = gateToneFor(g.severity);
    const fn = g.severity === "halt" ? toast.error : g.severity === "block" ? toast.warning : toast.info;
    fn(g.message, {
      description: `${g.code}${g.meta?.symbol ? ` · ${g.meta.symbol}` : ""}`,
      icon: <Icon className={cn("h-4 w-4", tone.text)} />,
    });
  };

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
      const reasons: GateReason[] = Array.isArray(json.gateReasons) ? json.gateReasons : [];
      if (json.tick === "halted") {
        // Account-level halt(s) — surface every reason so operator knows what tripped.
        if (reasons.length === 0) toast.error("Engine halted.");
        else reasons.forEach(toastForGate);
      } else if (json.tick === "skipped") {
        // Per-symbol skip(s) — show first 2 inline, rest summarised.
        if (reasons.length === 0) toast.info("AI chose to skip. Logged to journal.");
        else {
          reasons.slice(0, 2).forEach(toastForGate);
          if (reasons.length > 2) {
            toast.info(`+${reasons.length - 2} more skip reasons`, {
              description: "See engine snapshot for the full list.",
            });
          }
        }
      } else if (json.tick === "ai_error") {
        reasons.forEach(toastForGate);
      } else if (json.tick === "executed") {
        toast.success("Auto-executed!");
      } else if (json.tick === "proposed") {
        toast.success("New signal proposed.");
      } else if (json.tick === "no_system_state") {
        reasons.forEach(toastForGate);
      }
    } catch {
      toast.error("Engine connection error.");
    } finally {
      setRunning(false);
    }
  };

  const runFullPipeline = async () => {
    if (pipelineStep !== null && pipelineStep !== "done" && pipelineStep !== "error") return;
    setPipelineStep("braintrust");
    setPipelineError(null);

    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Sign in first.");
        setPipelineStep("error");
        setPipelineError("auth failed");
        return;
      }

      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      };

      // Step 1: Brain Trust
      const brainRes = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/market-intelligence`,
        { method: "POST", headers, body: JSON.stringify({}) },
      );
      if (!brainRes.ok) {
        const e = await brainRes.json().catch(() => ({}));
        setPipelineStep("error");
        setPipelineError(e.error ?? "Brain Trust failed");
        toast.error("Brain Trust failed — check function logs.");
        return;
      }
      const { data: freshIntel } = await supabase
        .from("market_intelligence")
        .select("symbol, generated_at");
      if (freshIntel) {
        const map: Record<string, string> = {};
        for (const row of freshIntel) {
          if (row.symbol && row.generated_at) map[row.symbol] = row.generated_at;
        }
        setIntelTimestamps(map);
      }

      // Step 2: Signal Engine (Donna)
      setPipelineStep("engine");
      const engineRes = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/signal-engine`,
        { method: "POST", headers, body: JSON.stringify({}) },
      );
      let engineJson: Record<string, unknown> = {};
      if (engineRes.ok) {
        engineJson = await engineRes.json().catch(() => ({}));
      } else {
        const e = await engineRes.json().catch(() => ({}));
        setPipelineStep("error");
        setPipelineError((e as { error?: string }).error ?? "Engine failed");
        toast.error("Donna failed — check function logs.");
        return;
      }

      // Step 3: Harvey briefing
      setPipelineStep("briefing");
      const tick = (engineJson.tick as string) ?? "unknown";
      const reasons = Array.isArray(engineJson.gateReasons)
        ? (engineJson.gateReasons as Array<{ message?: string }>)
        : [];
      const firstReason = reasons[0]?.message ?? null;
      const pipelinePrompt = [
        `[Pipeline run complete — Brain Trust refreshed, Donna ticked]`,
        `Engine result: ${tick}${firstReason ? ` — ${firstReason}` : ""}.`,
        `Give me your two-sentence Harvey briefing on what this means for the next window.`,
      ].join(" ");

      if (activeId) {
        await send(pipelinePrompt);
      }

      setPipelineStep("done");
      setTimeout(() => setPipelineStep(null), 8000);
    } catch (err) {
      setPipelineStep("error");
      setPipelineError("unexpected error");
      toast.error("Pipeline error — see console.");
      console.error("[runFullPipeline]", err);
    }
  };

  const decide = async (action: "approve" | "reject") => {
    if (!activeSignal || busy) return;
    setBusy(action);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Sign in first.");
        return;
      }
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/signal-decide`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({ signalId: activeSignal.id, action }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? `Failed to ${action}`);
        return;
      }
      toast.success(action === "approve" ? "Trade opened." : "Signal declined. AI noted.");
    } catch {
      toast.error("Connection error.");
    } finally {
      setBusy(null);
    }
  };

  useKeyboardShortcuts({
    a: () => {
      if (activeSignal && !busy) decide("approve");
    },
    r: () => {
      if (activeSignal && !busy) decide("reject");
    },
    e: () => {
      if (!running) runEngine();
    },
  });
  const buildContext = () => ({
    mode: system?.mode,
    bot: system?.bot,
    autonomy: system?.autonomyLevel,
    liveTradingEnabled: system?.liveTradingEnabled,
    killSwitchEngaged: system?.killSwitchEngaged,
    account: account ? { equity: account.equity, balanceFloor: account.balanceFloor } : null,
    engineSnapshot: snapshot
      ? {
          ranAt: snapshot.ranAt,
          chosenSymbol: snapshot.chosenSymbol,
          gateReasons: snapshot.gateReasons,
          perSymbol: snapshot.perSymbol.map((p) => ({
            symbol: p.symbol,
            regime: p.regime,
            setupScore: p.setupScore,
            confidence: p.confidence,
            chosen: p.chosen,
          })),
        }
      : null,
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
    experiments: {
      running: expCounts.running + expCounts.queued,
      needsReview: expCounts.needsReview,
      copilotProposed: expCounts.copilotProposed,
      autoResolved: expCounts.autoResolved,
      pendingReview: expNeedsReview.slice(0, 3).map((e) => ({ parameter: e.parameter, before: e.before, after: e.after, delta: e.delta, hypothesis: e.hypothesis })),
      recentlyAccepted: expRecent.filter((e) => e.status === "accepted").slice(0, 5).map((e) => ({ parameter: e.parameter, before: e.before, after: e.after, delta: e.delta })),
    },
  });

  const send = async (text: string) => {
    if (!text.trim() || streaming) return;

    // Make sure we have an active conversation. If not, create one on the fly.
    let convoId = activeId;
    if (!convoId) {
      convoId = await createConversation();
      if (!convoId) {
        toast.error("Could not start a new conversation.");
        return;
      }
    }

    appendLocalMessage({ role: "user", content: text });
    setInput("");
    setStreaming(true);

    let buffer = "";
    const upsert = (chunk: string) => {
      buffer += chunk;
      updateLastAssistant(buffer);
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
          conversationId: convoId,
          userMessage: text,
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

      // Reload from server so we get canonical IDs and the auto-set title.
      await reloadActiveMessages();
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

      {/* Pipeline Status Strip */}
      <div className="flex items-center gap-4 px-1 py-2 border-b border-border/40 text-[11px] text-muted-foreground flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mr-1">Agents</span>

        {/* Brain Trust */}
        <div className="flex items-center gap-1.5">
          <span className={cn(
            "w-1.5 h-1.5 rounded-full",
            lastBrainTrustRun && (Date.now() - lastBrainTrustRun.getTime()) < 5 * 60 * 60 * 1000
              ? "bg-status-safe" : "bg-muted-foreground/40"
          )} />
          <span>Brain Trust</span>
          <span className="text-muted-foreground/50">·</span>
          <span className="tabular">{formatAge(lastBrainTrustRun)}</span>
        </div>

        <span className="text-border">|</span>

        {/* Signal Engine (Donna) */}
        <div className="flex items-center gap-1.5">
          <span className={cn(
            "w-1.5 h-1.5 rounded-full",
            lastEngineRun && (Date.now() - lastEngineRun.getTime()) < 2 * 60 * 1000
              ? "bg-status-safe animate-pulse"
              : lastEngineRun && (Date.now() - lastEngineRun.getTime()) < 5 * 60 * 1000
                ? "bg-status-safe" : "bg-muted-foreground/40"
          )} />
          <span>Donna</span>
          <span className="text-muted-foreground/50">·</span>
          <span className="tabular">{formatAge(lastEngineRun)}</span>
        </div>

        <span className="text-border">|</span>

        {/* Harvey */}
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-status-safe" />
          <span>Harvey</span>
          <span className="text-muted-foreground/50">·</span>
          <span className="text-muted-foreground/50">gemini-flash</span>
        </div>

        <span className="text-border">|</span>

        {/* Jessica — autonomous orchestrator */}
        <div className="flex items-center gap-1.5">
          {(() => {
            const decision = system?.lastJessicaDecision ?? null;
            const ranAt = decision?.ran_at ?? null;
            const ageSec = ranAt
              ? Math.floor((Date.now() - new Date(ranAt).getTime()) / 1000)
              : null;
            const healthy = ageSec !== null && ageSec < 90;
            const ageLabel =
              ageSec === null
                ? "never"
                : ageSec < 60
                  ? `${ageSec}s ago`
                  : `${Math.floor(ageSec / 60)}m ago`;
            return (
              <>
                <span
                  className={cn(
                    "w-1.5 h-1.5 rounded-full",
                    healthy ? "bg-status-safe" : "bg-muted-foreground/40",
                  )}
                />
                <span>Jessica</span>
                <span className="text-muted-foreground/50">·</span>
                <span className="tabular">{ageLabel}</span>
                {decision?.actions ? (
                  <span className="text-muted-foreground/50 ml-1">
                    {decision.actions} action{decision.actions !== 1 ? "s" : ""}
                  </span>
                ) : null}
              </>
            );
          })()}
        </div>


        {/* Pipeline run progress inline */}
        {pipelineStep && (
          <>
            <span className="text-border">|</span>
            <div className="flex items-center gap-2 ml-1">
              {(["braintrust", "engine", "briefing"] as const).map((step, i) => {
                const labels = { braintrust: "Brain Trust", engine: "Donna", briefing: "Harvey" };
                const stepOrder = ["braintrust", "engine", "briefing", "done"];
                const currentIdx = stepOrder.indexOf(pipelineStep);
                const done = pipelineStep === "done" || currentIdx > i;
                const active = currentIdx === i;
                const errored = pipelineStep === "error" && active;
                return (
                  <span key={step} className={cn(
                    "flex items-center gap-1",
                    done ? "text-status-safe" : active ? "text-foreground" : "text-muted-foreground/40"
                  )}>
                    {errored ? "✗" : done ? "✓" : active ? "·" : "○"}
                    {labels[step]}
                  </span>
                );
              })}
              {pipelineStep === "done" && <span className="text-status-safe text-[10px]">pipeline complete</span>}
              {pipelineStep === "error" && <span className="text-status-blocked text-[10px]">{pipelineError}</span>}
            </div>
          </>
        )}

        <div className="ml-auto">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground gap-1.5 border border-border/50 hover:border-border"
            disabled={pipelineStep !== null && pipelineStep !== "done" && pipelineStep !== "error"}
            onClick={runFullPipeline}
          >
            <Sparkles className="h-3 w-3" />
            {pipelineStep && pipelineStep !== "done" && pipelineStep !== "error"
              ? "Running…"
              : "⚡ Run full pipeline"}
          </Button>
        </div>
      </div>

      {/* SIGNAL BRIDGE — top of page, above everything else */}
      {activeSignal ? (
        <div className="space-y-2">
          <SignalCard signal={activeSignal} busy={busy} onDecide={decide} />
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setExplainSignal(activeSignal)}
              className="gap-1.5"
            >
              <Telescope className="h-3.5 w-3.5" /> Explain this decision
            </Button>
          </div>
        </div>
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

      <div className="grid grid-cols-1 xl:grid-cols-[260px_minmax(0,1fr)_280px] 2xl:grid-cols-[300px_minmax(0,1fr)_320px] gap-4 items-start">
        {/* LEFT COLUMN — symbol context + gate readout */}
        <div className="space-y-3">
          <MultiSymbolStrip />

          <div className="panel p-4">
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 mb-2">
              <div className="text-sm font-medium text-foreground">Last engine tick</div>
              {snapshot && (
                <span className="text-[10px] text-muted-foreground tabular shrink-0">
                  {new Date(snapshot.ranAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
              )}
            </div>
            {!snapshot ? (
              <p className="text-xs text-muted-foreground italic">
                No engine snapshot yet. Hit <span className="text-primary">Run engine now</span>.
              </p>
            ) : lastGateReasons.length === 0 ? (
              <p className="text-xs text-status-safe italic">All gates clear. Engine is free to act.</p>
            ) : (
              <GateReasonList reasons={lastGateReasons} max={4} />
            )}
          </div>

          <MarketIntelligencePanel />
        </div>

        {/* CENTER COLUMN — chat / history / calibration tabs */}
        <div
          className="panel flex flex-col overflow-hidden"
          style={{ height: "min(72vh, 760px)" }}
        >
          <Tabs defaultValue="chat" className="flex-1 min-h-0 flex flex-col">
            <div className="mx-3 mt-3 flex items-center justify-between gap-2">
              <TooltipProvider delayDuration={200}>
                <TabsList>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <TabsTrigger value="chat">Chat</TabsTrigger>
                    </TooltipTrigger>
                    <TooltipContent>Conversation with the Copilot. Live system context auto-attached.</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <TabsTrigger value="history">Signal Log</TabsTrigger>
                    </TooltipTrigger>
                    <TooltipContent>Every engine tick — proposed, skipped, executed, or halted.</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <TabsTrigger value="calibration">AI Accuracy</TabsTrigger>
                    </TooltipTrigger>
                    <TooltipContent>
                      When the AI says 80% confidence, is it right 80% of the time? This chart grades its honesty.
                    </TooltipContent>
                  </Tooltip>
                </TabsList>
              </TooltipProvider>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={async () => { await createConversation(); }}
              >
                <Plus className="h-3 w-3" /> New chat
              </Button>
            </div>

            <TabsContent value="chat" className="flex-1 min-h-0 flex flex-col mt-2 data-[state=inactive]:hidden">
              {loadingMessages && messages.length === 0 ? (
                <div className="flex-1 flex items-center justify-center">
                  <p className="text-xs text-muted-foreground italic">Loading thread…</p>
                </div>
              ) : (
                <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 space-y-4">
                  {messages.length === 0 && (
                    <div className="h-full flex flex-col items-center justify-center text-center py-12">
                      <div className="h-12 w-12 rounded-md bg-primary/15 text-primary flex items-center justify-center mb-3">
                        <Sparkles className="h-5 w-5" />
                      </div>
                      <p className="text-sm font-medium text-foreground">Ask the Copilot</p>
                      <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                        Live context (mode, regime, position, signals, autonomy) is auto-attached. Threads persist across refreshes.
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
                  {messages.map((m) => (
                    <div key={m.id} className={cn("flex flex-col gap-0.5", m.role === "user" ? "items-end" : "items-start")}>
                      <div
                        className={cn(
                          "max-w-[85%] rounded-lg px-3 py-2 text-xs",
                          m.role === "user"
                            ? "bg-primary/15 border border-primary/25 text-foreground"
                            : "bg-secondary border border-border text-foreground",
                        )}
                      >
                        {m.role === "assistant" ? (
                          <div className="prose prose-xs prose-invert max-w-none prose-p:my-1 prose-li:my-0 prose-headings:text-foreground prose-strong:text-foreground prose-code:text-primary leading-relaxed">
                            <ReactMarkdown>{m.content || "…"}</ReactMarkdown>
                          </div>
                        ) : (
                          <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
                        )}
                      </div>
                      <span className="text-[10px] text-muted-foreground px-1 tabular">
                        {new Date(m.createdAt ?? Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                  ))}
                </div>
              )}

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
            </TabsContent>

            <TabsContent value="history" className="flex-1 overflow-y-auto p-4 mt-2 data-[state=inactive]:hidden">
              <div className="flex items-center justify-between mb-1">
                <div className="text-sm font-medium text-foreground">Signal log</div>
                <span className="text-xs text-muted-foreground">{history.length} decisions</span>
              </div>
              <p className="text-[11px] text-muted-foreground mb-3">
                Every engine decision. Click the <Telescope className="inline h-3 w-3 align-text-bottom" /> icon on any row for the full reasoning.
              </p>
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
                      <div className="text-right shrink-0 flex items-center gap-2">
                        <div>
                          <div className="text-xs tabular text-foreground">{(s.confidence * 100).toFixed(0)}%</div>
                          <div className="text-[10px] text-muted-foreground">{new Date(s.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setExplainSignal(s)}
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-primary"
                          title="Explain this decision"
                        >
                          <Telescope className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="calibration" className="flex-1 overflow-y-auto p-4 mt-2 data-[state=inactive]:hidden">
              <p className="text-[11px] text-muted-foreground mb-3">
                Dots on the diagonal = the AI knows when its hand is good. Builds after 10+ executed signals.
              </p>
              <CalibrationChart signals={history} />
            </TabsContent>
          </Tabs>
        </div>

        {/* RIGHT COLUMN — autonomy + attached context */}
        <div className="space-y-3">
          <AutonomyToggle />

          <div className="panel p-4 space-y-3">
            <div>
              <div className="text-sm font-medium text-foreground">What Harvey sees</div>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Auto-attached to every message you send.
              </p>
            </div>

            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Mode</span>
                <span className="text-foreground capitalize tabular">{system?.mode ?? "—"}</span>
              </div>

              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Equity</span>
                <span className="text-foreground tabular">
                  {account ? `$${account.equity.toFixed(2)}` : "—"}
                </span>
              </div>

              <div className="flex items-start justify-between gap-2">
                <span className="text-muted-foreground shrink-0">Engine pick</span>
                <span className="text-foreground text-right">
                  {chosenSym ? (
                    <span className="inline-flex flex-col items-end gap-1">
                      <span className="capitalize">{chosenSym.replace("-USD", "")}</span>
                      {chosenRow && chosenRow.regime !== "unknown" && (
                        <RegimeBadge regime={chosenRow.regime as Exclude<typeof chosenRow.regime, "unknown">} confidence={chosenRow.confidence} />
                      )}
                    </span>
                  ) : (
                    <span className="text-muted-foreground italic">none</span>
                  )}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Open</span>
                <span className="text-foreground">
                  {open[0] ? (
                    <span className="capitalize">{open[0].side} {open[0].symbol.replace("-USD", "")}</span>
                  ) : (
                    <span className="text-muted-foreground italic">none</span>
                  )}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Signal</span>
                <span className="text-foreground">
                  {activeSignal ? (
                    <span className="capitalize tabular">
                      {activeSignal.side} {(activeSignal.confidence * 100).toFixed(0)}%
                    </span>
                  ) : (
                    <span className="text-muted-foreground italic">none</span>
                  )}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Corr. cap</span>
                <span className="text-foreground tabular">
                  {open.length}/{activeProfile.maxCorrelatedPositions}{" "}
                  {open.length >= activeProfile.maxCorrelatedPositions ? (
                    <span className="text-status-caution">active</span>
                  ) : (
                    <span className="text-status-safe">clear</span>
                  )}
                </span>
              </div>
            </div>

          </div>
        </div>
      </div>

      {/* Conversation history — deprioritised below the action grid */}
      <ConversationSidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={async () => {
          await createConversation();
        }}
        onRename={renameConversation}
        onDelete={deleteConversation}
        loading={convLoading}
      />


      <SignalExplainDialog
        signal={explainSignal}
        open={explainSignal !== null}
        onOpenChange={(o) => !o && setExplainSignal(null)}
      />
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
