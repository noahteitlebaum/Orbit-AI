import { describe, expect, it } from "vitest";
import { buildContext, costMicros, estimateTokens, maxOutputFor, reservationMicros } from "./context";

describe("context policy", () => {
  const turns = Array.from({ length: 10 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: "x".repeat(300) }));

  it("keeps everything when it fits", () => {
    const r = buildContext(turns, 10_000);
    expect(r.turns).toHaveLength(10);
    expect(r.dropped).toBe(false);
  });

  it("drops the oldest turns first and flags it", () => {
    const per = estimateTokens("x".repeat(300));
    const r = buildContext(turns, per * 3);
    expect(r.turns).toHaveLength(3);
    expect(r.turns[2]).toBe(turns[9]);
    expect(r.dropped).toBe(true);
  });

  it("always keeps the newest message even if it alone is over budget", () => {
    const r = buildContext([{ role: "user", content: "y".repeat(10_000) }], 10);
    expect(r.turns).toHaveLength(1);
  });
});

describe("money", () => {
  const m = { inputPrice: 2, outputPrice: 10 };
  it("prices in micros ($/1M tokens × tokens)", () => {
    expect(costMicros(m, { input: 1000, output: 500 })).toBe(7000); // $0.007
  });
  it("reserves more than the worst case input + full output", () => {
    expect(reservationMicros(m, 1000, 500)).toBeGreaterThanOrEqual(costMicros(m, { input: 1000, output: 500 }));
  });
  it("shrinks output to fit what's left", () => {
    const fit = maxOutputFor(m, 1000, 10_000);
    expect(reservationMicros(m, 1000, fit)).toBeLessThanOrEqual(10_000);
    expect(maxOutputFor(m, 1000, 100)).toBe(0);
  });
});
