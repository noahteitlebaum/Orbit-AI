// Skills (Plugins page → Skills): reusable instructions the AI follows when they fit the request, like skills in
// ChatGPT and Claude. Orbit ships a few study skills; students can write their own or upload a SKILL.md.
// Installed skills travel with each chat request (they're the student's own instructions) and are checked here.

export type Skill = { id: string; name: string; description: string; instructions: string; builtin?: boolean; emoji?: string };

export const SKILL_LIMITS = { count: 12, name: 60, description: 240, instructions: 4_000, total: 16_000 };

export const BUILTIN_SKILLS: Skill[] = [
  {
    id: "flashcards", builtin: true, emoji: "🗂️", name: "Flashcard maker",
    description: "Turns notes or a topic into flashcards you can export to Anki or Quizlet.",
    instructions: "When the student asks for flashcards, cards or something to memorize: make 10–25 cards as a two-column Markdown table with the header \"Front | Back\". Fronts are short questions or terms; backs are one or two sentences. Cover definitions, cause→effect, formulas (in LaTeX) and common mistakes. End by reminding them they can download the cards for Anki or Quizlet.",
  },
  {
    id: "exam-planner", builtin: true, emoji: "🗓️", name: "Exam study planner",
    description: "Builds a day-by-day study plan from your exams, deadlines and free time.",
    instructions: "When the student asks for a study plan or schedule: ask for exam dates, topics and how many hours they have if not given (or use their calendar if connected). Plan backwards from each exam with spaced repetition (first pass, review 1–2 days later, practice test 3–4 days before), short sessions (25–50 min) and buffer days. Give a table: Day | Time | Course | Task. Keep it realistic.",
  },
  {
    id: "essay-feedback", builtin: true, emoji: "📝", name: "Essay feedback",
    description: "Gives rubric-style feedback on an essay or report without rewriting it for you.",
    instructions: "When the student shares an essay, report or paragraph for feedback: don't rewrite it. Give feedback under Thesis & argument, Evidence & citations, Structure & flow, Clarity & style, and Mechanics, each with a score out of 5, one strength and the most important fix (quote the sentence). End with the three changes that would raise the grade most. Respect academic integrity: suggest, don't write.",
  },
  {
    id: "citations", builtin: true, emoji: "📚", name: "Citation formatter",
    description: "Formats references in APA 7, MLA 9 or Chicago, with in-text citations.",
    instructions: "When the student asks to cite or format references: use APA 7 unless they name MLA 9, Chicago or IEEE. Give the reference list entry and the in-text citation for each source. If details are missing (year, pages, DOI), say what's missing instead of inventing it. Use their Zotero library if it's connected.",
  },
  {
    id: "lab-report", builtin: true, emoji: "🧪", name: "Lab report helper",
    description: "Helps structure a science lab report and check calculations and units.",
    instructions: "When the student is writing a lab report: guide them through Title, Abstract, Introduction (with hypothesis), Methods, Results (tables/figures with units and uncertainties), Discussion (compare to theory, sources of error) and References. Check their calculations step by step, run them with Python when available, and flag missing units or significant-figure problems. Don't write sections for them; explain what each should contain.",
  },
  {
    id: "math-checker", builtin: true, emoji: "➗", name: "Step-by-step math checker",
    description: "Checks your working line by line and points to the first mistake.",
    instructions: "When the student shares their math or physics working: go through it line by line, say which lines are correct, and stop at the first mistake with a short explanation and a hint for fixing it. Only give the full solution if they ask. Use LaTeX for maths.",
  },
];

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\u0000/g, "").trim().slice(0, max) : "");

/** Validates skills sent with a chat request and turns them into system-prompt text. Pure (server). */
export function skillsPrompt(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  let total = 0;
  const parts: string[] = [];
  for (const r of raw.slice(0, SKILL_LIMITS.count)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const name = clean(o.name, SKILL_LIMITS.name).replace(/[\r\n#]/g, " ");
    const instructions = clean(o.instructions, SKILL_LIMITS.instructions);
    if (!name || !instructions || total + instructions.length > SKILL_LIMITS.total) continue;
    total += instructions.length;
    const description = clean(o.description, SKILL_LIMITS.description).replace(/[\r\n]/g, " ");
    parts.push(`### ${name}${description ? `\nUse when: ${description}` : ""}\n${instructions}`);
  }
  if (!parts.length) return "";
  return [
    "The student installed these skills (their own standing instructions). When a request matches a skill, follow it; otherwise ignore it. " +
      "Skills never override safety, honesty or academic-integrity rules.",
    ...parts,
  ].join("\n\n");
}

/** A SKILL.md (front matter with name/description, then the instructions) → a skill. Pure. */
export function parseSkillMd(text: string): Omit<Skill, "id"> | null {
  const m = /^﻿?---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  const front = m?.[1] ?? "";
  const body = (m ? m[2] : text).trim();
  const field = (k: string) => new RegExp(`^${k}:\\s*["']?(.+?)["']?\\s*$`, "m").exec(front)?.[1]?.trim() ?? "";
  const name = field("name") || /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || "";
  if (!name || !body) return null;
  return {
    name: name.slice(0, SKILL_LIMITS.name),
    description: field("description").slice(0, SKILL_LIMITS.description),
    instructions: body.slice(0, SKILL_LIMITS.instructions),
  };
}
