// ============================================================
// ExperimentReviewPanel — PR #42
// Review UI for strategy_learning experiment proposals.
//
// Shows needs_review proposals from source=strategy_learning.
// Bobby/Wags can fill in before/after values and promote to queued.
//
// Safety invariants:
//   - Promotion only queues a research backtest — nothing runs immediately.
//   - No strategies, doctrine, risk gates, signals, or trades are changed.
//   - Invalid/ineligible proposals are blocked with clear copy.
//   - strategy_fit parameter family is blocked — requires manual review.
//   - safety-block proposals cannot reach this panel (blocked at creation, PR #41).
// ============================================================

import React, { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/trader/EmptyState";
import {
  AlertTriangle,
  CheckCircle2,
  FlaskConical,
  Info,
  Loader2,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  useStrategyLearningExperiments,
  type PromoteToQueuedOptions,
  type StrategyLearningExperimentRow,
} from "@/hooks/useStrategyLearningExperiments";
import {
  validatePromoteToQueued,
  UNSUPPORTED_PARAMETER_FAMILIES,
  NUMERIC_PARAMETER_FAMILIES,
  PROMOTE_SAFETY_COPY,
  INELIGIBLE_SAFETY_COPY,
} from "@/lib/experiment-review";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function parameterFamilyLabel(param: string): string {
  switch (param) {
    case "confidence_threshold":   return "Confidence Threshold";
    case "setup_score_threshold":  return "Setup Score Threshold";
    case "coach_penalty":          return "Coach Penalty";
    case "risk_manager_veto":      return "Risk Manager Veto";
    case "strategy_fit":           return "Strategy Fit";
    default:                       return param;
  }
}

function isUnsupported(param: string): boolean {
  return UNSUPPORTED_PARAMETER_FAMILIES.has(param) || !NUMERIC_PARAMETER_FAMILIES.has(param);
}

// ─── Single proposal card ─────────────────────────────────────────────────────

interface ProposalCardProps {
  row: StrategyLearningExperimentRow;
  onPromote: (id: string, opts: PromoteToQueuedOptions) => Promise<void>;
}

function ProposalCard({ row, onPromote }: ProposalCardProps) {
  const [beforeValue, setBeforeValue] = useState(row.beforeValue);
  const [afterValue, setAfterValue] = useState(row.afterValue);
  const [reviewerNotes, setReviewerNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const unsupported = isUnsupported(row.parameter);

  // Live validation — only run if not unsupported
  const validationResult = unsupported
    ? null
    : validatePromoteToQueued({
        id: row.id,
        status: row.status,
        source: row.source,
        parameter: row.parameter,
        beforeValue,
        afterValue,
      });

  const canPromote = !unsupported && !!validationResult?.valid;

  async function handlePromote() {
    setBusy(true);
    try {
      await onPromote(row.id, { beforeValue, afterValue, reviewerNotes });
      toast.success("Experiment queued for backtest evaluation.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to promote experiment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          <FlaskConical className="h-3.5 w-3.5 text-primary shrink-0" />
          <span className="text-sm font-medium text-foreground truncate">{row.title}</span>
        </div>
        <span className="shrink-0 text-[10px] text-muted-foreground">{formatDate(row.createdAt)}</span>
      </div>

      {/* Scope chips */}
      <div className="flex flex-wrap gap-1.5 text-[11px]">
        <Badge variant="secondary" className="font-mono text-[10px]">
          {parameterFamilyLabel(row.parameter)}
        </Badge>
        {row.symbol && (
          <span className="rounded border border-border px-1.5 py-0.5 font-mono text-foreground">
            {row.symbol}
          </span>
        )}
        {row.sourceRecommendationId && (
          <span className="rounded border border-border/50 px-1.5 py-0.5 text-muted-foreground font-mono">
            rec {row.sourceRecommendationId.slice(0, 8)}…
          </span>
        )}
      </div>

      {/* Unsupported — block with copy */}
      {unsupported && (
        <div className="flex items-start gap-2 rounded-md border border-status-caution/30 bg-status-caution/10 p-3 text-xs text-status-caution">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="space-y-1">
            <p className="font-medium">Manual review required</p>
            <p className="text-muted-foreground leading-snug">
              {INELIGIBLE_SAFETY_COPY} Parameter family{" "}
              <span className="font-mono">{row.parameter}</span> requires a manually
              created experiment with specific numeric parameters.
            </p>
          </div>
        </div>
      )}

      {/* Numeric review form */}
      {!unsupported && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor={`before-${row.id}`} className="text-xs">
                Before value{" "}
                <span className="text-muted-foreground">(current threshold)</span>
              </Label>
              <Input
                id={`before-${row.id}`}
                value={beforeValue}
                onChange={(e) => setBeforeValue(e.target.value)}
                placeholder="e.g. 0.65"
                className="h-7 text-xs font-mono"
                disabled={busy}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`after-${row.id}`} className="text-xs">
                After value{" "}
                <span className="text-muted-foreground">(proposed value)</span>
              </Label>
              <Input
                id={`after-${row.id}`}
                value={afterValue}
                onChange={(e) => setAfterValue(e.target.value)}
                placeholder="e.g. 0.55"
                className="h-7 text-xs font-mono"
                disabled={busy}
              />
            </div>
          </div>

          {/* Validation errors (live, non-empty inputs only) */}
          {validationResult && !validationResult.valid &&
            (beforeValue.trim() || afterValue.trim()) && (
            <div className="space-y-1">
              {validationResult.errors.map((err) => (
                <p key={err} className="text-[11px] text-status-blocked leading-snug">
                  {err}
                </p>
              ))}
            </div>
          )}

          {/* Reviewer notes */}
          <div className="space-y-1">
            <Label htmlFor={`notes-${row.id}`} className="text-xs">
              Reviewer notes <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id={`notes-${row.id}`}
              value={reviewerNotes}
              onChange={(e) => setReviewerNotes(e.target.value)}
              placeholder="Add rationale, context, or review notes…"
              rows={2}
              className="text-xs resize-none"
              disabled={busy}
            />
          </div>
        </div>
      )}

      {/* Details toggle */}
      {(row.hypothesis || row.notes) && (
        <div className="border-t border-border/50 pt-2">
          <button
            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
            onClick={() => setShowDetails((v) => !v)}
          >
            <Info className="h-3 w-3" />
            {showDetails ? "Hide" : "Show"} hypothesis &amp; notes
          </button>
          {showDetails && (
            <div className="mt-2 space-y-2 ml-4 border-l-2 border-border pl-3">
              {row.hypothesis && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
                    Hypothesis
                  </div>
                  <p className="text-xs text-foreground/90 leading-relaxed whitespace-pre-wrap">
                    {row.hypothesis}
                  </p>
                </div>
              )}
              {row.notes && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
                    Notes
                  </div>
                  <p className="text-xs text-foreground/90 italic">{row.notes}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Safety copy + promote button */}
      {!unsupported && (
        <div className="border-t border-border/50 pt-3 space-y-2">
          <p className="text-[10px] text-muted-foreground leading-snug max-w-prose">
            {PROMOTE_SAFETY_COPY}
          </p>
          <Button
            size="sm"
            className={cn("h-7 text-xs gap-1.5", canPromote ? "" : "opacity-50")}
            onClick={handlePromote}
            disabled={!canPromote || busy}
          >
            {busy
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <CheckCircle2 className="h-3.5 w-3.5" />}
            Promote to Queued Experiment
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function ExperimentReviewPanel() {
  const { proposals, loading, error, refetch, promoteToQueued } =
    useStrategyLearningExperiments();

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">
              Strategy Learning Experiment Proposals
            </h3>
            {proposals.length > 0 && (
              <Badge variant="secondary" className="text-xs">
                {proposals.length} awaiting review
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground max-w-prose">
            Fill in numeric before / after values and promote to queued. Promoting
            only schedules a research backtest — no strategies, doctrine, or risk
            gates change.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 shrink-0"
          onClick={refetch}
          disabled={loading}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
      </div>

      {/* Safety notice */}
      <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-caution" />
        <span>
          Promoting queues a research backtest only. It does not change strategy
          behavior, doctrine, risk gates, signals, or trades. The existing
          run-experiment pipeline evaluates queued experiments on its own schedule.
        </span>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-md border border-status-blocked/30 bg-status-blocked/10 p-3 text-sm text-status-blocked">
          Failed to load proposals: {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading experiment proposals…
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && proposals.length === 0 && (
        <EmptyState
          icon={<FlaskConical className="h-8 w-8 text-muted-foreground" />}
          title="No proposals awaiting review"
          description="Experiment proposals from accepted strategy learning recommendations appear here. Accept a recommendation in the panel above to create one."
        />
      )}

      {/* Proposals */}
      {!loading && proposals.length > 0 && (
        <div className="space-y-3">
          {proposals.map((row) => (
            <ProposalCard
              key={row.id}
              row={row}
              onPromote={promoteToQueued}
            />
          ))}
        </div>
      )}
    </div>
  );
}
