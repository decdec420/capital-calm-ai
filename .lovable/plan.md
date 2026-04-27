# Copilot Chat Latency Fix

## What you saw

You sent a message → waited ~30s → sent a second message → the **first** answer streamed in **below** your second send, and the second is still pending. So responses came back out of order relative to where you typed.

## Root causes

I traced this to two real issues in `supabase/functions/copilot-chat/index.ts` and `src/pages/Copilot.tsx`:

**1. The function does a slow blocking "tool-detection" pass before streaming.**
Every chat turn currently runs **two** Lovable AI Gateway calls back-to-back:
- Pass 1: non-streaming call with `tools: DESK_TOOLS, tool_choice: "auto"` to see if Harvey wants to call a tool. This is fully synchronous — nothing reaches the browser until it finishes. With Gemini-flash + a long system prompt + 80 turns of history + agent-health enrichment, this can easily take 10–30s. **That is your dead air.**
- Pass 2: the actual streaming call.

In ~95% of chat turns Harvey doesn't call any tool, so pass 1 is wasted latency.

**2. The UI doesn't actually block the second send the way it looks like it does.**
`send()` early-returns when `streaming === true`, so your second Enter should have been ignored — but looking at the code, the input textarea isn't disabled and there's no visible "thinking…" placeholder bubble in the message list while pass 1 is running. So it *feels* like nothing is happening, you hit send again, and then when pass 1 finally completes the stream lands and `reloadActiveMessages()` re-pulls from the DB. The DB now has: [your msg 1, assistant reply 1, your msg 2 (which never got sent because streaming was true and it bailed silently)]. Result: the second message looks "stuck" because it was never actually sent — just visually queued in the input box, or appended locally then wiped on reload.

## The fix

### Edge function — `supabase/functions/copilot-chat/index.ts`

- **Remove the blocking first-pass tool detection by default.** Switch to single-pass streaming with `tools: DESK_TOOLS, tool_choice: "auto"` and `stream: true`. Lovable AI Gateway returns tool_calls in the SSE stream — handle them inline. If the model emits tool_calls instead of text content, execute the tools after the stream ends, then make a follow-up streaming call with the tool results. This means: in the common no-tool case, the user sees the first token in 1–3s instead of 15–30s.
- **Cut the agent_health DB read out of the hot path.** Move it behind a small in-memory cache (e.g. fetch only if the cached value is >60s old). Right now it runs on every single message.
- **Reduce `MAX_HISTORY_TURNS` from 80 to 30.** 80 turns of history is huge and dominates tokenization/processing time — 30 is more than enough context for chat.

### Frontend — `src/pages/Copilot.tsx` + `useConversations.ts`

- **Disable the textarea and send button while `streaming` is true** so the user can't fire a second message into the void. Show a clear "Harvey is thinking…" affordance under the input.
- **Show an immediate placeholder assistant bubble** (empty, with a pulsing cursor or "…") the moment `send()` is called, so there's visible feedback even before the first SSE chunk arrives. This is what `appendLocalMessage` was supposed to do but it only inserts the user message — also seed an empty assistant message immediately.
- **Surface a toast if `send()` is called while streaming** ("Hold on — Harvey is still answering") instead of silently returning.
- **On stream error/abort, do NOT call `reloadActiveMessages()`** — only reload after a successful completion. Right now an aborted stream can wipe the local optimistic user message because the DB reload becomes the source of truth.

## What this changes for you

- First token from Harvey in **1–3s** (down from 10–30s).
- Input is locked while a reply is in flight, with a clear "thinking" indicator.
- Second message can't be silently dropped.
- Tool calls (approve_signal, run_engine_tick, etc.) still work — just executed inline during streaming instead of via a separate blocking pre-pass.

## Files to change

- `supabase/functions/copilot-chat/index.ts` — single-pass streaming with inline tool handling, cached agent_health, smaller history window.
- `src/pages/Copilot.tsx` — disabled input while streaming, immediate empty-assistant placeholder, guarded reload-on-success-only, "still answering" toast on retry.
- `src/hooks/useConversations.ts` — small helper to seed an empty assistant placeholder atomically with the user message.

## What I will not touch

- The system prompt / Harvey persona.
- Tool definitions in `_shared/desk-tools.ts`.
- Rate limiting (20 req/60s stays).
- The conversation/message DB schema.
- All existing tests must still pass.
