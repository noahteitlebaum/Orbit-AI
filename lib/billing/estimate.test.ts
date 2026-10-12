import { describe, expect, it } from "vitest";
import { answersLeft, answersText, isLow, timesCheaper, typicalAnswerMicros } from "./estimate";

const sol = { id: "openai-default", inputPrice: 2, outputPrice: 10 };
const luna = { id: "openai-luna", inputPrice: 0.1, outputPrice: 0.5 };

describe("budget in plain words", () => {
  it("estimates a typical answer, preferring the student's own recent average", () => {
    expect(typicalAnswerMicros(sol)).toBe(13_000); // ≈ 1.3 cents
    expect(typicalAnswerMicros(sol, { "openai-default": 20_000 })).toBe(20_000);
  });
  it("turns money left into answers left", () => {
    expect(answersLeft(130_000, sol)).toBe(10);
    expect(answersText(10)).toBe("about 10 more answers");
    expect(answersText(1)).toBe("about 1 more answer");
    expect(answersText(0)).toBe("less than 1 answer");
    expect(answersText(237)).toBe("about 240 more answers");
  });
  it("warns early enough to finish a session, and compares models", () => {
    expect(isLow(100_000, 5_000_000, 13_000)).toBe(true);   // < 10 answers
    expect(isLow(1_000_000, 5_000_000, 13_000)).toBe(false);
    expect(timesCheaper(typicalAnswerMicros(sol), typicalAnswerMicros(luna))).toBe(20);
  });
});
