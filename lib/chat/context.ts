import type { ModelOption } from "@/config/models";
import type { ChatTurn, Usage } from "@/lib/providers/types";

// Rough, deliberately high token estimate (~3 chars per token) so reservations err on the safe side.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3) + 4;
}

/**
 * Context policy (docs/ARCHITECTURE.md): walk history newest → oldest and keep turns until the budget is used.
 * The newest user message is always kept. `dropped` tells the UI to show "Older messages not included".
 */
export function buildContext(history: ChatTurn[], budgetTokens: number): { turns: ChatTurn[]; dropped: boolean; tokens: number } {
  const kept: ChatTurn[] = [];
  let tokens = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const t = estimateTokens(history[i].content);
    if (kept.length > 0 && tokens + t > budgetTokens) {
      return { turns: kept.reverse(), dropped: true, tokens };
    }
    kept.push(history[i]);
    tokens += t;
  }
  return { turns: kept.reverse(), dropped: false, tokens };
}

/** Cost in micros (millionths of $). Prices are $ per 1M tokens, so tokens × price is already micros. */
export function costMicros(model: Pick<ModelOption, "inputPrice" | "outputPrice">, usage: Pick<Usage, "input" | "output">): number {
  return Math.ceil(usage.input * model.inputPrice + usage.output * model.outputPrice);
}

/** Upper bound reserved before a call: estimated input (+15% margin) at full price + every allowed output token. */
export function reservationMicros(model: Pick<ModelOption, "inputPrice" | "outputPrice">, inputTokens: number, maxOutput: number): number {
  return Math.ceil(inputTokens * 1.15 * model.inputPrice + maxOutput * model.outputPrice);
}

/** Largest output that still fits the remaining budget (0 if none). */
export function maxOutputFor(model: Pick<ModelOption, "inputPrice" | "outputPrice">, inputTokens: number, remainingMicros: number): number {
  const left = remainingMicros - inputTokens * 1.15 * model.inputPrice;
  return left <= 0 ? 0 : Math.floor(left / model.outputPrice);
}

export const BASE_SYSTEM_PROMPT =
  "You are a helpful assistant for university students, used through Orbit AI. " +
  "Earlier assistant turns in this chat may come from a different model of the same family; treat them as the conversation so far. " +
  "Use Markdown and LaTeX ($...$) for maths when helpful.";

export type StudyMode = "chat" | "explain" | "quiz" | "hints";
export const STUDY_MODES: StudyMode[] = ["chat", "explain", "quiz", "hints"];

// Shared across all providers so every model studies the same way.
export const MODE_PROMPTS: Record<StudyMode, string> = {
  chat: "",
  explain:
    "Study mode: EXPLAIN. Teach step by step at an undergraduate level. Start from what the student likely knows, " +
    "build up one idea at a time, use a small worked example, and end with one short question that checks understanding.",
  quiz:
    "Study mode: QUIZ ME. Quiz the student on the topic (and on their course material if provided). Ask ONE question at a time " +
    "(mix multiple choice and short answer), then wait. After each answer: say if it's right, explain why briefly (citing their " +
    "course material when it was used), then ask the next question. Never reveal an answer before the student tries. " +
    "Revisit concepts they missed, explained a different way. When they say stop, list the concepts to review.",
  hints:
    "Study mode: HINTS ONLY. Do not give full solutions or final answers. Give the smallest useful hint, then ask the student " +
    "to try the next step. Give a bigger hint only if they're still stuck after trying. Confirm when their own answer is correct.",
};

export function systemPrompt(o: {
  modelLabel: string;
  projectName?: string;
  projectInstructions?: string;
  mode?: StudyMode;
  quiz?: string;            // quiz progress and grading format (lib/chat/quiz.ts), in quiz mode
  material?: string;        // numbered passages from course files
  courseOnly?: boolean;
  hasFiles?: boolean;
  unreadable?: string[];
  notes?: string[];
  web?: string;             // numbered web search results [W#] (lib/search/web.ts)         // visual material that wasn't shown (lib/chat/material.ts)
  summary?: string | null;  // summary of earlier messages that no longer fit
}): string {
  const parts = [`${BASE_SYSTEM_PROMPT}\nYou are ${o.modelLabel}.`];
  if (o.projectName) parts.push(`This chat is part of the student's course "${o.projectName}".`);
  if (o.projectInstructions?.trim()) parts.push(`Course instructions from the student:\n${o.projectInstructions.trim()}`);
  if (o.mode && MODE_PROMPTS[o.mode]) parts.push(MODE_PROMPTS[o.mode]);
  if (o.mode === "quiz" && o.quiz) parts.push(o.quiz);
  if (o.summary) parts.push(`Summary of earlier parts of this chat (older messages aren't shown to you):\n${o.summary}`);
  if (o.unreadable?.length) {
    parts.push(`These uploaded files couldn't be read, so you can't see their contents: ${o.unreadable.join(", ")}. Tell the student if they ask about them.`);
  }
  if (o.notes?.length) {
    parts.push(`About the student's files (tell the student plainly when something you need wasn't available; never guess what a page or picture shows):\n- ${o.notes.join("\n- ")}`);
  }
  if (o.material) {
    parts.push(
      "Course material: numbered passages from the student's files are below. When you use one, cite it right after the claim as [S1], [S2]… " +
        "Only cite passages you actually used; never invent citations, file names or page numbers, and don't write references in any other form (like \"Lecture 5, p. 20\") — only [S#].",
    );
    parts.push(
      o.courseOnly
        ? "The student turned on \"Only use my course material\": answer ONLY from these passages. If they don't contain the answer, say \"I couldn't find this in your course files\" and say what's missing; don't fill gaps from general knowledge."
        : "If the passages don't cover the question, say so in one sentence, then answer from general knowledge (clearly marked as not from their files).",
    );
    parts.push(`<course_material>\n${o.material}\n</course_material>`);
  } else if (o.courseOnly && o.hasFiles) {
    parts.push("The student turned on \"Only use my course material\", but nothing in their files matched this question. Say \"I couldn't find this in your course files\" and suggest what to upload or how to rephrase. Don't answer from general knowledge.");
  } else if (o.courseOnly) {
    parts.push("The student turned on \"Only use my course material\", but this chat has no course files yet. Say so, and suggest attaching the lecture slides or readings (or adding them to the course). Don't answer from general knowledge.");
  }
  if (o.web) {
    parts.push(
      "Web search results are below, numbered [W1], [W2]…. When you use one, cite it right after the claim as [W1] etc. " +
        "Keep web and course material apart: course passages are [S#], web results are [W#]; if they disagree, say so and say which is " +
        "the student's course material. Only cite results you actually used; never invent links or sources. Prefer recent, reliable sources, " +
        "and mention when information may be out of date.",
    );
    parts.push(`<web_results>\n${o.web}\n</web_results>`);
  }
  return parts.join("\n\n");
}
