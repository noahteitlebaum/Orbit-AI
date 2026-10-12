import { describe, expect, it } from "vitest";
import { applyResults, hideQuizMarkers, mergeQuiz, missedConcepts, parseQuiz, quizContext } from "./quiz";

describe("quiz progress", () => {
  it("reads results, hides the marker lines", () => {
    const { clean, results } = parseQuiz("Not quite — variance uses n-1.\n[[quiz: wrong | sample variance]]\n\nNext question: …");
    expect(results).toEqual([{ correct: false, concept: "Sample variance" }]);
    expect(clean).toBe("Not quite — variance uses n-1.\n\nNext question: …");
    expect(parseQuiz("[[quiz: right | Strata]] [[quiz: incorrect | Clusters]]").results).toEqual([{ correct: true, concept: "Strata" }, { correct: false, concept: "Clusters" }]);
  });

  it("keeps score on the server and tracks concepts to review", () => {
    let s = applyResults(null, [{ correct: false, concept: "Variance" }, { correct: true, concept: "Strata" }]);
    s = applyResults(s, [{ correct: false, concept: "variance" }]);
    expect(s).toMatchObject({ asked: 3, correct: 1 });
    expect(s.concepts.Variance).toEqual({ right: 0, wrong: 2 });
    expect(missedConcepts(s)).toEqual([{ concept: "Variance", wrong: 2 }]);
    s = applyResults(s, [{ correct: true, concept: "Variance" }, { correct: true, concept: "Variance" }]);
    expect(missedConcepts(s)).toEqual([]); // answered right more often now
  });

  it("brings missed concepts back, from this chat and the course", () => {
    const chat = applyResults(null, [{ correct: false, concept: "Variance" }]);
    const course = mergeQuiz([applyResults(null, [{ correct: false, concept: "Cluster sampling" }]), chat]);
    const ctx = quizContext(chat, course);
    expect(ctx).toContain("Score so far in this chat: 0/1");
    expect(ctx).toContain("Missed in this chat (bring these back, explained a different way): Variance");
    expect(ctx).toContain("Missed in earlier quizzes in this course: Cluster sampling");
  });

  it("hides markers while streaming, even half-written", () => {
    expect(hideQuizMarkers("Good! [[quiz: right | Strata]] Next")).toBe("Good!  Next");
    expect(hideQuizMarkers("Good!\n[[qui")).toBe("Good!\n");
  });
});
