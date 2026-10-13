// Personal preferences (Settings → Profile) and saved memories (Settings → Memory), turned into a short part of the
// system prompt. Memories are only used, or saved, when the student turned memory on. The AI saves one by adding a
// hidden line [[remember: …]] to its answer; the server removes the line and stores the memory (the student can
// see and delete it in Settings).
import type { SupabaseClient } from "@supabase/supabase-js";

export const STYLES = {
  "": "No preference",
  step_by_step: "Step by step",
  concise: "Short and direct",
  examples: "Lots of examples",
  intuition: "Intuition first, then the math",
  socratic: "Guide me with questions",
} as const;
export const LENGTHS = { "": "Let the AI decide", short: "Short", medium: "Medium", detailed: "Detailed" } as const;
export type StyleKey = keyof typeof STYLES;
export type LengthKey = keyof typeof LENGTHS;

export type Profile = {
  display_name: string; program: string; level: string; style: StyleKey; length: LengthKey;
  about: string; instructions: string; memory_enabled: boolean;
};
export type Memory = { id: string; content: string; source: "student" | "ai"; created_at: string };

export const LIMITS = { display_name: 60, program: 120, level: 40, about: 1500, instructions: 1500, memory: 300, memories: 100 };
export const emptyProfile = (): Profile => ({ display_name: "", program: "", level: "", style: "", length: "", about: "", instructions: "", memory_enabled: false });

/** Only known fields, trimmed to their limits. */
export function cleanProfile(input: unknown): Profile {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (k: keyof typeof LIMITS) => (typeof o[k] === "string" ? (o[k] as string).trim().slice(0, LIMITS[k]) : "");
  return {
    display_name: str("display_name"), program: str("program"), level: str("level"),
    style: (typeof o.style === "string" && o.style in STYLES ? o.style : "") as StyleKey,
    length: (typeof o.length === "string" && o.length in LENGTHS ? o.length : "") as LengthKey,
    about: str("about"), instructions: str("instructions"), memory_enabled: o.memory_enabled === true,
  };
}

const STYLE_TEXT: Record<StyleKey, string> = {
  "": "",
  step_by_step: "Explain step by step, numbering the steps.",
  concise: "Be short and direct; skip background unless asked.",
  examples: "Use concrete, worked examples to explain ideas.",
  intuition: "Give the intuition first in plain words, then the formal version or math.",
  socratic: "When they're learning something, guide them with questions before giving the full answer (still answer directly if they ask).",
};
const LENGTH_TEXT: Record<LengthKey, string> = { "": "", short: "Keep answers short (a few sentences) unless asked for more.", medium: "Keep answers to a moderate length.", detailed: "Give thorough, detailed answers." };

/** Profile, then memories. Course instructions (more specific) come later in the prompt and win if they conflict. */
export function personalPrompt(p: Profile | null, memories: Memory[]): string {
  const parts: string[] = [];
  if (p) {
    const who = [
      p.display_name && `Name: ${p.display_name}`,
      p.program && `Program: ${p.program}`,
      p.level && `Level: ${p.level}`,
    ].filter(Boolean);
    if (who.length) parts.push(`About the student — ${who.join(". ")}.`);
    if (p.about) parts.push(`What the student wants you to know about them:\n${p.about}`);
    const how = [STYLE_TEXT[p.style], LENGTH_TEXT[p.length]].filter(Boolean);
    if (how.length) parts.push(`Their preferred style: ${how.join(" ")}`);
    if (p.instructions) parts.push(`How they want you to respond:\n${p.instructions}`);
  }
  if (p?.memory_enabled) {
    if (memories.length) parts.push(`Things the student asked you to remember (use when relevant; don't recite them):\n- ${memories.map((m) => m.content).join("\n- ")}`);
    parts.push(
      "Memory is on. When the student asks you to remember something, or states a lasting preference or fact about their studies " +
        "(their courses, goals, how they like explanations), save it by adding a separate line at the very end of your answer: " +
        "[[remember: <one short sentence in third person, e.g. \"Prefers SI units\">]]. Then briefly tell them you'll remember it. " +
        "Never save passwords, health, financial or other sensitive details, and don't save things already in the list above.",
    );
  }
  if (!parts.length) return "";
  return `<student_preferences>\nThese come from the student's settings. Follow them unless they conflict with the course instructions or the student's current request.\n\n${parts.join("\n\n")}\n</student_preferences>`;
}

const MARKER = /\[\[remember:\s*([^\]\n]{1,300})\]\]/gi;

/** Memories the answer saved, and the answer without the marker lines. */
export function parseRemember(text: string): { clean: string; saved: string[] } {
  const saved: string[] = [];
  const clean = text
    .replace(MARKER, (_, m: string) => {
      const s = m.trim().replace(/^["']|["']$/g, "").slice(0, LIMITS.memory);
      if (s) saved.push(s);
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { clean, saved };
}

/** Hide memory markers while streaming (including a half-written one at the end). */
export function hideRememberMarkers(text: string): string {
  return text.replace(MARKER, "").replace(/\[\[(r(e(m(e(m(b(e(r(:[^\]]*)?)?)?)?)?)?)?)?)?$/i, "");
}

/** Profile + memories for the prompt. Works (returns nothing) before migration 0008 is run. */
export async function loadPersonal(supabase: SupabaseClient): Promise<{ profile: Profile | null; memories: Memory[] }> {
  const { data, error } = await supabase.from("profiles").select("display_name, program, level, style, length, about, instructions, memory_enabled").maybeSingle();
  if (error || !data) return { profile: null, memories: [] };
  const profile = cleanProfile(data);
  if (!profile.memory_enabled) return { profile, memories: [] };
  const { data: mem } = await supabase.from("memories").select("id, content, source, created_at").order("created_at", { ascending: false }).limit(LIMITS.memories);
  return { profile, memories: (mem ?? []) as Memory[] };
}

/** Save the AI's new memories (skipping duplicates, keeping at most LIMITS.memories). Returns what was saved. */
export async function saveMemories(supabase: SupabaseClient, userId: string, conversationId: string, existing: Memory[], items: string[]): Promise<Memory[]> {
  const seen = new Set(existing.map((m) => m.content.toLowerCase()));
  const fresh = [...new Set(items)].filter((s) => !seen.has(s.toLowerCase())).slice(0, Math.max(0, LIMITS.memories - existing.length));
  if (!fresh.length) return [];
  const { data } = await supabase
    .from("memories")
    .insert(fresh.map((content) => ({ user_id: userId, content, source: "ai", conversation_id: conversationId })))
    .select("id, content, source, created_at");
  return (data ?? []) as Memory[];
}
