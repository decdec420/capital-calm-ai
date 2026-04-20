import { useState } from "react";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { JournalEventCard } from "@/components/trader/JournalEventCard";
import { EmptyState } from "@/components/trader/EmptyState";
import { TagInput } from "@/components/trader/TagInput";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Search, Plus, Sparkles, Trash2, NotebookPen } from "lucide-react";
import type { JournalEntry, JournalKind } from "@/lib/domain-types";
import { useJournals } from "@/hooks/useJournals";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const tabs: { value: JournalKind | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "research", label: "Research" },
  { value: "trade", label: "Trades" },
  { value: "learning", label: "Learning" },
  { value: "skip", label: "Skips" },
  { value: "daily", label: "Daily" },
  { value: "postmortem", label: "Postmortems" },
];

export default function Journals() {
  const { entries, loading, create, update, remove } = useJournals();
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<string>("all");
  const [newOpen, setNewOpen] = useState(false);
  const [explaining, setExplaining] = useState<string | null>(null);

  const filtered = entries.filter((e) => {
    const matchTab = tab === "all" || e.kind === tab;
    const matchQ = !q || e.title.toLowerCase().includes(q.toLowerCase()) || e.summary.toLowerCase().includes(q.toLowerCase());
    return matchTab && matchQ;
  });

  const explain = async (entry: JournalEntry) => {
    setExplaining(entry.id);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Sign in first.");
        return;
      }
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/journal-explain`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
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
    } catch {
      toast.error("Couldn't reach the explain service.");
    } finally {
      setExplaining(null);
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeader
        eyebrow="Journals"
        title="Decision log"
        description="Every research note, trade, skip, and postmortem."
        actions={
          <Button size="sm" className="gap-1.5" onClick={() => setNewOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> New entry
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[240px] max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter entries…" className="pl-8 h-9 bg-card border-border" />
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="bg-card border border-border flex-wrap h-auto">
          {tabs.map((t) => (
            <TabsTrigger key={t.value} value={t.value} className="data-[state=active]:bg-secondary data-[state=active]:text-primary">
              {t.label}
            </TabsTrigger>
          ))}
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
                <JournalCardActions
                  key={e.id}
                  entry={e}
                  onExplain={() => explain(e)}
                  onDelete={() => remove(e.id).then(() => toast.success("Entry deleted."))}
                  explaining={explaining === e.id}
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <NewJournalDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onSubmit={async (input) => {
          try {
            await create(input);
            toast.success("Entry logged.");
            setNewOpen(false);
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Couldn't save entry");
          }
        }}
      />
    </div>
  );
}

function JournalCardActions({
  entry,
  onExplain,
  onDelete,
  explaining,
}: {
  entry: JournalEntry;
  onExplain: () => void;
  onDelete: () => void;
  explaining: boolean;
}) {
  return (
    <div className="relative group">
      <JournalEventCard entry={entry} />
      <div className="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {!entry.llmExplanation && (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1" onClick={onExplain} disabled={explaining}>
            <Sparkles className="h-3 w-3" /> {explaining ? "…" : "Explain"}
          </Button>
        )}
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onDelete}>
          <Trash2 className="h-3 w-3 text-muted-foreground" />
        </Button>
      </div>
    </div>
  );
}

function NewJournalDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSubmit: (input: { kind: JournalKind; title: string; summary: string; tags: string[] }) => void;
}) {
  const [kind, setKind] = useState<JournalKind>("research");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [tags, setTags] = useState<string[]>([]);

  const reset = () => {
    setKind("research");
    setTitle("");
    setSummary("");
    setTags([]);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
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
          <Button
            onClick={() => {
              if (!title.trim()) return toast.error("Give it a title.");
              onSubmit({ kind, title, summary, tags });
            }}
          >
            Save entry
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
