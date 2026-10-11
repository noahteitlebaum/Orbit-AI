import { describe, expect, it } from "vitest";
import { batches, transcriptLine } from "./summary";

describe("long-chat summary input", () => {
  it("records who answered (which model) and which files were attached", () => {
    expect(transcriptLine({ seq: 1, role: "user", content: "Explain this", files: ["lecture3.pdf"] })).toBe("Student [attached: lecture3.pdf]: Explain this");
    expect(transcriptLine({ seq: 2, role: "assistant", content: "Sure", model_id: "anthropic-opus" })).toBe("Assistant (Claude Opus 5.5): Sure");
  });

  it("shortens very long messages instead of dropping them", () => {
    const line = transcriptLine({ seq: 1, role: "user", content: `START ${"x".repeat(20_000)} END` });
    expect(line.length).toBeLessThan(7_000);
    expect(line).toContain("START");
    expect(line).toContain("END");
    expect(line).toContain("[…shortened…]");
  });

  it("splits a big backlog into ordered batches without losing any message", () => {
    const msgs = Array.from({ length: 30 }, (_, i) => ({ seq: i + 1, role: i % 2 ? "assistant" : "user", content: "y".repeat(5_000) }));
    const out = batches(msgs);
    expect(out.length).toBeGreaterThan(1);
    expect(out.flat().map((m) => m.seq)).toEqual(msgs.map((m) => m.seq));
  });
});
