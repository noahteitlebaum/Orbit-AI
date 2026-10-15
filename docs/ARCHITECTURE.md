# Architecture Note — Orbit AI

## Layers (keep them separate)
```
src/
  app/                 # Next.js routes and UI (chat, sign-in, usage, admin)
  components/          # UI components
  server/
    auth/              # session, uwo.ca eligibility check
    chat/              # orchestration: load history → build context → reserve → call → reconcile → save
    providers/         # one adapter per provider + shared interface
      types.ts
      openai.ts  anthropic.ts  google.ts  xai.ts
    billing/           # reserve / reconcile / ledger / limits / kill switches
    storage/           # DB access (conversations, messages, ledger)
  config/
    models.ts          # model IDs, provider, context window, max output, prices, enabled flag
    economics.ts       # allowances, trial cap, rate limits, currency, PAYMENTS_ENABLED
```

## Provider-neutral message format
```ts
type Role = 'system' | 'user' | 'assistant';
interface Message {
  id: string; conversationId: string; seq: number;   // seq preserves order
  role: Role; content: string;                       // text only for launch
  modelId?: string;                                  // which model wrote an assistant message
  status: 'complete' | 'partial' | 'error';
  createdAt: string;
}
interface ProviderAdapter {
  id: 'openai' | 'anthropic' | 'google' | 'xai';
  toProviderRequest(history: Message[], model: ModelConfig, maxOutput: number): unknown;
  stream(req: unknown, signal: AbortSignal): AsyncIterable<{ delta?: string; usage?: Usage }>;
  normalizeUsage(raw: unknown): Usage;   // input, output, cached, reasoning tokens
  normalizeError(e: unknown): ProviderError; // timeout | rate_limit | auth | unavailable | unknown
}
```
Each adapter maps roles to its own API format. For example, Anthropic and Google take the system prompt separately, and Google calls the assistant role `model`. Replies from other models are passed as `assistant` turns, in order.

## Context policy
Full history stays in `messages`; prompt selection never deletes it. `config/context.ts` controls an approximately
8,000-token input target (output budget is separate). Send up to six recent user exchanges where they fit, a running
summary (1,500-token allowance), and up to 800 estimated tokens of matching older messages. Local lexical retrieval
runs only over this conversation's ownership-checked/RLS-filtered rows. It is deterministic, requires shared words,
and can miss semantic matches or oversized messages; it does not promise complete recall.

Material uses 2,000 estimated tokens normally; explicit summarize/review/compare/whole-file requests can use 12,000.
Older small attachments participate in keyword retrieval instead of being resent whole. Visual page limits still apply.
A current task with large input, images, tool results, or material can expand the target to at most 24,000 estimated input
tokens (also capped by the model configuration). Old history alone never triggers expansion. Reject oversized assembled
input before the answer call. Estimates are approximate, especially for images; provider-reported tokens settle the bill.
The UI discloses selection, omissions and potentially stale summaries; selected file passages are disclosed to the model.

Summaries fold only newly omitted messages; an existing summary is refreshed after at least four newly omitted messages.
There are at most four batch calls per request, with bounded transcripts. Failed or unaffordable refreshes retain the old
summary, and never advance its saved position. Every summary call reserves and settles separately with ledger kind
`summary`. The answer uses kind `text`; `embedding` is a distinct supported ledger category. **No embedding service or
persistent embedding index is used in this version: embedding expense is zero.** Never add an embedding call without
reserve/call/settle and a verified configured price. `recentAnswerCosts` excludes auxiliary calls.

Saved memories are separately opted in via Settings. Only matching memories (up to 500 estimated tokens) enter a prompt;
profile response preferences always apply. Memory loads and deletes use authenticated RLS. Each request reads current
rows; no process cache or duplicate search index can retain deleted saved memories. Deleting a saved memory removes
that memory, not the independently saved original conversation; deleting a chat removes its summary by cascade with
its conversation row. Cross-chat history retrieval is not enabled. Memory-off disables saved-memory use and saving.

Caching: OpenAI and xAI receive opaque per-user/per-conversation cache keys; Google uses implicit caching; Anthropic
uses an ephemeral (5-minute) system-block breakpoint. Static system instructions precede variable material/summary.
No explicit Google cache objects or storage charges are introduced. Cache hits are opportunistic; full-price misses and
cache-write premiums are reserved up front. Usage separates reads and writes; actual cost uses verified cached-input
rates in `config/models.ts`, falling back to full input price if unset. Provider cache lifetimes do not replace application
deletion rules: subsequent requests rebuild prompts from current data.

