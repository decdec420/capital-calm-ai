import { useState } from "react";
import { Plus, MessageSquare, Trash2, Pencil, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatConversation } from "@/hooks/useConversations";
import { Button } from "@/components/ui/button";

interface ConversationSidebarProps {
  conversations: ChatConversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  loading?: boolean;
}

const formatRelative = (iso: string) => {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
};

export function ConversationSidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onRename,
  onDelete,
  loading,
}: ConversationSidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const startEdit = (c: ChatConversation) => {
    setEditingId(c.id);
    setEditValue(c.title);
  };
  const commitEdit = () => {
    if (editingId && editValue.trim()) onRename(editingId, editValue);
    setEditingId(null);
  };

  return (
    <div className="panel flex flex-col h-full">
      <div className="p-3 border-b border-border">
        <Button onClick={onNew} size="sm" className="w-full gap-1.5">
          <Plus className="h-3.5 w-3.5" /> New chat
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {loading && conversations.length === 0 && (
          <p className="text-xs text-muted-foreground italic px-2 py-3">Loading…</p>
        )}
        {!loading && conversations.length === 0 && (
          <p className="text-xs text-muted-foreground italic px-2 py-3">
            No threads yet. Start one — your reasoning is safe across refreshes.
          </p>
        )}
        {conversations.map((c) => {
          const active = c.id === activeId;
          const isEditing = editingId === c.id;
          return (
            <div
              key={c.id}
              className={cn(
                "group rounded-md transition-colors",
                active ? "bg-primary/15 border border-primary/25" : "hover:bg-secondary border border-transparent",
              )}
            >
              {isEditing ? (
                <div className="flex items-center gap-1 p-1.5">
                  <input
                    autoFocus
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit();
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    className="flex-1 bg-background border border-border rounded px-2 py-1 text-xs text-foreground outline-none focus:border-ring"
                  />
                  <button
                    onClick={commitEdit}
                    className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary"
                    aria-label="Save"
                  >
                    <Check className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => setEditingId(null)}
                    className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary"
                    aria-label="Cancel"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => onSelect(c.id)}
                  className="w-full text-left px-2.5 py-2 flex items-start gap-2 min-w-0"
                >
                  <MessageSquare
                    className={cn(
                      "h-3.5 w-3.5 mt-0.5 shrink-0",
                      active ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  <div className="flex-1 min-w-0">
                    <p
                      className={cn(
                        "text-xs font-medium truncate",
                        active ? "text-foreground" : "text-foreground/90",
                      )}
                    >
                      {c.title}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {formatRelative(c.lastMessageAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        startEdit(c);
                      }}
                      className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary cursor-pointer"
                      aria-label="Rename"
                    >
                      <Pencil className="h-3 w-3" />
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Delete "${c.title}"?`)) onDelete(c.id);
                      }}
                      className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-status-danger hover:bg-secondary cursor-pointer"
                      aria-label="Delete"
                    >
                      <Trash2 className="h-3 w-3" />
                    </span>
                  </div>
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
