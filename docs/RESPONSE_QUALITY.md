# Response quality: first implementation

Purpose: remove observable quality failures while keeping the selected model, budget path and call count intact. This work is on local Jake, on top of the smart-memory/analytics commit. It is not deployed.

## Implemented changes

| Problem | Fix | Files |
|---|---|---|
| Generic base prompt without a student response contract | Shared guidance for answering directly, respecting requested detail/format, checking units and assumptions, honest uncertainty, useful explanations and preserving a requested writing draft | `config/quality.ts`, `lib/chat/context.ts` |
| Older assistant answers or summaries treated as reliable facts | Latest user corrections take precedence; summaries are explicitly lossy references; previous assistant statements must be checked | `config/quality.ts`, `lib/chat/context.ts` |
| Old small attachments filling the source budget before relevant material | Explicit file/page selection, current attachments and relevant passages precede old generic attachments | `lib/chat/material.ts` |
| "page 12 of lecture 3" matching Lecture12.pdf | Match numbered file identifiers to neighboring filename words, rather than any number anywhere in the question | `lib/chat/material.ts` |
| Requested scanned page beyond the default page selection omitted | Explicit visual-page selection uses the named file and requested page; unreadable/unsupported pages are disclosed | `lib/chat/material.ts` |
| Short follow-up losing its referenced course topic | Follow-up search uses the previous user question and its file/page reference when the current question names no new file | `lib/chat/material.ts` |
| Missing page silently replaced by the document opening | Requested-page misses are disclosed and do not fall back to another page | `lib/chat/material.ts` |
| Provider output cut off but labelled complete | Normalize completion reasons across all four providers; token limits become partial replies, missing terminal signals become explicit stream errors | `lib/providers/{types,openai,anthropic,google,xai}.ts`, `app/api/chat/route.ts` |
| Incomplete response saving memory/quiz markers or launching an unfinished tool | Only completed, nonblocked replies update memory/quiz state; cut-off tool rounds do not execute | `app/api/chat/route.ts` |
| Truncated summary overwriting the old one | Reject incomplete/blocked helper summaries after settling reported usage; retain the prior checkpoint | `lib/chat/summary.ts` |
| User unable to tell why a streamed response is incomplete | Show output-limit/partial state and offer explicit Continue for the latest token-limited reply; no automatic extra paid call | `app/chat/chat-app.tsx` |

Additional calls per ordinary response: **zero**. The response contract adds prompt tokens; cost should be measured in live evaluation. Completion metadata and quality version are recorded in the existing ledger JSON metadata; no new migration is required by this increment. Partial status survives refresh, but the detailed finish reason/Continue button currently depends on the streamed frontend state; reloaded partial replies show a generic incomplete label.

## How to measure actual quality

Use `benchmarks/response-quality-cases.json`, containing 20 synthetic cases for quantitative reasoning, explanations, instruction following, writing, source use, corrections, model switching, tool failures and completion handling. These are evaluation inputs and expected-answer rubrics, not claims that live models have passed.

For a clean comparison:

1. Use the same synthetic account, selected model, question, source material, output cap and tool availability for baseline and candidate. Run each provider separately; then run the switching cases. No real student content.
2. For static source/continuity cases, preserve the exact provided context. For retrieval cases, attach the specified synthetic files and check the actual source payload as well as the final answer.
3. Record the selected provider/model, prompt version, finish status, score, first-token/end-to-end latency, actual input/output/cache usage, and total API cost including summary/embedding/tool rounds.
4. Score each rubric item 0 or 1. A human should review factual correctness and source support; a valid citation identifier alone is not evidence that a claim is supported. Review baseline and candidate outputs without showing which prompt produced them.
5. Repeat cases at least three times for each provider. Report accuracy by task category and the frequency of critical failures, alongside cost and p95 latency. Do not compare one lucky answer from each system.
6. Proposed launch gate: no critical unit/correction/source-identity failures, no silent incomplete responses, no cross-user leakage, and a meaningful improvement in reviewed task scores without an unacceptable latency/cost increase. Agree thresholds after measuring the baseline.

Run local regressions with `npm test`, `npm run typecheck`, `npm run lint` and `npm run build`. Adapter, route and source-selection tests verify the plumbing, not live model intelligence. Live evaluations were not run here because no provider credentials/synthetic testing environment were supplied.

## Next priorities after measurement

- Improve retrieval recall and file handling where the corpus exposes misses. Current selection is keyword based; synonyms and distant semantic matches can still fail. Profile/follow-up preferences are heuristics, not an LLM intent classifier.
- Tune per-model reasoning/output allocations using measured accuracy and costs. Increasing a reasoning setting everywhere can burn credits or finish before any visible text. No model/effort setting was silently changed in this increment.
- Improve summaries against a planted-fact/correction benchmark. Larger context is useful only when the included information helps the current task.
- Add optional review for difficult, high-value tasks only if evaluation demonstrates a benefit. Avoid a second-model "critic" on every request by default.
- Compare the actual product experience with the native apps using identical student tasks. Same underlying API model does not establish native-app feature parity.

## Limits

These changes reduce specific observed failure modes and provide an evaluation contract. They do not establish that hallucinations are eliminated, citations are entailed, diagrams are understood correctly, or Orbit is equivalent to each provider's native app. Large combined text/visual payloads may still exceed the existing economic context ceiling; the route discloses/rejects oversized requests rather than pretending every file was read. Staging phone/desktop usability checks remain required.

Official completion semantics checked October 13, 2026 UTC:
- OpenAI: https://developers.openai.com/api/docs/guides/reasoning
- Claude: https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons
- Gemini: https://ai.google.dev/api/generate-content
- Grok: https://docs.x.ai/developers/model-capabilities/text/streaming

## Running the live evaluation (added Oct 13, Noah's branch)

```
npm run eval:quality                                   # all apps with keys in .env.local, 3 repeats
# PowerShell examples:
$env:EVAL_PROVIDERS="anthropic"; $env:EVAL_REPEAT="1"; npm run eval:quality
$env:EVAL_MODELS="openai-luna,google-default"; npm run eval:quality
```

16 of the 20 cases run directly against the models with the exact system prompt the chat route builds; `page-identity` and `scanned-page` need real uploads in the app, and `output-limit`/`transport-end` are covered by the adapter/route unit tests. 12 cases have automated objective checks (`lib/eval/quality.ts`, unit-tested with real answers); the rest are marked `human` in the blind review CSV. Results go to `benchmarks/results/` (git-ignored).

**First live smoke run — Claude Sonnet 5.5, 1 repeat, Oct 13 2026:** 32 calls, no errors or incomplete replies. Automated checks: baseline 12/12, candidate 12/12. Cost $0.076 vs $0.084 (+11% from the longer prompt); p95 end-to-end 10.6 s vs 9.1 s. Human read of the 4 judgment cases: candidate clearly better on `missing-information` (asks for mass/height first, 40% shorter instead of a tutorial); equal on `genetics-explanation` (both mention linkage), `source-faithfulness` (identical, cited [S1]) and `follow-up-material`. One repeat on one provider is a smoke test, not a quality claim; run 3 repeats on all four apps before deciding.
