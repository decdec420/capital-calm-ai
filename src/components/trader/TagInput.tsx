import { useState, type KeyboardEvent } from "react";
import { Input } from "@/components/ui/input";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface TagInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  className?: string;
}

export function TagInput({ value, onChange, placeholder = "Add tag and press Enter", className }: TagInputProps) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const v = draft.trim().replace(/,+$/, "");
    if (!v) return;
    if (!value.includes(v)) onChange([...value, v]);
    setDraft("");
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add();
    } else if (e.key === "Backspace" && !draft && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-background p-1.5", className)}>
      {value.map((t) => (
        <span
          key={t}
          className="inline-flex items-center gap-1 rounded-md bg-secondary text-foreground px-2 py-0.5 text-xs"
        >
          {t}
          <button
            type="button"
            onClick={() => onChange(value.filter((x) => x !== t))}
            className="text-muted-foreground hover:text-foreground"
            aria-label={`Remove ${t}`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={add}
        placeholder={value.length === 0 ? placeholder : ""}
        className="h-7 flex-1 min-w-[120px] border-0 bg-transparent p-0 text-sm focus-visible:ring-0 shadow-none"
      />
    </div>
  );
}
