// ============================================================
// Strategy Learning Review Panel — PR #40
// ------------------------------------------------------------
// Displays strategy_learning_recommendations for human review.
// Supports accept / reject / defer actions.
//
// Safety copy is prominent: accepting a recommendation ONLY
// records operator review. It NEVER auto-mutates strategies,
// doctrine, risk gates, or creates trades.
//
// Safety-block recommendations (REINFORCE_BLOCKER for kill switch,
// daily cap, floor, etc.) show a "Reinforce only" badge and have
// no ambiguous action buttons — only "Acknowledge" (accept).
// ============================================================

import React, { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/trader/EmptyState";
import { StatusBadge } from "@/components/trader/StatusBadge";
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Clock,
  FlaskConical,
  Loader2,
  RefreshCw,
  Shield,
  TrendingUp,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  useStrategyLearningRecommendations,
  type StrategyLearningRecommendationRow,
} from "@/hooks/useStrategyLearningRecommendations";
import {
  isExperimentEligible,
  type RecommendationType,
} from "@/lib/strategy-learning";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SAFETY_BLOCK_CODES = new Set([
  "KILL_SWITCH_ACTIVE",
  "DAILY_LOSS_CAP_REACHED",
  "ACCOUNT_FLOOR_BREACHED",
  "MAX_TRADES_REACHED",
  "COOLDOWN_ACTIVE",
  "DOCTRINE_BLOCK",
  "RISK_GATE_BLOCK",
]);

function isSafetyBlock(row: StrategyLearningRecommendationRow): boolean {
  return (
    row.recommendation_type === "REINFORCE_BLOCKER" &&
    SAFETY_BLOCK_CODES.has(row.reason_code)
  );
}

function typeLabel(type: RecommendationType): string {
  switch (type) {
    case "REINFORCE_BLOCKER":    return "Reinforce Blocker";
    case "QUESTION_BLOCKER":     return "Question Blocker";
    case "TUNE_THRESHOLD":       return "Tune Threshold";
    case "REVIEW_STRATEGY_FIT":  return "Strategy Fit Review";
    case "INSUFFICIENT_EVIDENCE": return "Insufficient Evidence";
  }
}

function typeTone(type: RecommendationType): "safe" | "caution" | "blocked" | "neutral" {
  switch (type) {
    case "REINFORCE_BLOCKER":     return "safe";
    case "QUESTION_BLOCKER":      return "caution";
    case "TUNE_THRESHOLD":        return "caution";
    case "REVIEW_STRATEGY_FIT":   return "caution";
    case "INSUFFICIENT_EVIDENCE": return "neutral";
  }
}

function statusTone(status: string): "safe" | "caution" | "blocked" | "neutral" {
  if (status === "accepted")  return "safe";
  if (status === "rejected")  return "blocked";
  if (status === "deferred")  return "caution";
  return "neutral";
}

