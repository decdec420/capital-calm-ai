# Axe Capital — Desk Tool Inventory

> **Last updated:** 2026-04-29  
> **Source of truth:** `supabase/functions/_shared/desk-tools.ts`  
> **Authority:** Only Bobby (`jessica_autonomous`) and Wags (`harvey_chat`) may call these tools. All calls are logged to `tool_calls` and `system_events` with actor + reason.

---

## Characters & Function Mapping

| Character | Role | Edge Function | Technical Actor ID |
|-----------|------|--------------|-------------------|
| **Bobby** | Desk Commander — autonomous orchestrator | `jessica` | `jessica_autonomous` |
| **Wags** | COO — operator interface | `copilot-chat` | `harvey_chat` |
| **Taylor** | Chief Quant/CIO — signal scoring & strategy review | `signal-engine` / `katrina` | *(called, not a tool actor)* |
| **Dollar Bill** | Crypto Intel — Brain Trust Expert 2 | `market-intelligence` | *(called, not a tool actor)* |
| **Mafee** | Pattern Recognition — Brain Trust Expert 3 | `market-intelligence` | *(called, not a tool actor)* |
| **Hall** | Macro Strategist — Brain Trust Expert 1 | `market-intelligence` | *(called, not a tool actor)* |
| **Chuck** | Risk Manager — binary veto | gates inside `signal-engine` | *(passive, not a tool actor)* |
| **Wendy** | Performance Coach — grades closed trades | `post-trade-learn` | *(called, not a tool actor)* |

---

## Legacy Technical Names

These technical IDs are intentionally unchanged for compatibility with deployed edge functions, logs, and historical data:

| Technical ID | Product persona | Notes |
|--------------|-----------------|-------|
| `jessica` | **Bobby** (Desk Commander) | Legacy function/agent key retained by design. |
| `harvey_chat` | **Wags** (COO operator interface) | Legacy chat actor ID retained by design. |
| `katrina` | **Taylor** (Chief Quant/CIO review path) | Legacy review pipeline name retained by design. |

---

## Tool Reference

### `run_brain_trust`
**Purpose:** Triggers a fresh Brain Trust run (Hall + Dollar Bill + Mafee) for one symbol or all symbols.  
**Who calls it:** Bobby (auto, when intel is stale) · Wags (manual, operator request)  
**When to use:** Market intelligence is >5 hours old, or a major news event just dropped and the context is stale.  
**Required args:** `reason` (string)  
**Optional args:** `symbol` (string — omit to refresh all 3)  
**Returns:** HTTP response from the `market-intelligence` edge function  
**Audit log action:** `brain_trust_refresh`

---

### `run_engine_tick`
**Purpose:** Fires Taylor's signal engine off-schedule (outside the 1-minute cron).  
**Who calls it:** Bobby (auto, when conditions change mid-tick) · Wags (manual, operator "run now")  
**When to use:** Something just changed — a news flag cleared, a pause ended — and waiting 60 seconds for the next cron would miss the window.  
**Required args:** `reason` (string)  
**Returns:** HTTP response from the `signal-engine` edge function  
**Audit log action:** `engine_tick`  
**Guard:** Bobby must not call this if the last tick was <90 seconds ago.

---

### `get_pending_signals`
**Purpose:** Fetches all pending trade signals currently awaiting a decision from Bobby.  
**Who calls it:** Bobby (always before approve/reject) · Wags (manual review)  
**When to use:** Always — Bobby must call this before `approve_signal` or `reject_signal`. Hard rule.  
**Required args:** none  
**Returns:** Array of `trade_signals` rows with `id, symbol, side, confidence, setup_score, ai_reasoning, created_at, expires_at`  
**Note:** Only returns signals where `expires_at > NOW()` — stale signals from before a pause window are automatically excluded.

---

### `approve_signal`
**Purpose:** Approves a pending trade signal. The signal still flows through Chuck's doctrine gates — this is **not** a risk bypass.  
**Who calls it:** Bobby (auto — `autonomous` or `assisted` mode) · Wags (manual override)  
**When to use:** Bobby calls `get_pending_signals`, evaluates against regime + conviction bars, then approves if it passes.  
**Required args:** `signal_id` (UUID), `reasoning` (string — logged to audit trail)  
**Returns:** `{ success, data }` — includes whether execution proceeded  
**Audit log action:** `approve_signal`  
**Paper mode bars:** confidence ≥ 0.55, setup_score ≥ 0.45 · **Live mode bars:** confidence ≥ 0.65, setup_score ≥ 0.55

