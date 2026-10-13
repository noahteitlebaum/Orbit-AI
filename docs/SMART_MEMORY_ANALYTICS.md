# Phase 1: context efficiency, usage accounting and analytics

Audit baseline: `Jake`, commit `eeed0e3b1b28316dc5a087db7db55a75bd995248` (October 13, 2026 UTC).
Requested implementation stays on Jake. Main and the live database are not changed by this commit.

## What the audit found

| Area | Baseline | Change in this branch |
|---|---|---|
| Context (`lib/chat/context.ts`, `app/api/chat/route.ts`) | Recent history up to a 40k–60k configured cap; full history saved; disclosed trimming | Separate 8k economic input target, 16k for tools/files, expansion for 5 recent exchanges, hard estimated 24k input ceiling. Whole exchanges retained. System, tools, memory, retrieval and visual estimates included. |
| Summaries (`lib/chat/summary.ts`) | Incremental summary, cheapest model in selected provider, reserved/settled; up to 4 large calls before a reply | One 16k-character transcript batch per request; operation tagged separately; optimistic summary checkpoint avoids overwriting another request; incomplete coverage disclosed. |
| Personal memory (`lib/profile/personal.ts`) | Opt-in, default off, view/add/delete; all 100 memories inserted each time | Bounded lexical selection (600 estimated tokens, up to 12 notes); optional semantic selection; full list still used for deduplication. |
| Model switching (`components/model-menu.tsx`, chat and conversation routes) | Only within each provider. Wrong-provider saved conversations rejected | Picker explicitly offers all enabled providers. Generation uses the selected provider; chat retains its original sidebar/course home and saved history. Sidebar app tabs still open separate lists. No automatic provider substitution. |
| Reservations (`lib/billing/budget.ts`, migration 0001) | Atomic USD reserve/reconcile; uncertain reservations counted as `actual_micros` | V2 RPC preserves charge counters and separately records known provider cost, operation, conversation, prices and FX. Unknown cost remains null. |
| OpenAI adapter | Reasoning already included in output; cache reads recorded but full-priced | Separate cache writes and reads; scoped cache key; configured standard read/write rates. |
| Claude adapter | Cache reads and writes combined; full input price | Disjoint buckets; 5-minute automatic caching on chat requests; write premium covered by reserve. Reasoning breakdown marked unavailable, not claimed to be measured as zero. |
| Gemini adapter | Correct visible output + thought sum; reported implicit cache counts | Existing semantics retained; cache reads priced separately. No paid explicit cache storage service added. |
| Grok adapter | Always completion + reasoning, regardless of aggregate | Aggregate-aware normalization handles schemas where reasoning is included and those where it is separate. Legacy no-aggregate responses retain separate-output assumption, requiring invoice validation. Cache reads and scoped conversation header added. |
| Financial/product reporting | Per-user budget and recent answer estimates; no staff dashboard or product event store | Staff dashboard, first-party metadata events, revenue-event schema, cohort reporting and service-only aggregates. No third-party analytics content transmission. |
| Trials/payment | USD default credit; no duration enforcement or payment system | New budgets use configured CAD trial allowance, snapshot FX and 7/30-day expiry. Existing tester balances retained. Payment processing remains disabled; receipt ingestion awaits a future payment integration. |
| Retrieval | Keyword retrieval for uploaded course files; no semantic chat retrieval | Optional lazy pgvector index of older messages, the current summary and saved memories. RLS, source hashes, delete cascades and memory-disable purge. |

## Lean architecture and exact files

Use the existing Supabase Postgres database, existing fetch/SSE adapters and Next.js routes. No new production service or agent layer.

