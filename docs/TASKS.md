# Task List — Orbit AI

Status: `[ ]` todo · `[~]` in progress · `[x]` done. Keep optional features off the critical path.

## Oct 3–4 — Foundation
- [ ] Repo, Next.js + TS + Tailwind scaffold, lint/typecheck/test scripts
- [ ] Supabase project; Vercel preview deploy live
- [ ] AGENTS.md, PRODUCT_SPEC, ARCHITECTURE, TASKS committed
- [ ] Screen outline: sign-in, chat list, chat with model picker, usage panel, admin
- [ ] Blocker list sent to Jake/Natan (API keys ×4, billing owner, currency, trial amount)

## Oct 5–6 — First provider end to end
- [ ] Email OTP sign-in. Server rejects anything that isn't exactly `uwo.ca`. Tests: allowed, other domain, lookalike, direct API bypass
- [ ] DB schema and RLS (conversations, messages, budgets, ledger, settings)
- [ ] Provider adapter interface and the first adapter (OpenAI or Anthropic), with streaming
- [ ] Core journey works with one provider: chat → reply → refresh → reopen
- [ ] Basic ledger: record tokens and cost for each request
- [ ] Smoke-test API access for all 4 providers

## Oct 7–9 — All four providers and context switching
- [ ] Remaining 3 adapters through the same interface
- [ ] Model picker. Switch models in a chat. Model label on every reply
- [ ] Context-transfer test: plant facts, cycle through all 4 models, check payloads and replies
- [ ] Context policy plus the "older messages not included" notice
- [ ] Demo recording, preview link and screenshots for Natan (Oct 7 and Oct 9)

## Oct 10–13 — Money and controls
- [ ] Atomic reserve → reconcile, including disconnects, retries and uncertain charges
- [ ] Usage UI (used/remaining) and budget pause message
- [ ] Trial and plan status (settings from Jake, due Oct 10)
- [ ] Per-user rate limit, global spending stop, provider disable switch
- [ ] Admin report: spend by user and model, total, errors
- [ ] Payment flow only if Jake finalizes it. Idempotent webhooks
- [ ] Phone layout and failure-state pass. Demo Oct 13

## Oct 14–16 — Launch-ready
- [ ] Run all acceptance checks (access, 4-provider context, spending, trial/payment, failures, usability/capacity, operations)
- [ ] Load test. Record the safe invitation batch size
- [ ] Rehearse deploy and rollback
- [ ] Handover: README (setup and deploy), model list, settings guide, how to pause, disable a provider and roll back, known limitations
- [ ] Demo Oct 16

## Oct 17–19
- [ ] Final review with the team, then launch, with monitored access and spending

## Blocked / waiting on others
- Jake: currency, initial budget, trial amount, launch mode (Oct 5). Subscription rules and policy text (Oct 10)
- Natan: tester count, survey destination, launch volume (Oct 10)
- Team: Oct 17–19 coverage (Oct 16)

## Smart context (Jake, Oct 15)
- [x] Ordinary ~8k input target, bounded expansion, up to six recent exchanges, incremental summaries, selected older history and opted-in memories.
- [x] Provider caching support and separate summary/cache-write cost accounting; lexical retrieval has zero embedding expense.
- [x] Mock-provider checks for context limits, continuity, memory preference and cost calculations.
- [ ] Run migration 0009 in the deployment database before deploying; confirm real-provider cache hit rates and expense totals with synthetic data.
