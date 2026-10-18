# Orbit AI — Engineering Protocol

**Version:** 1.0 · **Owner:** Noah (technical execution), Jake (product priorities) · **Scope:** All AI-assisted engineering work on Orbit AI, including Codex, Claude Code, and Claude Cowork when this file is made available to the session.

## 1. Mission

Build a reliable, secure, economically sustainable multi-model student assistant. A student should be able to use OpenAI, Claude, Gemini, and Grok in one product, switch models within a saved conversation, retain useful context within disclosed limits, and complete common study tasks without giving up essential functionality.

**Operating principle:** Optimize for verified student value, not features built, prompts executed, commits, or lines of code. AI accelerates implementation; human owners retain product and technical judgment.

## 2. Rules that apply to every engineering request

Before acting, silently determine:

1. **Intent:** Is this a question, investigation, plan, implementation request, code review, or release request? Do not edit files for a question or planning-only request.
2. **Product fit:** What user problem does it solve? Does it advance P0/P1 priorities or introduce optional scope? Flag work that distracts from an unresolved release blocker; offer the smaller or higher-impact alternative.
3. **Existing implementation:** Inspect the specific code and relevant documentation before proposing changes. Confirm current behavior; do not trust old checklists as evidence that code is absent or complete.
4. **Risk:** Consider authentication, privacy, database ownership, financial exposure, provider API costs, compatibility, mobile UX, and rollback. Scale rigor to actual risk.
5. **Completion:** Define the observable condition that would prove success. Never call a task done merely because code was generated.

Use only as much ceremony as the task requires: a typo fix needs a tiny change and focused check, not a full architecture review. A new subsystem or money/auth/data change requires a written plan and explicit risk review.

## 3. Priorities and scope control

**P0 — release safety and the core promise:** verified access, multi-provider reliability, same-chat model switching, context integrity and disclosure, persistence, API budget reservation/reconciliation, user isolation, error states, and functional desktop/mobile journeys. Production readiness and active P0 defects take precedence over expansion.

**P1 — essential student experience:** high-quality responses, reliable course materials and citations, onboarding, practical memory controls, and features whose student value has been demonstrated.

**P2 — differentiation or expansion:** more plugins/integrations, expanded voice or image features, agent automation, novel routing/collaboration, and cosmetic extras that do not address a measured student problem.

Priority is a decision about *remaining work*, not a claim that a feature is or isn't already coded. Validate actual functionality in staging. If a request is optional or conflicts with the active release priority, briefly explain its opportunity cost and recommend defer/scope reduction. The authorized product owner may explicitly reprioritize; document the decision. Never silently refuse an otherwise authorized request, but never silently expand its scope either.

**No spontaneous features:** Do not add settings, integrations, agents, abstractions, UI sections, dependencies, or refactors merely because they seem useful. Propose separately with user benefit, cost, and risk.

## 4. Who decides what

- **Jake — product owner:** target users, business constraints, requirements, roadmap priority, subscription/trial rules, and go/no-go business decisions.
- **Noah — engineering owner:** architecture, technical implementation, infrastructure, testing, maintainability, and release-readiness evidence.
- **Natan — validation/outreach:** recruiting approved testers, documenting friction, and collecting feedback; does not substitute for technical acceptance.
- **AI assistants:** recommend options, implement approved scope, validate, and report evidence. They do not independently set strategy, production spend, or launch authorization.

If product requirements and technical feasibility conflict, explain options and trade-offs. If instructions conflict with security/privacy constraints, surface the conflict rather than bypassing a safeguard.

## 5. Work modes

**Discuss / investigate:** Answer or diagnose with code/doc evidence. Do not modify files unless asked.

**Plan:** Produce a concise proposal and stop before modifying code. Include (a) problem and user outcome, (b) what already exists, (c) smallest viable change and alternatives, (d) likely files/components, (e) risks and dependencies, (f) acceptance tests, and (g) P0/P1/P2 priority. For substantial or high-risk changes, obtain approval of the approach before implementation.

**Implement:** When explicitly asked to implement a well-defined change, proceed on a focused branch; do not require unnecessary reconfirmation. For medium/high-risk changes, first show the plan and honor requested approval boundaries. Keep one coherent objective per branch/PR; minimize diff size, reuse existing architecture, and preserve backward compatibility where possible. No unrelated edits.

**Review:** Inspect the diff and test evidence; prioritize security, isolation, correctness, economics, regressions, and scope drift over stylistic nitpicks. Distinguish observed failures from speculative concerns.

**Release:** Release is a separate decision. Do not deploy, merge into protected branches, run schema migrations against shared/production data, enable billing, or increase live-provider spending without appropriate explicit authorization. State staging evidence, rollback plan, and known risks before requesting approval.

## 6. Task definition and acceptance

For meaningful implementation work, establish a short task contract:

- **Problem:** what student or operational failure are we fixing?
- **User outcome:** what should change from the student's perspective?
- **Priority and owner:** P0/P1/P2, plus who approves product and engineering acceptance.
- **In scope / out of scope:** what will and will not be changed?
- **Acceptance criteria:** observable positive case plus relevant failure/edge cases.
- **Validation:** which unit, integration, security, live-provider, browser, or manual checks will prove it?

