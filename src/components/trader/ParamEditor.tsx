import { useState } from "react";
import { Plus, X, ChevronDown, ChevronRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { StrategyParam } from "@/lib/domain-types";

interface ParamEditorProps {
  value: StrategyParam[];
  onChange: (params: StrategyParam[]) => void;
  className?: string;
}

const UNIT_OPTIONS: { label: string; value: string }[] = [
  { label: "—", value: "__none__" },
  { label: "%", value: "%" },
  { label: "x", value: "x" },
  { label: "R", value: "R" },
  { label: "pts", value: "pts" },
  { label: "bars", value: "bars" },
];

export function ParamEditor({ value, onChange, className }: ParamEditorProps) {
  const [jsonOpen, setJsonOpen] = useState(false);

  const updateRow = (idx: number, patch: Partial<StrategyParam>) => {
    const next = value.map((p, i) => (i === idx ? { ...p, ...patch } : p));
    onChange(next);
  };

  const removeRow = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };

  const addRow = () => {
    onChange([...value, { key: "", value: 0 }]);
  };

  return (
    <div className={cn("space-y-3", className)}>
      {/* Header */}
      <div className="grid grid-cols-[1fr_120px_100px_32px] gap-2 px-1">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Key</span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Value</span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Unit</span>
        <span className="sr-only">Actions</span>
      </div>

      {/* Rows */}
      <div className="space-y-2">
        {value.length === 0 && (
          <p className="text-xs text-muted-foreground italic px-1">
            No parameters yet. Add one below.
          </p>
        )}
        {value.map((param, idx) => (
          <div
            key={idx}
            className="grid grid-cols-[1fr_120px_100px_32px] gap-2 items-center"
          >
            <Input
              value={param.key}
              onChange={(e) => updateRow(idx, { key: e.target.value })}
              placeholder="param_key"
              className="h-9 text-sm"
            />
            <Input
              type="number"
              value={typeof param.value === "number" ? param.value : Number(param.value) || 0}
              onChange={(e) => updateRow(idx, { value: Number(e.target.value) })}
              className="h-9 text-sm tabular"
              step="any"
            />
            <Select
              value={param.unit && param.unit.length > 0 ? param.unit : "__none__"}
              onValueChange={(v) =>
                updateRow(idx, { unit: v === "__none__" ? undefined : v })
              }
            >
              <SelectTrigger className="h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UNIT_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-8 text-muted-foreground hover:text-status-blocked"
              onClick={() => removeRow(idx)}
              aria-label={`Remove parameter ${param.key || idx + 1}`}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>

      {/* Add button */}
      <Button
        type="button"
        variant="outline"
        onClick={addRow}
        className="w-full gap-1.5 border-dashed text-muted-foreground hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" />
        Add parameter
      </Button>

      {/* Collapsed JSON preview */}
      <div className="border border-border rounded-md bg-secondary/40">
        <button
          type="button"
          onClick={() => setJsonOpen((v) => !v)}
          className="w-full flex items-center gap-1.5 px-3 py-2 text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
          aria-expanded={jsonOpen}
        >
          {jsonOpen ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          JSON preview
          <span className="ml-auto tabular text-[10px] normal-case tracking-normal">
            {value.length} param{value.length === 1 ? "" : "s"}
          </span>
        </button>
        {jsonOpen && (
          <pre className="px-3 pb-3 pt-0 text-[11px] font-mono text-muted-foreground overflow-x-auto leading-relaxed">
            {JSON.stringify(value, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}
