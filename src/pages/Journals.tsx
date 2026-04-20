import { useState } from "react";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { JournalEventCard } from "@/components/trader/JournalEventCard";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { journalEntries } from "@/mocks/data";
import { Search } from "lucide-react";
import { EmptyState } from "@/components/trader/EmptyState";
import type { JournalKind } from "@/mocks/types";

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
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<string>("all");

  const filtered = journalEntries.filter((e) => {
    const matchTab = tab === "all" || e.kind === tab;
    const matchQ = !q || e.title.toLowerCase().includes(q.toLowerCase()) || e.summary.toLowerCase().includes(q.toLowerCase());
    return matchTab && matchQ;
  });

  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeader eyebrow="Journals" title="Decision log" description="Every research note, trade, skip, and postmortem." />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[240px] max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter entries…" className="pl-8 h-9 bg-card border-border" />
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="bg-card border border-border">
          {tabs.map((t) => (
            <TabsTrigger key={t.value} value={t.value} className="data-[state=active]:bg-secondary data-[state=active]:text-primary">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={tab} className="mt-4">
          {filtered.length === 0 ? (
            <EmptyState title="No entries match" description="Try clearing your search or switching tabs." />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {filtered.map((e) => (
                <JournalEventCard key={e.id} entry={e} />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
