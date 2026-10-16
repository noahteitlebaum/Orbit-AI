# Orbit mode — bounded four-provider routing preview

Jake authorized Orbit mode on October 15, including four independent votes per prompt, one lead answer, and at most one specialist when collaboration is requested. This supersedes the older launch exclusion for smart model routing. Natan's main-review fixes remain a separate workstream.

## Product behavior

Orbit appears beside ChatGPT, Claude, Gemini and Grok on desktop and phone. It has separate saved conversations and Orbit's own visual interface. Each turn displays the selected lead and ballots, including a tied-vote disclosure and optional specialist. The original four single-provider experiences remain available.

This first preview supports **text conversations**. Files, course attachments, web browsing, voice and execution tools are intentionally unavailable in its composer. Normal chats retain those workflows. An Orbit selection sends the question and a bounded recent context to all four providers; students see this disclosure before sending. Selecting an individual AI does not automatically convert an Orbit conversation into a normal chat.

1. Authenticate using the existing verified-domain/waitlist guard and RLS client.
2. Require every configured provider to be enabled and present. A missing key in live mode stops the turn; it does not become a demo ballot.
3. Acquire a service-role-only, five-minute per-student lease. Concurrent Orbit turns return a busy response. Expired leases recover from terminated processes.
4. Save the latest question, load the newest bounded history, and select economic context. Latest questions are explicitly appended rather than discovered in an ascending capped read.
5. Call four configured voting models independently and concurrently. Each nominates another provider and optionally requests a distinct specialist. Strict server parsing rejects self-votes, invalid providers, malformed ballots and incomplete streams. No paid retry/repair call is added.
6. Use plurality for the lead. Ties use deterministic SHA-256 ordering seeded by the saved message ID, with no extra model call. This is an administrative tie-break, not evidence that one tied model is better.
7. At least three collaboration requests add one specialist. Specialist nominations determine that provider among non-lead providers, using the same stable ordering for ties. Its bounded contribution is untrusted analysis for the lead, not evidence or instructions.
8. The lead streams one coherent answer. There is no recursive debate or unlimited agent loop. All four ballots must succeed, and a failed specialist stops the turn rather than silently presenting a solo answer.
9. Persist the real author model and structured routing metadata with the assistant message. Only complete final answers may save new memories through the existing consent-protected helper. Private specialist prose is ephemeral and is not copied into analytics.

## Context and memory

`config/orbit.ts` controls models and limits. Generation is capped at 8,000 estimated input tokens per phase, with separate space for system instructions, opted-in preferences/memories, summary and specialist output. A too-large phase fails closed. Current token estimation is heuristic, not a strict supplier-cost guarantee.

The active window starts from the latest 100 completed messages. Older context may be omitted or partially summarized, and the UI explicitly says so. The existing incremental summarizer can fold dropped rows when the fetched history covers the conversation; it does not pretend a legacy backlog beyond that window is complete. Reopened Orbit chats show the latest 100 saved messages. Full historical browsing/backfill is future work. Full conversation records remain stored unless deleted. Semantic retrieval is not added to Orbit in this preview.

Durable profile preferences and relevant opted-in saved memories are available to the lead. Routing voters and the specialist receive selected recent conversation text. An existing summary is sent to the final lead, not represented as full history. None of this transfers provider-private reasoning or caches.

## Cost and failure contract

Every dispatched voter, specialist and lead call uses its own atomic reserve → call → settle path, with operations `orbit_vote`, `orbit_specialist`, `orbit_answer`. Summary charges retain `summary`. Pricing snapshots use the actual configured model. Known usage settles to the calculated cost; ambiguous dispatched outcomes remain uncertain; an explicit non-started client rejection can release its reservation. Output without a normal terminal completion is rejected and never becomes a valid ballot or specialist contribution.

Solo: four voting calls plus one answer. Collaboration: four voting calls, one specialist, one answer. A long chat may also incur a summary call. Default helper reservation estimates (votes plus specialist, excluding summaries and the lead) are capped at US$0.15 per turn. The cap is checked before each helper stage; prices, output caps, input limits and the feature flag are config. Actual costs may exceed estimates; all reported actual usage is still settled.

