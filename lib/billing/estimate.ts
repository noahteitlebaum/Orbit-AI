import type { ModelOption } from "@/config/models";

// Budgets in words students understand: "about 40 more answers with Sol" instead of dollars and tokens.
// A typical answer is estimated from the student's own recent answers with that model when there are some,
// otherwise from a usual question (≈3,000 tokens of chat and files in, ≈700 tokens out).
const TYPICAL_INPUT = 3_000;
const TYPICAL_OUTPUT = 700;

export function typicalAnswerMicros(model: Pick<ModelOption, "id" | "inputPrice" | "outputPrice">, recent?: Record<string, number>): number {
  const seen = recent?.[model.id];
  if (seen && seen > 0) return seen;
  return Math.ceil(TYPICAL_INPUT * model.inputPrice + TYPICAL_OUTPUT * model.outputPrice);
}

/** Whole answers left (never negative). */
export function answersLeft(remainingMicros: number, model: Pick<ModelOption, "id" | "inputPrice" | "outputPrice">, recent?: Record<string, number>): number {
  return Math.max(0, Math.floor(remainingMicros / typicalAnswerMicros(model, recent)));
}

/** "about 40 more answers", "about 1 more answer", "less than 1 answer" */
export function answersText(n: number): string {
  if (n <= 0) return "less than 1 answer";
  if (n >= 1000) return "1,000+ more answers";
  const rounded = n >= 100 ? Math.round(n / 10) * 10 : n;
  return `about ${rounded} more answer${rounded === 1 ? "" : "s"}`;
}

/** Low = fewer than 10 typical answers left with this model, or under 10% of the allowance. */
export function isLow(remainingMicros: number, allowanceMicros: number, perAnswer: number): boolean {
  return remainingMicros < Math.max(perAnswer * 10, allowanceMicros * 0.1);
}

/** How many times cheaper `b` is than `a` per typical answer (e.g. 20). */
export function timesCheaper(a: number, b: number): number {
  return b > 0 ? Math.round(a / b) : 0;
}
