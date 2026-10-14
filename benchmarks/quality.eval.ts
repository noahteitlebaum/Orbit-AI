// Live response-quality evaluation (costs real API credits). Run:
//   npm run eval:quality                                   # every app with a key, 3 repeats
//   EVAL_PROVIDERS=anthropic EVAL_REPEAT=1 npm run eval:quality
//   EVAL_MODELS=openai-luna,anthropic-haiku npm run eval:quality
// Keys come from .env.local. Writes benchmarks/results/quality-<time>.{json,csv} and a separate blind key.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvConfig } from "@next/env";
import { describe, expect, it } from "vitest";
import { defaultModelFor, getModel, PROVIDERS, type ProviderId } from "@/config/models";
import { blindSheet, buildRequest, autoCheck, NOT_PROMPT_CASES, recordCost, summarize, type QualityCase, type RunRecord, type Variant } from "@/lib/eval/quality";
import { ADAPTERS, apiKeyFor } from "@/lib/providers";

loadEnvConfig(process.cwd());
const live = process.env.EVAL_LIVE === "1";

describe.skipIf(!live)("live response-quality evaluation", () => {
  it("runs baseline vs candidate on the synthetic student cases", async () => {
    const cases = (JSON.parse(readFileSync(join(process.cwd(), "benchmarks/response-quality-cases.json"), "utf8")) as QualityCase[])
      .filter((c) => !NOT_PROMPT_CASES[c.id]);
    const repeat = Math.max(1, Number(process.env.EVAL_REPEAT ?? 3));
    const wanted = process.env.EVAL_PROVIDERS?.split(",").map((s) => s.trim()) as ProviderId[] | undefined;
    const pickedModels = process.env.EVAL_MODELS?.split(",").map((s) => getModel(s.trim())).filter(Boolean);
    const models = (pickedModels?.length ? pickedModels : PROVIDERS.filter((p) => !wanted || wanted.includes(p)).map((p) => getModel(defaultModelFor(p))))
      .filter((m): m is NonNullable<typeof m> => Boolean(m && apiKeyFor(m.provider)));
    expect(models.length, "no API keys found for the chosen apps").toBeGreaterThan(0);

    const records: RunRecord[] = [];
    for (const model of models) {
      for (const c of cases) {
        for (const variant of ["baseline", "candidate"] as Variant[]) {
          for (let r = 1; r <= repeat; r++) {
            const { system, history } = buildRequest(c, model, variant);
            const started = Date.now();
            let first: number | null = null;
            let answer = "";
            let finish: RunRecord["finish"] = "unknown";
            let usage: RunRecord["usage"];
            let error: string | undefined;
            try {
              for await (const ev of ADAPTERS[model.provider].stream({ model, system, history, maxOutput: 1_500, apiKey: apiKeyFor(model.provider)!, signal: AbortSignal.timeout(90_000) })) {
                if (ev.delta) {
                  first ??= Date.now() - started;
                  answer += ev.delta;
                }
                if (ev.usage) usage = ev.usage;
                if (ev.finish) finish = ev.finish;
              }
            } catch (e) {
              finish = "error";
              error = `${(e as { code?: string }).code ?? "error"} ${(e as { status?: number }).status ?? ""}`.trim();
            }
            const rec: RunRecord = {
              caseId: c.id, category: c.category, provider: model.provider, modelId: model.id, variant, repeat: r, answer, finish, error, usage,
              costMicros: recordCost(model, usage), firstTokenMs: first, totalMs: Date.now() - started, auto: finish === "error" ? null : autoCheck(c.id, answer),
            };
            records.push(rec);
            console.log(`${model.short.padEnd(10)} ${variant.padEnd(9)} ${c.id.padEnd(24)} #${r} ${finish.padEnd(9)} ${rec.auto ? (rec.auto.pass ? "PASS" : "FAIL") : "human"} ${rec.auto?.why ?? ""}`);
          }
        }
      }
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = join(process.cwd(), "benchmarks/results");
    mkdirSync(dir, { recursive: true });
    const summary = summarize(records);
    const { csv, key } = blindSheet(records, cases);
    writeFileSync(join(dir, `quality-${stamp}.json`), JSON.stringify({ at: new Date().toISOString(), repeat, skipped: NOT_PROMPT_CASES, summary, records }, null, 2));
    writeFileSync(join(dir, `quality-${stamp}-review.csv`), csv);
    writeFileSync(join(dir, `quality-${stamp}-blind-key.json`), JSON.stringify(key, null, 2));
    console.table(summary);
    console.log(`Results: benchmarks/results/quality-${stamp}.json · blind review sheet: …-review.csv (key kept separately)`);
  }, 3_600_000);
});
