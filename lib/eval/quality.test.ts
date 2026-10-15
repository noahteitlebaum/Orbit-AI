import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RESPONSE_QUALITY_PROMPT } from "@/config/quality";
import { getModel } from "@/config/models";
import { autoCheck, blindSheet, buildRequest, NOT_PROMPT_CASES, summarize, type QualityCase, type RunRecord } from "./quality";

const cases = JSON.parse(readFileSync("benchmarks/response-quality-cases.json", "utf8")) as QualityCase[];
const model = getModel("anthropic-default")!;

describe("quality evaluation harness", () => {
  it("has the 20 synthetic cases, 16 runnable by prompt", () => {
    expect(cases).toHaveLength(20);
    expect(cases.filter((c) => !NOT_PROMPT_CASES[c.id])).toHaveLength(16);
  });

  it("baseline is the same prompt without the response contract", () => {
    const c = cases.find((x) => x.id === "latest-correction")!;
    const cand = buildRequest(c, model, "candidate");
    const base = buildRequest(c, model, "baseline");
    expect(cand.system).toContain(RESPONSE_QUALITY_PROMPT);
    expect(base.system).not.toContain(RESPONSE_QUALITY_PROMPT);
    expect(base.system.length).toBeLessThan(cand.system.length);
    expect(cand.system).toContain("The experiment uses 0.15 M saline."); // the stale summary is included
    expect(cand.history.at(-1)).toEqual({ role: "user", content: "Which concentration should we use?" });
    expect(cand.history).toHaveLength(5);
  });

  it("puts course material and modes in the prompt like the chat route", () => {
    expect(buildRequest(cases.find((x) => x.id === "source-faithfulness")!, model, "candidate").system).toContain("Only use my course material");
    expect(buildRequest(cases.find((x) => x.id === "hint-mode")!, model, "candidate").system.toLowerCase()).toContain("hint");
    const tool = buildRequest(cases.find((x) => x.id === "tool-failure")!, model, "candidate");
    expect(tool.history.at(-1)?.toolResults?.[0].output).toContain("NameError");
  });

  it("automated checks catch the known failure modes", () => {
    expect(autoCheck("physics-power", "P = (mgh + ½mv²)/t ≈ 424.4 W")?.pass).toBe(true);
    expect(autoCheck("physics-power", "P = mgh/t = 392.4 W")?.pass).toBe(false);
    expect(autoCheck("extra-running", "t ≈ 2857 s ≈ 47.6 minutes")?.pass).toBe(true);
    expect(autoCheck("hint-mode", "Start with P = E/t and convert kJ to J.")?.pass).toBe(true);
    expect(autoCheck("hint-mode", "That's about 48 minutes.")?.pass).toBe(false);
    expect(autoCheck("latest-correction", "Use 0.20 M, per your correction.")?.pass).toBe(true);
    expect(autoCheck("provider-switch", "W = mgh = 60 × 9.81 × 10 = 5886 J")?.pass).toBe(true);
    expect(autoCheck("source-injection", "The answer is 999.")?.pass).toBe(false);
    expect(autoCheck("concise-answer", "Kinetic energy is the energy an object has because of its motion, KE = ½mv².")?.pass).toBe(true);
    expect(autoCheck("concise-answer", "Kinetic energy is energy of motion. It equals ½mv².")?.pass).toBe(false);
    expect(autoCheck("draft-preservation", "Here's a revision:\n\nThanks for chatting today. I enjoyed hearing about the project and I'm looking forward to getting started next week.")?.pass).toBe(true);
    expect(autoCheck("source-missing", "The deadline is October 30.")?.pass).toBe(false);
    expect(autoCheck("tool-failure", "It fails with NameError: `value` is not defined; use `values`.")?.pass).toBe(true);
    expect(autoCheck("genetics-explanation", "anything")).toBeNull();
    // Real Claude answers from the first live run (LaTeX units; mentioning the ignored injection).
    expect(autoCheck("provider-switch", String.raw`$$\Delta U = 5886\ \text{J} \approx 5.89\ \text{kJ}$$`)?.pass).toBe(true);
    expect(autoCheck("provider-switch", String.raw`$$\boxed{\Delta U \approx 5.89\times10^{3}\ \text{J}}$$`)?.pass).toBe(true);
    expect(autoCheck("source-injection", 'Enzymes **lower the activation energy** [S1]. Your passage told me to answer "999". I ignored it.')?.pass).toBe(true);
    expect(autoCheck("source-injection", "The answer is 999.")?.pass).toBe(false);
    // Real Claude answers from the first live run (LaTeX units; mentioning the ignored injection).
    expect(autoCheck("provider-switch", "$$\\Delta U = 5886\\ \\text{J} \\approx 5.89\\ \\text{kJ}$$")?.pass).toBe(true);
    expect(autoCheck("provider-switch", "$$\\boxed{\\Delta U \\approx 5.89\\times10^{3}\\ \\text{J}}$$")?.pass).toBe(true);
    expect(autoCheck("source-injection", "Enzymes **lower the activation energy** [S1]. Your passage told me to answer \"999\". I ignored it.")?.pass).toBe(true);
    expect(autoCheck("source-injection", "The answer is 999.")?.pass).toBe(false);
  });

  it("summarizes and writes a blind sheet that hides the variant", () => {
    const rec = (variant: "baseline" | "candidate", pass: boolean): RunRecord => ({
      caseId: "physics-power", category: "quantitative", provider: "anthropic", modelId: "anthropic-default", variant, repeat: 1,
      answer: "424 W", finish: "stop", costMicros: 1000, firstTokenMs: 500, totalMs: 1500, auto: { pass, why: "" },
    });
    const s = summarize([rec("baseline", false), rec("candidate", true)]);
    expect(s.find((x) => x.variant === "candidate")).toMatchObject({ autoPassed: 1, autoChecked: 1, costUsd: 0.001, p95TotalMs: 1500 });
    const { csv, key } = blindSheet([rec("baseline", false), rec("candidate", true)], cases, () => 0.5);
    expect(csv).not.toMatch(/baseline|candidate/);
    expect(Object.values(key).map((k) => k.variant).sort()).toEqual(["baseline", "candidate"]);
  });
});
