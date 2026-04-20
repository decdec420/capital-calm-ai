import { useEffect, useRef, useState } from "react";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/trader/StatusBadge";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import { accountState, marketRegime, openPosition, strategies, systemState } from "@/mocks/data";
import { Send, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

type Msg = { role: "user" | "assistant"; content: string };

const SUGGESTED = [
  "Why did the bot skip the last trade?",
  "Summarize today's market conditions.",
  "Should the candidate strategy v1.4 be promoted?",
  "What are the biggest current risks in the system?",
];

export default function Copilot() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const buildContext = () => ({
    mode: systemState.mode,
    bot: systemState.bot,
    liveTradingEnabled: systemState.liveTradingEnabled,
    killSwitchEngaged: systemState.killSwitchEngaged,
    account: { equity: accountState.equity, balanceFloor: accountState.balanceFloor },
    regime: marketRegime,
    openPosition,
    approvedStrategy: strategies.find((s) => s.status === "approved"),
    candidateStrategy: strategies.find((s) => s.status === "candidate"),
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
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/copilot-chat`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify({
          messages: [...messages, userMsg],
          context: buildContext(),
        }),
      });

      if (!resp.ok || !resp.body) {
        if (resp.status === 429) toast.error("Rate limit reached. Give it a moment.");
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
        eyebrow="AI Copilot"
        title="Operator console"
        description="Grounded in your live system context. Asks risk-first questions. Never overrides the human."
        actions={
          <StatusBadge tone="accent" dot pulse={streaming}>
            <Sparkles className="h-3 w-3" /> {streaming ? "thinking" : "ready"}
          </StatusBadge>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <div className="lg:col-span-3 panel flex flex-col" style={{ minHeight: "60vh" }}>
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-center py-12">
                <div className="h-12 w-12 rounded-md bg-primary/15 text-primary flex items-center justify-center mb-3">
                  <Sparkles className="h-5 w-5" />
                </div>
                <p className="text-sm font-medium text-foreground">Ask the Copilot</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                  System context (mode, regime, position, strategies) is automatically attached.
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
              placeholder="Ask about the system, market, or a strategy…"
              className="min-h-[44px] max-h-32 resize-none bg-background border-border"
              disabled={streaming}
            />
            <Button type="submit" size="icon" disabled={streaming || !input.trim()} className="shrink-0 h-11 w-11">
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>

        <div className="space-y-3">
          <div className="panel p-4">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">Context attached</div>
            <ul className="text-xs text-muted-foreground space-y-1.5">
              <li>• Mode: <span className="text-foreground capitalize">{systemState.mode}</span></li>
              <li>• Regime: <span className="text-foreground capitalize">{marketRegime.regime.replace("_", " ")}</span></li>
              <li>• Open position: <span className="text-foreground">{openPosition ? `${openPosition.side} ${openPosition.symbol}` : "none"}</span></li>
              <li>• Approved strategy: <span className="text-foreground">trend-rev v1.3</span></li>
              <li>• Candidate: <span className="text-foreground">v1.4</span></li>
            </ul>
          </div>
          <div className="panel p-4">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">Operator prompts</div>
            <div className="space-y-1.5">
              {SUGGESTED.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="w-full text-left text-xs text-muted-foreground hover:text-primary transition-colors"
                  disabled={streaming}
                >
                  → {s}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
