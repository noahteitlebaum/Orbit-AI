import { estimateTokens } from "./context";

const STOP = new Set("the a an and or to of in on for is it this that with my me you your can please what how about from have do".split(" "));
export function keywords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter(w => w.length > 2 && !STOP.has(w)));
}

/** Local lexical retrieval: no external calls, persistent index, or embedding fees. Stable ties prefer recent items. */
export function relevant<T>(items: T[], query: string, text: (item: T) => string, budget: number): T[] {
  const words = keywords(query);
  const ranked = items.map((item, i) => ({ item, i, score: [...keywords(text(item))].filter(w => words.has(w)).length }))
    .filter(r => r.score > 0).sort((a, b) => b.score - a.score || b.i - a.i);
  const kept: typeof ranked = [];
  let used = 0;
  for (const r of ranked) {
    const size = estimateTokens(text(r.item));
    if (used + size > budget) continue;
    used += size;
    kept.push(r);
  }
  return kept.sort((a, b) => a.i - b.i).map(r => r.item);
}
