import { describe, expect, it } from "vitest";
import { fitToolContext, toolTurnTokens } from "./tool-context";
import type { Step } from "@/lib/folder/run";
import { normalizeTurns } from "@/lib/providers/types";

function step(size: number, count = 2, prefix = "g", text = "Read the next files."): Step {
  const calls = Array.from({ length: count }, (_, i) => ({ id: prefix + i, name: "github_read_file", args: { repo: "synthetic/demo", path: `src/${i}.ts` }, meta: { thoughtSignature: "original-signature", providerId: true } }));
  return { text, calls, results: calls.map((call) => ({ id: call.id, name: call.name, output: 'const x = "\\\"\n'.repeat(Math.ceil(size / 16)).slice(0, size), status: "ok" })) };
}

describe("shared tool input budget", () => {
  it("keeps small results unchanged", () => {
    const source = step(100);
    const result = fitToolContext([source], 2000)!;
    expect(result.compacted).toBe(false);
    expect(result.turns[1].toolResults?.map((r) => r.output)).toEqual(source.results.map((r) => r.output));
  });
  it.each([500, 2000, 6000, 10000])("fits two large GitHub files to %i tokens with explicit excerpts", (budget) => {
    const source = step(50000);
    const before = JSON.stringify(source);
    const result = fitToolContext([source], budget)!;
    expect(result).not.toBeNull();
    expect(result.compacted).toBe(true);
    expect(toolTurnTokens(result.turns)).toBeLessThanOrEqual(budget);
    expect(result.turns[0].toolCalls).toEqual(source.calls);
    expect(result.turns[1].toolResults?.map((r) => r.id)).toEqual(source.calls.map((c) => c.id));
    expect(result.turns[1].toolResults?.every((r) => r.output.includes("source excerpt"))).toBe(true);
    expect(JSON.stringify(source)).toBe(before);
  });
  it("bounds many rounds including assistant commentary and JSON escaping", () => {
    const steps = Array.from({ length: 12 }, (_, i) => step(60000, 8, `round${i}-`, "Analysis. ".repeat(4000)));
    const result = fitToolContext(steps, 4000)!;
    expect(result.tokens).toBeLessThanOrEqual(4000);
    const turns = normalizeTurns([{ role: "user", content: "Preserve this question" }, ...result.turns]);
    for (let i = 1; i < turns.length; i += 2) expect(turns[i].toolCalls?.map((c) => c.id)).toEqual(turns[i + 1].toolResults?.map((r) => r.id));
    expect(turns.at(-2)?.toolCalls?.[0].id).toBe("round11-0");
    expect(result.turns[0].content).toContain("Earlier tool rounds omitted");
  });
  it("does not misrepresent errors as successful reads", () => {
    const source = step(50000, 1);
    source.results[0].status = "error";
    expect(fitToolContext([source], 500)!.turns[1].toolResults?.[0].output).toContain("[error;");
  });
  it("fits mixed small errors and a large result without expanding the errors", () => {
    const source = step(15, 8);
    source.results.forEach((r) => { r.output = "File not found."; r.status = "error"; });
    source.results[7].output = "x".repeat(50000);
    source.results[7].status = "ok";
    const result = fitToolContext([source], 1000)!;
    expect(result).not.toBeNull();
    expect(result.tokens).toBeLessThanOrEqual(1000);
    expect(result.turns[1].toolResults?.slice(0, 7).every((r) => r.output === "File not found.")).toBe(true);
    expect(result.turns[1].toolResults?.[7].output).toContain("source excerpt");
  });
  it("never rewrites tool arguments or signatures to force them into a budget", () => {
    const source = step(100, 1);
    source.calls[0].args = { code: "x".repeat(10000) } as unknown as typeof source.calls[0]["args"];
    expect(fitToolContext([source], 100)).toBeNull();
  });
});
