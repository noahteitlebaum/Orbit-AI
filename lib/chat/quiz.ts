// "Quiz me" progress. After grading each answer, the model adds a hidden line like
//   [[quiz: wrong | Sampling variance]]
// The server reads these, keeps the score itself (the model never sets it), saves it on the chat, and removes
// the lines from what students see. Missed concepts come back in later questions and across the course's chats.

export type ConceptTally = { right: number; wrong: number };
export type QuizState = { asked: number; correct: number; concepts: Record<string, ConceptTally> };
export type QuizResult = { correct: boolean; concept: string };

const MARKER = /\[\[quiz:\s*(right|correct|wrong|incorrect)\s*\|\s*([^\]\n]{1,80})\]\]/gi;
const MAX_CONCEPTS = 60;

export const emptyQuiz = (): QuizState => ({ asked: 0, correct: 0, concepts: {} });

/** The results in an answer, and the answer without the marker lines. */
export function parseQuiz(text: string): { clean: string; results: QuizResult[] } {
  const results: QuizResult[] = [];
  const clean = text
    .replace(MARKER, (_, verdict: string, concept: string) => {
      const name = tidy(concept);
      if (name) results.push({ correct: /right|correct/i.test(verdict) && !/incorrect/i.test(verdict), concept: name });
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { clean, results };
}

/** Hide markers while an answer is still streaming (including a half-written one at the end). */
export function hideQuizMarkers(text: string): string {
  return text.replace(MARKER, "").replace(/\[\[(q(u(i(z(:[^\]]*)?)?)?)?)?$/i, "");
}

const tidy = (s: string) => s.replace(/\s+/g, " ").trim().replace(/^./, (c) => c.toUpperCase()).slice(0, 80);

export function applyResults(state: QuizState | null | undefined, results: QuizResult[]): QuizState {
  const next: QuizState = { asked: state?.asked ?? 0, correct: state?.correct ?? 0, concepts: { ...(state?.concepts ?? {}) } };
  for (const r of results) {
    next.asked++;
    if (r.correct) next.correct++;
    // Same concept with different capitalisation counts once.
    const key = Object.keys(next.concepts).find((k) => k.toLowerCase() === r.concept.toLowerCase()) ?? r.concept;
    const t = { ...(next.concepts[key] ?? { right: 0, wrong: 0 }) };
    if (r.correct) t.right++;
    else t.wrong++;
    next.concepts[key] = t;
  }
  // Keep the most recently relevant concepts if the list grows very long.
  const keys = Object.keys(next.concepts);
  if (keys.length > MAX_CONCEPTS) for (const k of keys.slice(0, keys.length - MAX_CONCEPTS)) delete next.concepts[k];
  return next;
}

/** Concepts still to review: missed more often than answered right, most-missed first. */
export function missedConcepts(state: QuizState | null | undefined): { concept: string; wrong: number }[] {
  return Object.entries(state?.concepts ?? {})
    .filter(([, t]) => t.wrong > t.right)
    .map(([concept, t]) => ({ concept, wrong: t.wrong }))
    .sort((a, b) => b.wrong - a.wrong);
}

/** Merge several chats' progress (a course's quiz history). */
export function mergeQuiz(states: (QuizState | null | undefined)[]): QuizState {
  const out = emptyQuiz();
  for (const s of states) {
    if (!s) continue;
    out.asked += s.asked;
    out.correct += s.correct;
    for (const [k, t] of Object.entries(s.concepts ?? {})) {
      const key = Object.keys(out.concepts).find((x) => x.toLowerCase() === k.toLowerCase()) ?? k;
      const cur = out.concepts[key] ?? { right: 0, wrong: 0 };
      out.concepts[key] = { right: cur.right + t.right, wrong: cur.wrong + t.wrong };
    }
  }
  return out;
}

/** Added to the quiz prompt each turn: the score so far and what to come back to. */
export function quizContext(chat: QuizState | null | undefined, course: QuizState | null | undefined): string {
  const lines = [
    "After you grade each answer, add one line on its own, exactly like: [[quiz: right | Concept name]] or [[quiz: wrong | Concept name]] " +
      "(the concept the question tested, 1–5 words). The app keeps the score from these lines and hides them; don't write a running score yourself.",
  ];
  if (chat?.asked) lines.push(`Score so far in this chat: ${chat.correct}/${chat.asked}.`);
  const missed = missedConcepts(chat).slice(0, 8);
  if (missed.length) lines.push(`Missed in this chat (bring these back, explained a different way): ${missed.map((m) => m.concept).join(", ")}.`);
  const courseMissed = missedConcepts(course).filter((m) => !missed.some((x) => x.concept.toLowerCase() === m.concept.toLowerCase())).slice(0, 8);
  if (courseMissed.length) lines.push(`Missed in earlier quizzes in this course: ${courseMissed.map((m) => m.concept).join(", ")}. Include some of these.`);
  return lines.join("\n");
}