| Responsibility | Files/schema |
|---|---|
| Economic policy | `config/context.ts`, `lib/chat/context.ts`, `app/api/chat/route.ts` |
| Incremental summary | `lib/chat/summary.ts`, `conversations.summary`, `summary_upto` |
| Selective memory | `lib/profile/personal.ts`, `lib/chat/retrieval.ts`, `components/settings-dialog.tsx` |
| Semantic index and permissions | `supabase/migrations/0010_semantic_memory.sql`: `context_embeddings`, `retrieve_context`, purge trigger |
| Price/usage normalization | `config/models.ts`, `lib/providers/{types,openai,anthropic,google,xai,usage}.ts` |
| Cost and allowance records | `config/economics.ts`, `lib/billing/budget.ts`, `0009_usage_analytics.sql`: ledger extensions, enrollments, receipts, v2 reserve/settle |
| Events | `lib/analytics/events.ts`, chat/file/image routes, verified-signup trigger in 0009 |
| Staff reporting | `lib/analytics/{admin,report}.ts`, `app/admin/analytics/page.tsx`, `app/api/admin/analytics/route.ts`, `0011_admin_report.sql` |
| Explicit provider switching | `components/model-menu.tsx`, `app/chat/chat-app.tsx`, `app/api/chat/route.ts`, `app/api/conversations/[id]/route.ts` |
| Verification | `test/financial-database.test.ts`, `lib/chat/efficiency.test.ts`, adapter/route tests, analytics privacy tests, `benchmarks/context.test.ts` |

The two new development dependencies (PGlite and its pgvector extension) run actual PostgreSQL SQL/RLS tests without connecting to student data. They do not run in the production request path.

## Priorities, owners and estimated remaining effort

Estimates are engineering effort, not promised calendar dates. Small launch team: Noah owns technical rollout, Jake owns economics and experiment evaluation, Natan owns synthetic tester onboarding and qualitative feedback.

| Priority | Work | State | Acceptance gate | Remaining effort |
|---|---|---|---|---|
| P0 | Correct usage, cache pricing, cost vs charge distinction and operation tags | Implemented | Provider fixture tests; known/unknown cost SQL checks; reconcile a small synthetic sample with each provider invoice | 0.5–1 day validation |
| P0 | Economic context, summaries and explicit provider switches | Implemented | Same-chat follow-up works across providers; full source history saved; incomplete coverage notice; latest request preserved | 0.5–1 day live quality/phone checks |
| P0 | CAD trial cap/FX/expiry, staff financial report and privacy-safe core events | Implemented | Migration passes, admin allowlist denies others, trial pauses correctly, receipts absent remain zero | 0.5 day staging rollout |
| P1 | Semantic retrieval behind opt-in and feature flag | Implemented, off by default | RLS and deletion tests; synthetic factual recall and latency comparison before enabling | 1–2 days quality evaluation |
| P1 | Compare 7-day vs 30-day trial cohorts | Schema/report ready | Assign arms once before first credit; same credit cap; consistent pricing and exposure; report only mature cohorts | 0.5 day setup plus observation time |
| P1 | Integrate verified conversion/refund/cancellation receipts | Table/report ready; integration deferred | Idempotent payment webhook; net revenue excludes tax; refunds and fees recorded; reset/renewal rules approved | 1–2 days after payment provider/rules chosen |
| P2 | PostHog funnels, broader retrieval, automated quality scoring | Deferred | Prove first-party metrics insufficient; explicit event allowlist, no session replay/private content | 1–3 days if justified |
| P2 | Background backfill, invoice imports, per-model exact tokenizers/count APIs, stronger concurrency limits | Deferred | Load evidence and invoice mismatch justify complexity; prevent calls outliving server request | 2–4 days |

PostHog is deliberately optional. Supabase already covers the financial source of truth and the launch funnel. If added, send only a separately approved subset of IDs, categorical events and numeric counts. Disable autocapture/session recording on chat screens.

## Rollout and configuration