function confidencePct(c: number) {
  return `${Math.round(c * 100)}%`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── Review dialog ────────────────────────────────────────────────────────────

interface ReviewDialogProps {
  row: StrategyLearningRecommendationRow | null;
  mode: "accept" | "reject" | "defer" | null;
  onClose: () => void;
  onConfirm: (decision: string) => Promise<void>;
}

function ReviewDialog({ row, mode, onClose, onConfirm }: ReviewDialogProps) {
  const [decision, setDecision] = useState("");
  const [busy, setBusy] = useState(false);

  if (!row || !mode) return null;

  const isSafety = isSafetyBlock(row);

  const title =
    mode === "accept" ? (isSafety ? "Acknowledge safety block" : "Accept recommendation") :
    mode === "reject" ? "Reject recommendation" :
    "Defer recommendation";

  const description =
    mode === "accept"
      ? isSafety
        ? "This records that you have reviewed and acknowledged the safety block finding. The block remains active and is NOT modified."
        : "This records your operator review only. It does NOT automatically change any strategy, doctrine, risk gate, or position. Strategy changes require a separate reviewed action."
      : mode === "reject"
      ? "This records that you have reviewed and dismissed this recommendation. No strategy or doctrine changes occur."
      : "This records that you are postponing review. No changes occur now.";

  async function handleConfirm() {
    setBusy(true);
    try {
      await onConfirm(decision.trim());
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Review action failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={() => !busy && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground mt-1">
            {description}
          </DialogDescription>
        </DialogHeader>

        {isSafety && mode === "accept" && (
          <div className="flex items-start gap-2 rounded-md border border-status-safe/30 bg-status-safe/10 p-3 text-sm text-status-safe">
            <Shield className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Safety blocks are never weakened automatically. Acknowledging means
              the gate worked as intended and should remain in place.
            </span>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="decision-notes" className="text-sm">
            Notes <span className="text-muted-foreground">(optional)</span>
          </Label>
          <Textarea
            id="decision-notes"
            placeholder="Add context, rationale, or next steps…"
            value={decision}
            onChange={(e) => setDecision(e.target.value)}
            rows={3}
            disabled={busy}
          />
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={busy}
            variant={mode === "reject" ? "destructive" : "default"}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            {mode === "accept" ? (isSafety ? "Acknowledge" : "Accept") :
             mode === "reject" ? "Reject" : "Defer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Single recommendation card ───────────────────────────────────────────────

interface RecommendationCardProps {
  row: StrategyLearningRecommendationRow;
  onReview: (row: StrategyLearningRecommendationRow, mode: "accept" | "reject" | "defer") => void;
  onCreateProposal: (row: StrategyLearningRecommendationRow) => Promise<string | void>;
  proposalId: string | undefined;
}

function RecommendationCard({ row, onReview, onCreateProposal, proposalId }: RecommendationCardProps) {
  const isPending = row.status === "pending_review";
  const isAccepted = row.status === "accepted";
  const safety = isSafetyBlock(row);
  const eligible = isExperimentEligible({ recommendation_type: row.recommendation_type, reason_code: row.reason_code, status: row.status });
  const [proposalBusy, setProposalBusy] = useState(false);

  async function handleCreateProposal() {
    setProposalBusy(true);
    try {
      await onCreateProposal(row);
      toast.success("Experiment proposal created — visible in Strategy Lab.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create experiment proposal");
    } finally {
      setProposalBusy(false);
    }
  }

  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-4 space-y-3 transition-colors",
        isPending ? "border-border" : "border-border/50 opacity-80",
      )}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge tone={typeTone(row.recommendation_type)}>
            {typeLabel(row.recommendation_type)}
          </StatusBadge>
          {safety && (
            <span className="inline-flex items-center gap-1 rounded-full border border-status-safe/30 bg-status-safe/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-status-safe">
              <Shield className="h-3 w-3" />
              Reinforce only
            </span>
          )}
          {!isPending && (
            <StatusBadge tone={statusTone(row.status)} size="sm">
              {row.status === "pending_review" ? "Pending" :
               row.status.charAt(0).toUpperCase() + row.status.slice(1)}
            </StatusBadge>
          )}
        </div>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {formatDate(row.created_at)}
        </span>
      </div>

      {/* Scope chips */}
      <div className="flex flex-wrap gap-1.5 text-[11px]">
        {row.symbol && (
          <span className="rounded border border-border px-1.5 py-0.5 font-mono text-foreground">
            {row.symbol}
          </span>
        )}
        {row.market_regime && (
          <span className="rounded border border-border px-1.5 py-0.5 text-muted-foreground">
            {row.market_regime}
          </span>
        )}
        <span className="rounded border border-border px-1.5 py-0.5 font-mono text-muted-foreground">
          {row.reason_code}
        </span>
      </div>

      {/* Recommendation text */}
      <p className="text-sm text-foreground leading-snug">{row.recommendation}</p>

      {/* Stats row */}
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span>
          <span className="font-medium text-foreground">{row.evidence_count}</span> samples
          {" "}·{" "}
          <span className="font-medium text-foreground">{row.sample_quality}</span> quality
        </span>
        <span>
          Confidence{" "}
          <span className="font-medium text-foreground">{confidencePct(row.confidence)}</span>
        </span>
        {row.supporting_simulation_ids.length > 0 && (
          <span>
            {row.supporting_simulation_ids.length} simulation{row.supporting_simulation_ids.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Reviewed info */}
      {!isPending && row.reviewed_at && (
        <div className="text-xs text-muted-foreground border-t border-border/50 pt-2">
          Reviewed {formatDate(row.reviewed_at)}
          {row.reviewed_by ? ` by ${row.reviewed_by}` : ""}
          {row.decision ? ` — ${row.decision}` : ""}
        </div>
      )}

      {/* Action buttons (pending only) */}
      {isPending && (
        <div className="flex items-center gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1.5"
            onClick={() => onReview(row, "accept")}
          >
            <CheckCircle2 className="h-3.5 w-3.5 text-status-safe" />
            {safety ? "Acknowledge" : "Accept"}
          </Button>
          {!safety && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1.5"
                onClick={() => onReview(row, "defer")}
              >
                <Clock className="h-3.5 w-3.5 text-status-caution" />
                Defer
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1.5"
                onClick={() => onReview(row, "reject")}
              >
                <XCircle className="h-3.5 w-3.5 text-status-blocked" />
                Reject
              </Button>
            </>
          )}
        </div>
      )}

      {/* Experiment proposal section — accepted recommendations only */}
      {isAccepted && (
        <div className="border-t border-border/50 pt-3 mt-1 space-y-2">
          {eligible ? (
            <>
              {proposalId ? (
                <div className="flex items-center gap-1.5 text-xs text-status-safe">
                  <FlaskConical className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    Experiment proposal already created.{" "}
                    <span className="text-muted-foreground font-mono">{proposalId.slice(0, 8)}…</span>
                    {" "}— visible in Strategy Lab.
                  </span>
                </div>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs gap-1.5"
                    onClick={handleCreateProposal}
                    disabled={proposalBusy}
                  >
                    {proposalBusy
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <FlaskConical className="h-3.5 w-3.5 text-primary" />}
                    Create Experiment Proposal
                  </Button>
                  <p className="text-[10px] text-muted-foreground leading-snug max-w-prose">
                    Creating an experiment proposal does not change strategy behavior.
                    It only queues a research task for the existing backtest/evaluation pipeline.
                  </p>
                </>
              )}
            </>
          ) : (
            <p className="text-[10px] text-muted-foreground leading-snug max-w-prose">
              {safety
                ? "Safety-block recommendations cannot create weakening experiments. They can only be acknowledged or reinforced."
                : "This recommendation is not eligible for an experiment proposal because it reinforces a safety rule or has insufficient evidence."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function StrategyLearningReviewPanel() {
  const { pending, reviewed, loading, error, refetch, accept, reject, defer, createExperimentProposal, proposalIds } =
    useStrategyLearningRecommendations();

  const [dialogRow, setDialogRow] = useState<StrategyLearningRecommendationRow | null>(null);
  const [dialogMode, setDialogMode] = useState<"accept" | "reject" | "defer" | null>(null);
  const [showReviewed, setShowReviewed] = useState(false);

  function openReview(row: StrategyLearningRecommendationRow, mode: "accept" | "reject" | "defer") {
    setDialogRow(row);
    setDialogMode(mode);
  }

  function closeDialog() {
    setDialogRow(null);
    setDialogMode(null);
  }

  async function handleConfirm(decision: string) {
    if (!dialogRow || !dialogMode) return;
    const payload = decision ? { decision } : {};
    if (dialogMode === "accept") await accept(dialogRow.id, payload);
    else if (dialogMode === "reject") await reject(dialogRow.id, payload);
    else await defer(dialogRow.id, payload);
    toast.success(
      dialogMode === "accept" ? "Recommendation acknowledged" :
      dialogMode === "reject" ? "Recommendation rejected" :
      "Recommendation deferred",
    );
  }

  const total = pending.length + reviewed.length;

  return (
    <div className="space-y-4">
      {/* Safety header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Brain className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Strategy Learning Recommendations</h3>
            {pending.length > 0 && (
              <Badge variant="secondary" className="text-xs">
                {pending.length} pending
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground max-w-prose">
            Proposal-only — patterns detected across enriched simulation outcomes.
            Accepting a recommendation records your review only.
            No strategies, doctrine, or risk gates change automatically.
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
          These are learning signals, not automatic strategy changes. Accepting records
          operator review. Strategy or doctrine changes require a separate action.
          Safety blocks are never weakened — reinforce means the gate worked correctly.
        </span>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-md border border-status-blocked/30 bg-status-blocked/10 p-3 text-sm text-status-blocked">
          Failed to load recommendations: {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading recommendations…
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && total === 0 && (
        <EmptyState
          icon={<TrendingUp className="h-8 w-8 text-muted-foreground" />}
          title="No recommendations yet"
          description="Strategy learning recommendations appear here once process-strategy-learning has processed enriched simulation data."
        />
      )}

      {/* Pending */}
      {!loading && pending.length > 0 && (
        <div className="space-y-2">
          {pending.map((row) => (
            <RecommendationCard
              key={row.id}
              row={row}
              onReview={openReview}
              onCreateProposal={createExperimentProposal}
              proposalId={proposalIds.get(row.id)}
            />
          ))}
        </div>
      )}

      {/* Reviewed toggle */}
      {!loading && reviewed.length > 0 && (
        <div className="space-y-2">
          <button
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setShowReviewed((v) => !v)}
          >
            {showReviewed ? <XCircle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            {showReviewed ? "Hide" : "Show"} {reviewed.length} reviewed
          </button>
          {showReviewed && (
            <div className="space-y-2">
              {reviewed.map((row) => (
                <RecommendationCard
                  key={row.id}
                  row={row}
                  onReview={openReview}
                  onCreateProposal={createExperimentProposal}
                  proposalId={proposalIds.get(row.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Review dialog */}
      <ReviewDialog
        row={dialogRow}
        mode={dialogMode}
        onClose={closeDialog}
        onConfirm={handleConfirm}
      />
    </div>
  );
}