There is **no all-or-nothing prepaid bundle**. If a later step cannot reserve budget, earlier completed calls remain charged. The UI explains this. Avoid promising that a failed turn is free. The existing usage panel reflects aggregate remaining credit, including all phases; the staff ledger contains the separate operation labels. Existing per-model “typical chat answer” estimates do not yet describe total Orbit-turn expense.

Stop aborts voting/specialist work via the request signal. Once the final answer has been dispatched, the server keeps reading to settle usage and save the result even if the browser disconnects. A student may need to reopen the chat to see that result. No provider substitution occurs on failure. Incomplete final answers remain partial and do not save AI memories. A process killed by hosting can leave a conservative reserved balance; existing operational reconciliation remains necessary.

## Rollout

- Apply migrations 0001–0013 as required by current main, then **0014_orbit_mode.sql**. It adds a conversation flag, message routing metadata and the service-role lease functions. No provider enum changes or balance resets.
- The conversation list now separates Orbit from ordinary OpenAI chats. Deploy the migration before code that queries the new column. Main's ordinary chat endpoint rejects Orbit conversations so that it cannot bypass voting.
- `ORBIT_MODE_ENABLED=on` explicitly enables POST. Leave it off until staging checks pass. The tab remains visible as a preview with a clear disabled response.
- With `LIVE_MODELS` off, enabled Orbit simulates ballots and a demo answer without provider calls. Simulated votes are labelled and do not claim to classify the prompt.
- With `LIVE_MODELS=on`, all four API keys are required and every phase rechecks the provider's disable switch. No key, prompt or response text is logged by Orbit.
- Verify grants, lease recovery, budget exhaustion between phases, phone width and real provider model/finish semantics with synthetic accounts before rollout. No live model or production database deployment is part of this implementation.
- Natan's existing logging/deletion/voice fixes remain necessary for the wider app. Orbit text deletion reuses the conversation DELETE route; its new metadata is removed with messages, and Orbit does not create storage objects.

## Evaluation before claiming a moat

Voting can be wrong, providers can share biases, and the no-self-vote constraint can even exclude the strongest choice for a voter. Candidate descriptions are unverified routing hints, not benchmark-based expertise labels. Cheapest configured voters are used to bound overhead; the lead/specialist use configured answer candidates. No claim of optimal routing or superior accuracy has been validated.

Use identical synthetic tasks and blind scoring to compare: each individual default model, Orbit solo routing, and Orbit collaboration. Record task quality, corrections preserved, error rate, total per-task cost (all phases), time to first answer and p95 end-to-end latency. Include simple tasks where routing overhead is hard to justify, mixed-discipline work, writing, mathematics and adversarial attempts to force self-votes or collaboration. Measure the incremental value of the specialist. Establish release thresholds before observing results.

Defensibility would come from measured routing performance, a useful study workflow, and a permission-respecting feedback/evaluation loop. Four votes alone are reproducible by competitors. Do not put private conversations in analytics to build evaluation data; use synthetic tasks or separately consented contributions with a clear policy.

## Validation

Routine tests use mocked providers and synthetic users. Routing tests cover no-self-votes, quorum, plurality, ties and collaboration limits. Paid-call tests cover reservations, disabled providers, terminal signals and ambiguous failures. Endpoint tests cover access, flag/key gates, ownership, leases, demo labelling, four-vote failure, solo output and bounded collaboration. Local database tests verify migration compatibility, lease isolation and grants. Production build and browser layout checks are separate from evidence of live model quality.

## Implementation checks (October 15)

- Full mocked/local-database suite: 337 tests passed across 45 files.
- Lint, generated route types and TypeScript passed.
- Production webpack build passed (`npm run build -- --webpack`); default Turbopack not checked in this linked-dependency worktree.
- Empty-state layout inspected on desktop and at 375 × 812; this was a temporary unauthenticated layout harness, not a signed-in end-to-end test. Harness removed before production build.
- Repository-required independent review completed; provider recheck and shared helper estimation findings fixed and covered by regression tests. Reviewer found no remaining blockers in the updated code.
- Refreshed main remains b1e3659, the base of this branch. Live provider quality, deployed migration/grants and real billing still require staging verification. No production merge, migration or paid API call was performed.