1. Review this branch and obtain the repository-required second-model review before merging cost/context/auth changes. No merge or production deployment is performed here.
2. Apply 0009, 0010 and 0011 in order to a staging Supabase project. Existing migrations must already be applied. Deploy matching code only after 0009 exists: v2 billing fails closed if the schema is missing, with no fallback to the old RPC.
3. Set `settings.usd_cad_rate` to a **JSON number** representing CAD per USD based on the team's chosen conversion convention. There is intentionally no guessed default. New accounts cannot make paid calls until it is set. The period budget snapshots it so balance/charges do not drift with later setting changes. Actual invoice FX may differ and should be reconciled separately.
4. New trial defaults: C$2.50 credits, 7 days, proposed C$30 price; settings support 30-day trials. Monthly C$20 is a proposal setting, not an enabled paid subscription. Allowances convert once into USD counters with floor rounding. Provider costs are USD micros, CAD reporting uses the saved conversion.
5. Existing USD tester budgets are preserved and visibly labelled USD if no CAD/FX metadata exists. Do not reinterpret them as CAD. Explicitly provision enrollment/FX/expiry metadata for testers included in a trial experiment. Do not reset their counters blindly.
6. Set `ANALYTICS_ADMIN_EMAILS` to the team's exact verified @uwo.ca addresses in server environment variables. Empty denies everybody. Open `/admin/analytics` for the 30-day view or `/api/admin/analytics?days=30` for JSON (1–90 days). These routes independently check eligibility and the staff allowlist; the aggregate SQL RPC is service-role-only.
7. Keep `SMART_MEMORY_ENABLED=off` initially. After quality and privacy checks, enable it with the OpenAI key. Students must separately turn memory on. The settings screen explains that semantic search sends earlier excerpts/saved notes to OpenAI. Off stops retrieval/indexing and purges vectors; manually saved notes and ordinary chat history remain visible. Conversation deletion cascades linked memories/vectors; account deletion cascades all user rows.
8. Keep payments disabled. A future **verified, idempotent payment integration** must populate `revenue_events` and renew subscriber budgets/period FX atomically. Never manually fabricate conversion data to populate the dashboard. To test 30-day trials, preassign an enrollment with that duration, expiry, cohort label, price and credit before its first budget creation; allocation is not randomized by this patch.
9. Run the checks below and a small staged synthetic live session. The live provider key/model availability, correct invoice totals, Supabase grants and frontend behavior still require staging verification.

## Metric definitions and limits

- API costs are calculated from reported token usage and versioned standard rates, or a documented flat search/image rate. These are recorded provider-cost estimates pending invoice validation, not audited invoices. Unknown outcomes remain null and their full reservation charges appear separately. Legacy rows do not get fabricated exact costs or FX.
- Cache read ratio = read input tokens / total input tokens. Write tokens are a separate, disjoint input bucket. Normalized output includes reasoning exactly once. Claude does not expose an exact separate reasoning count in the existing stream and is labelled accordingly.
- Cost per 100 calls counts chat model rounds. A tool continuation is another call. Summary and embedding costs are separate and included in overall user/provider spend. Database/vector-search compute is hosting cost, not a per-query API charge; no fake zero-dollar ledger entries are created for SQL queries.
- Financial panel uses actual receipt net revenue and recorded API costs. Contribution after API and payment fees is shown only when receipts exist and FX, legacy, unknown-cost and held-reservation gaps are absent. Hosting, support and acquisition costs require a separate financial model.
- DAU/WAU/MAU: distinct users sending a live message in rolling 1/7/30-day windows, using UTC server timestamps. Model calls/feature use are separate from these users. Message retries do not create new message-sent events. Events have dedupe keys where a stable message/file/request ID exists.
- Messages per active conversation counts messages in the report window, not lifetime conversation length. Mean cost is per user who generated ledger rows, not per entire enrolled population. The top-user table is capped at 200; aggregates are computed in SQL over the full selected scope.
- Conversion and cancellation depend on receipt ingestion. Trial-cohort grouping preserves duration and price. Week-two retention uses days 7–14 after activation and includes only users with 14 days of observation. Observational comparisons still need matched follow-up and selection controls.
- Retrieval inclusion is observable; retrieval relevance/answer accuracy is not inferred from an event count. No private chat text, email, file names, web queries, embeddings or summaries enter analytics events or staff reports.

## Checks and benchmark

```
npm ci
npm run lint
npm run typecheck       # generates Next route types first, including on a clean clone
npm test               # mock adapters, actual local PostgreSQL migrations/RLS; no live API charges
npm run benchmark:context
npm run build
```

The synthetic fixture covers university study tasks in genetics, physics, statistics, physiology and biochemistry. Same 100 question/answer histories are run through the old 60k policy and the new economic policy. Fixed assumptions: 1,200 system tokens, a 500-token synthetic summary, 700 output tokens per interaction, the configured Sol price and Luna helper price, no cache hits. It accounts for estimated summary calls and tests preservation of recent exchanges. It does **not** execute real summaries, embeddings or responses.

| Estimated result | Old policy | Economic policy |
|---|---:|---:|
| Total chat input tokens | 4,174,511 | 677,279 |
| Cost / 100 interactions (USD) | 9.0490 | 2.0945 |
| Summary calls | Baseline excluded in this comparison | 94, estimated US$0.0400 included |

Estimated savings: 76.9% in this constructed workload. The old policy already uses summaries in longer chats; omitting their costs makes the baseline conservative. These figures are not usage forecasts, real tokenizer counts or evidence that response quality is unchanged. Semantic embedding overhead/cache savings are excluded from both arms.