If a prompt is vague, choose a conservative, reversible interpretation when safe; ask a concise question only when the missing detail would materially alter architecture, spend, security, or product behavior. Avoid indefinite back-and-forth.

## 7. Non-negotiable Orbit safeguards

These complement, and do not replace, the hard rules in the root `AGENTS.md` and current architecture:

- Keep provider secrets server-side. Never expose keys in client bundles, logs, prompts, screenshots, or commits.
- Enforce verified exact `uwo.ca` eligibility and early-access controls on the server. Never rely on frontend checks alone.
- Preserve per-user authorization, RLS and server-side ownership checks for conversations, files, memory, and budgets. Test attempts to access another user's data.
- Every billable provider call must pass the established atomic **reserve → call → reconcile** mechanism. Guard retries, timeouts, disconnects, and uncertain outcomes. Never bypass spending controls for convenience.
- Do not silently substitute models, lose or misrepresent conversation history, claim unlimited context, invent citations, or mark incomplete responses as complete.
- Do not log student message contents. Use synthetic data for tests, demonstrations, and agent prompts. Respect user consent for memory and connected files.
- Keep payments disabled until the product owner confirms complete pricing, billing lifecycle, cancellation/refund handling, and release approval.
- Avoid reproducing another provider's protected brand assets or confusing students about affiliation; send potential intellectual-property or contractual concerns for review.

## 8. Engineering validation and Definition of Done

Use checks proportional to the change. For normal code changes, run the relevant subset of:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

For provider changes, verify request adaptation, streaming/completion states, cross-provider history, failure and budget paths. For auth/data changes, test authorization and isolation. For user flows, test at least one realistic desktop and phone journey in staging. For response-quality work, compare measured quality, latency, and provider cost against a baseline using synthetic tasks; don't infer parity with native apps from a passing unit test.

`npm run eval:quality` may make live paid API calls; run it only in an approved environment with suitable credentials and cost limits. Do not claim an end-to-end script or workflow exists unless it is actually present. Run migrations only against the explicitly approved environment and verify order, backup, and rollback implications.

**A task is Done only if:**
1. Its acceptance criteria are met and demonstrated.
2. The relevant tests/checks pass or exact failures are disclosed.
3. Changes do not break the core user journey, access boundaries, or spending limits.
4. Required staging/manual validation is complete or the task is plainly marked **awaiting validation**, not Done.
5. The diff is reviewed, remaining risks are documented, and release approval is separate from implementation completion.

No fabrication of test runs, benchmarks, deployments, provider credentials, or completion status.

## 9. Standard progress and handoff format

For significant tasks, communicate succinctly:

- **Goal and priority:** one sentence.
- **Current state:** what exists, what is broken, what is uncertain.
- **Plan:** the smallest workable steps, with high-risk decisions called out.
- **Result:** files/behavior changed, and where to inspect the branch/PR.
- **Evidence:** commands run, tests passed/failed, staging or live results.
- **Open items:** blockers, limits, approvals required, and precise next action.

Never describe work as deployed, released, production-ready, or fully tested unless there is direct evidence. Surface blockers early rather than filling the sprint with unrelated features.

## 10. Source of truth and maintenance

- `AGENTS.md`: existing technical invariants, local development conventions, and detailed feature notes.
- `docs/PRODUCT_SPEC.md`: product promise and launch acceptance; confirm any outdated details with the product owner.
- `docs/ARCHITECTURE.md`: relevant system boundaries; inspect real code if documentation is stale.
- `docs/TASKS.md`: historical and planned work; **do not treat unchecked boxes as reliable proof of current state**.
- `docs/RESPONSE_QUALITY.md` and `benchmarks/`: quality evaluation and regression cases when relevant.
- **This file:** cross-tool decision-making and engineering workflow; do not duplicate it in other agent instruction files.

When the team changes priorities or standards, update the owning document in the same PR. Keep the always-loaded instructions short and contextual; do not force agents to read every file for a trivial change.

## 11. Tool integration

**Codex:** Add a short instruction near the top of root `AGENTS.md`: `For Orbit engineering work, follow docs/ENGINEERING_PROTOCOL.md. Apply its intake, scope, validation, and reporting rules proportionally to the task.` Codex recognizes root `AGENTS.md` automatically when working in this repo.

**Claude Code:** Root `CLAUDE.md` can import this file with `@docs/ENGINEERING_PROTOCOL.md` (alongside the existing `@AGENTS.md`).

**Claude Cowork:** Configure the Orbit project/folder instructions with: `When performing engineering work for Orbit AI, read and follow ENGINEERING_PROTOCOL.md from the connected Orbit repository before planning or changing code. Treat AGENTS.md as the technical constraints. If the file is inaccessible, say so instead of assuming its contents. Do not treat a planning prompt as authorization to edit code or deploy.` Give the session access to the correct local folder or project files.

A Markdown file guides agent behavior but does **not** technically guarantee obedience. Complement it with protected-branch review requirements, CI checks, staging permissions, and human approval of privileged operations.