---

### `reject_signal`
**Purpose:** Rejects a pending trade signal, marking it `rejected` in the database.  
**Who calls it:** Bobby (auto) · Wags (manual)  
**When to use:** Signal fails Bobby's conviction check — regime mismatch, anti-tilt active, critical news flag.  
**Required args:** `signal_id` (UUID), `reason` (string)  
**Returns:** `{ success }`  
**Audit log action:** `reject_signal`

---

### `pause_bot`
**Purpose:** Halts all trading for N minutes by setting `trading_paused_until` on `system_state`.  
**Who calls it:** Bobby (auto — consecutive stop-outs, critical news) · Wags (operator-triggered)  
**When to use:** Adverse market conditions, consecutive losses, high-severity news event, explicit operator request.  
**Required args:** `minutes` (number, max 120) · `reason` (string)  
**Returns:** `{ success }`  
**Audit log action:** `pause_bot`  
**Hard limit:** Bobby cannot autonomously pause for >120 minutes. Longer requires Wags.

---

### `resume_bot`
**Purpose:** Clears the pause window early, resuming trading before the timer expires.  
**Who calls it:** Bobby (auto, if conditions cleared) · Wags (manual — operator says go)  
**When to use:** The condition that triggered the pause has resolved before the timer ran out.  
**Required args:** `reason` (string)  
**Returns:** `{ success }`  
**Audit log action:** `resume_bot`

---

### `set_autonomy`
**Purpose:** Changes the bot's autonomy level (`manual` / `assisted` / `autonomous`).  
**Who calls it:** Wags only — this is the **operator's call exclusively**.  
**When to use:** Operator decides to step up or step back how aggressively Bobby self-executes.  
**Required args:** `level` (enum: `manual` | `assisted` | `autonomous`) · `reason` (string)  
**Returns:** `{ success }`  
**Audit log action:** `set_autonomy`  
**Hard rule:** Bobby is **never** permitted to call `set_autonomy`. This tool is restricted to Wags.

---

### `list_pending_experiments`
**Purpose:** Fetches experiment rows that are queued, running, or flagged for operator review.  
**Who calls it:** Bobby (auto) · Wags (manual review)  
**When to use:** Always call before `accept_experiment` or `reject_experiment`.  
**Required args:** none  
**Returns:** Array of `experiments` rows with pending/review status

---

### `accept_experiment`
**Purpose:** Marks an experiment as accepted and clears review flags. Does **not** promote to candidate strategy — that's an explicit UI action.  
**Who calls it:** Bobby (auto, based on Taylor's review) · Wags (manual)  
**When to use:** Taylor's review (katrina) surfaced a hypothesis worth keeping. Acceptance signals "don't archive this yet."  
**Required args:** `experiment_id` (UUID) · `reason` (string)  
**Returns:** `{ success }`  
**Audit log action:** `accept_experiment`

---

### `reject_experiment`
**Purpose:** Rejects an experiment and clears review flags. The experiment is effectively archived.  
**Who calls it:** Bobby (auto) · Wags (manual)  
**When to use:** Sample quality is weak, overfit risk is high, or the hypothesis failed under Taylor's review.  
**Required args:** `experiment_id` (UUID) · `reason` (string)  
**Returns:** `{ success }`  
**Audit log action:** `reject_experiment`

---

## Audit Trail

Every tool call is logged in two places:

**`tool_calls` table** — append-only record of every tool execution:
- `actor`: technical actor ID (`harvey_chat` / `jessica_autonomous`)
- `tool_name`: name of the tool called
- `tool_args`: full args JSON
- `reason`: the reason string passed by the caller
- `result`: the response payload
- `success`: boolean
- `called_at`: timestamp

**`system_events` table** — higher-level event stream:
- `actor`: display name (`wags` / `bobby`) — mapped from technical actor ID
- `event_type`: action label (e.g. `approve_signal`, `pause_bot`)
- `payload`: relevant context for the event

---

## Trade Authority Summary

```
Taylor scores a setup → Chuck vetoes or passes → Bobby approves → Trade executes
                                                   ↑
                              (or Wags approves manually from copilot-chat)
```

Only `jessica_autonomous` and `harvey_chat` may call `executeTool()`. Any other actor is rejected at the authority gate before touching any state.