Apply **migration 0009 before deploying this code**: it adds auxiliary ledger categories and cache-write token accounting,
and updates the server-only settlement RPC. Analytics contain only IDs, expense kind, token counts, money, status and
error codes; never query message, summary, memory or prompt text for analytics. Expense example:

```sql
select kind, model_id, sum(actual_micros) as expense_micros,
       sum(input_tokens) as input_tokens, sum(cached_tokens) as cache_reads,
       sum(cache_write_tokens) as cache_writes
from public.ledger where state = 'settled' group by kind, model_id;
```

Caching references checked Oct 15, 2026:
- https://developers.openai.com/api/docs/guides/prompt-caching
- https://developers.openai.com/api/docs/models/gpt-6-astra
- https://developers.openai.com/api/docs/models/gpt-6-luna
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- https://ai.google.dev/gemini-api/docs/caching
- https://docs.x.ai/developers/models/grok-4.7

## Data model (Postgres, RLS on every table)
- `profiles(user_id, email, email_verified, plan, status)`
- `conversations(id, user_id, title, created_at, updated_at)`
- `messages(id, conversation_id, seq, role, content, model_id, status, created_at)`
- `budgets(user_id, period_start, allowance_cents, spent_cents, reserved_cents)`
- `ledger(id, user_id, request_id UNIQUE, model_id, reserved_cents, actual_cents, input_tokens, output_tokens, reasoning_tokens, cached_tokens, state, created_at)`. `state` is one of `reserved | settled | uncertain | released`.
- `settings(key, value)`: global spending stop, provider enabled flags
- `payment_events(event_id UNIQUE, ...)`: later, makes repeated events safe to process

Store money as integer micro-cents (or numeric) to avoid float rounding.

## Request flow (server only)
1. Auth: valid session, email verified, and the domain is exactly `uwo.ca`.
2. Ownership: the conversation belongs to the user.
3. Gates: the global stop is off, the provider is enabled, the model is allowed for this plan, and the rate limit passes.
4. Build context (policy above). Estimate the cost upper bound: `input_tokens × in_price + maxOutput (incl. reasoning) × out_price`.
5. **Atomic reserve.** In one SQL statement or function:
   `UPDATE budgets SET reserved = reserved + :bound WHERE user_id=:u AND allowance - spent - reserved >= :bound RETURNING ...`
   If no row comes back, either lower `maxOutput` to fit or reject with a budget-pause message. Insert the ledger row with `state='reserved'` and an idempotent `request_id`.
6. Save the user message, then stream from the provider.
7. **Reconcile** with the usage the provider reports: move `reserved → spent` at the actual cost and release the rest.
   - Client disconnects: keep reading the provider stream on the server until it finishes, or charge the full reservation.
   - No usage reported or unknown outcome: mark `uncertain` and keep the full reservation charged until it's reviewed.
   - Retry: same `request_id`, so it can't be charged twice and can't create duplicate messages.
8. Save the assistant message with its `modelId` and `status`.

## Admin and operations
- Admin page (Jake): spend by user and model, total cost, error counts, the global stop toggle, provider toggles.
- Logs: request ID, user ID, model, tokens, cost, error code. **Never message content.**
- Backups: Supabase daily backups. Roll back a bad release with Vercel instant rollback.

## Security checklist
Keys only in server env. RLS plus server checks on every read and write. Exact domain match after normalization (lowercase, trim; reject unicode lookalikes). CSRF and auth on all mutation routes. Rate-limit OTP sends.

## Folder access (browser)
The student picks a folder with the browser's folder picker (File System Access API, Chrome/Edge on a computer) and
allows editing in the browser's prompt. The handle is remembered in IndexedDB; the browser may ask again next visit.
Chat requests send `folder: { name }`, and adapters pass the tools from `lib/folder/tools.ts` in each provider's
function-calling format. A round that ends in tool calls streams `tool_calls`; the browser runs them on the folder
(`lib/folder/browser-fs.ts`; changes need Apply unless "Don't ask for edits", deletes always ask; nothing extra is written
into the folder) and continues the same reply with `run: { replyId, steps }`. Every round is its own reserve → call → settle.
