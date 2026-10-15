// Flashcards from an answer, for Anki and Quizlet (integration memo: "generate and export study materials").
// Both apps import plain text with one card per line and a tab between the front and the back:
//  - Anki: File → Import → choose the .txt (fields separated by Tab).
//  - Quizlet: Create → Import → paste, "Between term and definition: Tab", "Between cards: New line".
import { markdownTables } from "./export";

export type Card = { front: string; back: string };

const clean = (s: string) =>
  s.replace(/\*\*(.+?)\*\*|__(.+?)__/g, "$1$2").replace(/`([^`]+)`/g, "$1").replace(/\s+/g, " ").trim();

/** Cards found in Markdown: 2+ column tables (first two columns), Q:/A: pairs, and "Term: definition" list items. */
export function extractCards(md: string): Card[] {
  const cards: Card[] = [];
  for (const table of markdownTables(md)) {
    if ((table[0]?.length ?? 0) < 2) continue;
    for (const row of table.slice(1)) {
      const [front, back] = [clean(row[0] ?? ""), clean(row[1] ?? "")];
      if (front && back) cards.push({ front, back });
    }
  }
  const text = md.replace(/```[\s\S]*?(?:```|$)/g, "");
  // Q: … A: … (also "Question:" / "Answer:", optionally numbered or bold)
  const qa = /(?:^|\n)\s*(?:\d+[.)]\s*)?\**(?:Q|Question)\s*\d*\**\s*[:.)-]\**\s*([\s\S]+?)\n\s*\**(?:A|Answer)\**\s*[:.)-]\**\s*([\s\S]+?)(?=\n\s*\n|\n\s*(?:\d+[.)]\s*)?\**(?:Q|Question)\b|$)/gi;
  for (const m of text.matchAll(qa)) {
    const [front, back] = [clean(m[1]), clean(m[2])];
    if (front && back) cards.push({ front, back });
  }
  // - **Term**: definition   /   - Term — definition
  for (const m of text.matchAll(/^\s*(?:[-*•]|\d+[.)])\s+(\*\*[^*\n]{1,80}\*\*|[^:\n—–]{1,60}?)\s*(?::|—|–| - )\s+(.{3,})$/gm)) {
    const [front, back] = [clean(m[1]), clean(m[2])];
    if (front && back && !/^(q|a|question|answer)\b/i.test(front)) cards.push({ front, back });
  }
  // Same card twice (e.g. a table and a list of the same terms): keep one.
  const seen = new Set<string>();
  return cards.filter((c) => {
    const k = c.front.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** One card per line, Tab between front and back (tabs/newlines inside a card become spaces). */
export function toFlashcardText(cards: Card[]): string {
  const cell = (s: string) => s.replace(/[\t\r\n]+/g, " ").trim();
  return cards.map((c) => `${cell(c.front)}\t${cell(c.back)}`).join("\n") + "\n";
}