Before enabling semantic retrieval or using savings in pricing:

- Use synthetic accounts with identical conversations and planted facts/numbers/constraints, including a late reference to 0.15 M saline, corrections, multiple unrelated topics, long files and model switches.
- Compare baseline, economic+summary, and economic+summary+retrieval under the same models, temperature where supported, output cap, workload and trial credit. Record all operations, actual usage/cost, time to first answer and end-to-end latency. Repeat across all four providers and both successful/failed calls.
- Score factual recall, correction precedence, task accuracy, citation validity and retrieval relevance from expected answers. Have a human review disagreements. Include latest-turn facts, older facts omitted from a summary, irrelevant memories and prompt injection in old excerpts.
- Proposed release gates (hypotheses): lower total measured API cost; at least 95% planted-fact recall; no more than a 2 percentage point decline in task accuracy; no cross-user retrieval; no deleted-memory recall; no unexpected provider change. Agree acceptable p95 latency with Noah after measuring the baseline.
- Validate 375px and desktop UI: picker scrolls, selected provider is named, history remains after refresh, memory disclosure is visible, oversize context/error/low-balance states are understandable, staff page is unreadable for a normal student.

## Risks that remain

- The token estimator and multimodal estimates are not strict mathematical upper bounds. Reserves include cache-write premiums and a 15% margin, but actual usage can exceed a reservation. Monitor overshoot, reconcile invoices, and add exact count APIs/tokenizers where evidence warrants it. Do not promise an absolute spend ceiling from a heuristic.
- Summarization loses information and adds latency. A newly long legacy chat may have a backlog larger than one batch; the incomplete coverage notice is intentional. The 24k cap can retain fewer than 5 exchanges if very large messages/files consume the budget; oversized newest requests are rejected rather than silently shortened.
- Semantic vectors use a bounded 1,800-character source excerpt and lazy batches of 8 sources. Older unindexed facts and facts outside that excerpt may be missed. Retrieval stays within this chat plus the student's opted-in saved memories; automatic retrieval from arbitrary other chats is deferred. Full source messages are saved, with hash checks preventing stale text retrieval.
- Default helper choice remains the cheapest enabled model in the **selected provider**, so summary economics vary across providers. Switching does not transfer hidden reasoning/caches; it transfers visible messages, summaries, memories and current material. Gemini signatures stay inside a tool run, so switching during a pending tool run must stay disabled in the UI.
- Provider cache hits are not guaranteed. Changed summaries/retrieval/material may reduce reusable prefixes. Explicit Gemini cache storage is deferred to avoid untracked storage costs.
- Grok's legacy no-aggregate usage convention must be validated against a sample invoice. Known aggregate schemas prevent double-counting. Flat image/search charges also need reconciliation if suppliers change rates or bill refusals.
- Trials start on first live budget provisioning; signup is a separate event. Editing settings does not resize an existing budget/experiment arm. Paid renewal, refunds, charge disputes, allowance reset/carryover and recurring subscriber lifecycle are not enabled by this work.
- Streaming routes can still lose a server process or hit platform duration limits. A leftover reservation is conservative credit protection, not known provider spending; review those rows operationally. Concurrent requests can also create noisy summaries (optimistic updates protect saved checkpoints, but duplicate helper work can still be billed).
- Admin access uses an exact server allowlist, not user-editable metadata. Database/security behavior is locally tested with Supabase-shaped schemas; staging still needs real Supabase roles, extension placement and default grants checked.

## Official sources checked

Standard API pricing and usage semantics checked October 13, 2026 UTC. Recheck on rollout and before the January 2027 Gemini Flash price change. Preserve selected model IDs; no unsupported model substitution.

- OpenAI: https://developers.openai.com/api/docs/pricing , https://developers.openai.com/api/docs/guides/prompt-caching , https://developers.openai.com/api/docs/guides/reasoning , https://developers.openai.com/api/docs/guides/embeddings
- Claude: https://platform.claude.com/docs/en/about-claude/pricing , https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Gemini: https://ai.google.dev/api/generate-content , https://ai.google.dev/gemini-api/docs/pricing
- Grok: https://docs.x.ai/developers/pricing , https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing , https://docs.x.ai/developers/model-capabilities/text/reasoning
