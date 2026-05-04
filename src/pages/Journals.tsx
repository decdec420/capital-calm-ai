// Journals.tsx — Midnight Quant Desk redesign
// Adds: Copilot department header, Wendy agent attribution,
// Midnight Quant panel chrome, kind badges with agent color coding.
// All existing logic preserved 100%.

import { useState } from "react";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { JournalEventCard } from "@/components/trader/JournalEventCard";
import { EmptyState } from "@/components/trader/EmptyState";
import { TagInput } from "@/components/trader/TagInput";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Search, Plus, Sparkles, Trash2, NotebookPen } from "lucide-react";
import { Link } from "react-router-dom";
import type { JournalEntry, JournalKind } from "@/lib/domain-types";
import { useJournals } from "@/hooks/useJournals";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const tabs: { value: JournalKind | "all"; label: string }[] = [
  { value: "all",        label: "All" },
  { value: "research",   label: "Research" },
  { value: "trade",      label: "Trades" },
  { value: "learning",   label: "Learning" },
  { value: "skip",       label: "Skips" },
  { value: "daily",      label: "Daily" },
  { value: "postmortem", label: "Postmortems" },
];

// Kind → agent attribution
const KIND_AGENT: Record<JournalKind, string> = {
  research:   "Brain Trust",
  trade:      "Taylor",
  learning:   "Wendy",
  skip:       "Taylor",
  daily:      "Bobby",
  postmortem: "Wendy",
};

const KIND_TONE: Record<JournalKind, "safe" | "blocked" | "neutral" | "candidate" | "caution" | "accent"> = {
  research:   "accent",
  trade:      "safe",
  learning:   "neutral",
  skip:       "caution",
  daily:      "neutral",
  postmortem: "blocked",
};

export default function Journals() {
  const { entries, loading, create, update, remove } = useJournals();
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<string>("all");
  const [newOpen, setNewOpen] = useState(false);
  const [explaining, setExplaining] = useState<string | null>(null);

  const filtered = entries.filter((e) => {
    const matchTab = tab === "all" || e.kind === tab;
    const matchQ   = !q || e.title.toLowerCase().includes(q.toLowerCase()) || e.summary.toLowerCase().includes(q.toLowerCase());
    return matchTab && matchQ;
  });

  const explain = async (entry: JournalEntry) => {
    setExplaining(entry.id);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) { toast.error("Sign in first."); return; }
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/journal-explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
        body: JSON.stringify({ entryId: entry.id }),
      });
      const json = await res.json();
      if (!res.ok) {
        if (res.status === 429) toast.error("Rate limit. Slow down.");
        else if (res.status === 402) toast.error("AI credits depleted.");
        else toast.error(json.error ?? "Explain failed");
        return;
      }
      await update(entry.id, { llmExplanation: json.explanation });
      toast.success("Copilot explanation added.");
    } catch { toast.error("Couldn't reach the explain service."); }
    finally { setExplaining(null); }
  };

  // Count by kind for tab badges
  const countByKind = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.kind] = (acc[e.kind] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeader
        eyebrow="Copilot"
        title="Decision log"
        description="Every research note, trade, skip, and postmortem. The paper trail of your trading company."
        actions={
          <Button size="sm" className="gap-1.5" onClick={() => setNewOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> New entry
          </Button>
        }
      />

      {/* Agent attribution strip */}
      <div className="panel p-3 flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
          <span className="text-[11px] text-muted-foreground">Wendy logs learning notes · Taylor logs trade + skip entries · Brain Trust logs research</span>
        </div>
        <Link to="/company" className="text-[11px] text-primary hover:underline ml-auto">View full roster →</Link>
      </div>

      {/* Search */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[240px] max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter entries…" className="pl-8 h-9 bg-card border-border" />
        </div>
        <div className="text-[11px] text-muted-foreground tabular">{entries.length} entries total</div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="bg-card border border-border flex-wrap h-auto">
          {tabs.map((t) => {
            const count = t.value === "all" ? entries.length : (countByKind[t.value] ?? 0);
            return (
              <TabsTrigger key={t.value} value={t.value} className="data-[state=active]:bg-secondary data-[state=active]:text-primary gap-1.5">
                {t.label}
                {count > 0 && <span className="text-[9px] text-muted-foreground tabular">{count}</span>}
              </TabsTrigger>
            );
          })}
        </TabsList>

        <TabsContent value={tab} className="mt-4">
          {loading ? (
            <p className="text-xs text-muted-foreground italic">Loading…</p>
          ) : filtered.length === 0 ? (
            entries.length === 0 ? (
              <EmptyState
                icon={<NotebookPen className="h-5 w-5" />}
                title="The page is blank — and that's a feature"
                description="Drop your first research note, skip rationale, or postmortem. Future-you will thank present-you."
                action={<Button size="sm" onClick={() => setNewOpen(true)}>Write the first entry</Button>}
              />
            ) : (
              <EmptyState title="No entries match" description="Try clearing your search or switching tabs." />
            )
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {filtered.map((e) => (
                <div key={e.id} className="relative group">
                  {/* Agent attribution chip */}
                  <div className="absolute top-2.5 right-2.5 z-10 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
                    <StatusBadge tone={KIND_TONE[e.kind as JournalKind] ?? "neutral"} size="sm">
                      {KIND_AGENT[e.kind as JournalKind] ?? "Bobby"}
                    </StatusBadge>
                  </div>
                  <JournalEventCard entry={e} />
                  <div className="absolute top-2.5 right-2.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {!e.llmExplanation && (
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1" onClick={() => explain(e)} disabled={explaining === e.id}>
                        <Sparkles className="h-3 w-3" /> {explaining === e.id ? "…" : "Explain"}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => remove(e.id).then(() => toast.success("Entry deleted."))}>
                      <Trash2 className="h-3 w-3 text-muted-foreground" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <NewJournalDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onSubmit={async (input) => {
          try { await create(input); toast.success("Entry logged."); setNewOpen(false); }
          catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't save entry"); }
        }}
      />
    </div>
  );
}

function NewJournalDialog({ open, onOpenChange, onSubmit }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSubmit: (input: { kind: JournalKind; title: string; summary: string; tags: string[] }) => void;
}) {
  const [kind, setKind]       = useState<JournalKind>("research");
  const [title, setTitle]     = useState("");
  const [summary, setSummary] = useState("");
  const [tags, setTags]       = useState<string[]>([]);

  const reset = () => { setKind("research"); setTitle(""); setSummary(""); setTags([]); };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="bg-card border-border max-w-lg">
        <DialogHeader>
          <DialogTitle>New journal entry</DialogTitle>
          <DialogDescription>Write it now while it's fresh. Your future self trades better with notes.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">Kind</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as JournalKind)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="research">Research</SelectItem>
                <SelectItem value="trade">Trade</SelectItem>
                <SelectItem value="learning">Learning</SelectItem>
                <SelectItem value="skip">Skip</SelectItem>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="postmortem">Postmortem</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Skipped long at 14:22 — score 0.58" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">Summary</Label>
            <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={4} placeholder="What happened, what you saw, what you decided." />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">Tags</Label>
            <TagInput value={tags} onChange={setTags} placeholder="e.g. spread-wide, tod-bad" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => {
            if (!title.trim()) return toast.error("Give it a title.");
            onSubmit({ kind, title, summary, tags });
          }}>Save entry</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

