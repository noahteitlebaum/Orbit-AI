import { describe, expect, it } from "vitest";
import { relevant } from "./relevance";
import { estimateTokens } from "./context";

describe("local retrieval", () => {
  it("selects matching facts rather than unrelated recent text", () => {
    const items = ["The lab uses sodium chloride at 20 degrees", "Tomorrow's essay covers poetry"];
    expect(relevant(items, "What temperature for sodium chloride?", s => s, 500)).toEqual([items[0]]);
  });
  it("doesn't fill the prompt with non-matches or overflow the allowance", () => {
    const items = ["sodium ".repeat(1000), "sodium chloride", "sodium nitrate"];
    const found = relevant(items, "sodium", s => s, 20);
    expect(found.reduce((n, s) => n + estimateTokens(s), 0)).toBeLessThanOrEqual(20);
    expect(found).toEqual(items.slice(1));
    expect(relevant(items, "the and please", s => s, 500)).toEqual([]);
  });
  it("is deterministic and does not mutate the saved items", () => {
    const items = Object.freeze(["sodium chloride", "sodium nitrate"]);
    expect(relevant([...items], "sodium", s => s, 10)).toEqual([items[1]]);
  });
});
