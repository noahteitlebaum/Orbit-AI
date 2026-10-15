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
Walk history from newest to oldest and keep messages until we hit `min(model.contextWindow, budgetCap) - maxOutput - safetyMargin`. Always keep the system prompt and the newest user message. If older messages were dropped, set a flag so the UI can show "Older messages not included."

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

## Implemented phase-one update (October 13)
The older `src/` diagram above describes the original scaffold. Current code is under root `app/`, `lib/` and `config/`.
See [SMART_MEMORY_ANALYTICS.md](SMART_MEMORY_ANALYTICS.md) for the exact implementation and rollout.
Economic input targets are separate from provider windows (8k ordinary, 16k files/tools, controlled expansion capped at 24k estimated input); summaries and recent exchanges stay provider-neutral.
A saved conversation's provider field now identifies its sidebar/course home; model_id selects generation and may belong to another provider after an explicit model-picker choice.
USD actual provider costs live in `ledger.actual_usd_micros`; `actual_micros` retains legacy budget-charge semantics. Unknown outcomes have no known provider cost. Money units are integer millionths of currency units, not micro-cents.
New CAD trial budgets snapshot FX into USD credit counters and expire after their assigned trial. Paid subscriptions/renewals remain disabled.
