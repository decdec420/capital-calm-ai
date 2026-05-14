# 7-Day Paper Trading Ops Readiness Checklist

This runbook is the operating checklist for PR #58. It is not a feature plan and it does not authorize live trading. The purpose is to run the existing paper-trading company loop for seven calendar days, watch the app, capture real failures, and only patch verified operational issues.

## Safety Invariants

- Live trading remains disabled for the full run.
- Broker execution remains disabled or paper-only for the full run.
- No live broker order should be attempted.
- No live signal should be approved by automation.
- Doctrine and risk gates are observed, not mutated.
- Strategies and strategy parameters are observed, not mutated.
- Experiments remain proposal/review-only.
- Soft-exit output remains simulation/review-only unless a separate reviewed live-trading process exists later.
- `liveExecutionAllowed` must remain `false` in smoke/readiness surfaces.

## Day 0 Setup

Complete every item before starting Day 1.

- [ ] Confirm required environment variables are present in the deployment environment.
- [ ] Confirm no raw secrets are exposed in the UI, logs, `system_events`, cron health payloads, or docs.
- [ ] Confirm Supabase migrations have been applied.
- [ ] Confirm scheduled Edge Function support is configured through `pg_cron` + `pg_net` where applicable.
- [ ] Confirm cron tokens/secrets are stored in Supabase Vault, not hard-coded in migrations, UI, or logs.
- [ ] Confirm Edge Functions are deployed.
- [ ] Confirm cron jobs are visible in Cron Health, backed by `cron.job` / `cron.job_run_details` visibility.
- [ ] Confirm there are not more than eight concurrently active cron jobs expected to run at the same time.
- [ ] Confirm live mode is disabled.
- [ ] Confirm broker execution is disabled or paper-only.
- [ ] Confirm doctrine/risk gates are visible.
- [ ] Confirm the portfolio risk panel is visible.
- [ ] Confirm Quiet Mode status panel is visible.
- [ ] Confirm execution-data readiness panel is visible and honest about missing maker/taker/fill-quality fields.
- [ ] Confirm OpsTimeline / Hall incidents are visible.
- [ ] Confirm market intelligence, signal engine, decision memory, simulation/enrichment, strategy learning, experiment review, soft-exit simulation, cron health, quiet mode, execution-data readiness, and Hall/Ops surfaces are observable.

## Daily Checks — Day 1 Through Day 7

Run this checklist once per day and attach notes/screenshots/log IDs to the daily ops record.

### Company Loop

- [ ] Did market intelligence refresh for BTC-USD, ETH-USD, and SOL-USD?
- [ ] Did the signal engine run?
- [ ] Did multi-symbol evaluations occur?
- [ ] Did portfolio/risk/doctrine gates evaluate each candidate?
- [ ] Did risk gates block unsafe candidates correctly?
- [ ] Did paper signals/trades appear when conditions allowed?
- [ ] Did replay packets appear or remain representable for proposed/blocked/skipped decisions?
- [ ] Did `decision_memory` grow with proposed, blocked, and skipped decisions?
- [ ] Did simulations/enrichment run from decision memory inputs?
- [ ] Did strategy learning recommendations appear only as proposal/review outputs?
- [ ] Did experiment proposals remain review-only?
- [ ] Did soft-exit simulations appear only when open positions and regime flips existed?
- [ ] Did soft-exit review/learning remain simulation-only with execution disabled?

### Ops Visibility

- [ ] Did Quiet Mode activate only when safe, while preserving safety checks?
- [ ] Did Cron Health stay OK/warning as expected?
- [ ] Were all critical cron jobs visible?
- [ ] Did `system_events` retention keep noise controlled?
- [ ] Did execution-data readiness remain honest about insufficient/partial data?
- [ ] Did Lovable/Supabase IO and cost stay sane?
- [ ] Were there any incidents in Hall/Ops?
- [ ] Were repeated incidents classified and visible?
- [ ] Were any raw secrets exposed? The answer must be no.
- [ ] Was any live broker execution attempted? The answer must be no.

## Stop Conditions

Stop the 7-day paper run immediately and investigate if any condition occurs:

- [ ] Live broker order attempted.
- [ ] Doctrine/risk mutation without review.
- [ ] Strategy mutation without review.
- [ ] Unknown exposure in live mode.
- [ ] Missing cron critical job.
- [ ] Repeated critical Hall/Ops incidents.
- [ ] system_events runaway growth.
- [ ] Raw secret exposure.
- [ ] Costs/IO spike.

## Daily Evidence Template

Use one copy per day.

```text
Date:
Operator:
Live mode disabled: yes/no
Broker execution disabled or paper-only: yes/no
Cron Health status:
Quiet Mode status:
Execution-data readiness:
Market intelligence refreshed:
Signal engine ran:
Symbols evaluated:
Risk/doctrine gates observed:
Paper signals/trades observed:
Replay packets observed:
decision_memory delta:
Simulation/enrichment observed:
Strategy learning proposals:
Experiment proposals review-only:
Soft-exit simulations:
Hall/Ops incidents:
System events volume:
Supabase/Lovable IO/cost:
Raw secret exposure: no/yes
Live broker execution attempted: no/yes
Stop condition triggered: no/yes
Notes / IDs / screenshots:
```

## After Day 7

- Summarize paper-loop reliability, missing data, and incidents.
- Patch only real failures found during the run.
- Do not resume feature-building until the 7-day evidence is reviewed.
