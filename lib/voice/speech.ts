// Read an answer aloud with the browser's own voices (free, nothing sent to a server).
import { toPlainText } from "@/lib/export/export";

/** Answer text → something that sounds right when read out: no citation tags, code or table pipes; simple math words. */
export function spokenText(md: string): string {
  const noCode = md
    .replace(/```[\s\S]*?(?:```|$)/g, "\n(code shown on screen)\n")
    .split("\n")
    .map((l) => {
      if (!/^\s*\|/.test(l)) return l;
      if (/^\s*\|?[\s:|-]+\|?\s*$/.test(l)) return ""; // table separator row
      return l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter(Boolean).join(", ") + ".";
    })
    .join("\n");
  const math = noCode
    .replace(/\\\[|\\\]|\\\(|\\\)|\$\$?/g, " ")
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "$1 over $2")
    .replace(/\\sqrt\{([^{}]*)\}/g, "square root of $1")
    .replace(/\^2\b/g, " squared").replace(/\^3\b/g, " cubed").replace(/\^\{?([^{}\s]+)\}?/g, " to the power $1")
    .replace(/_\{([^{}]*)\}/g, " $1").replace(/\\(times|cdot)/g, " times ").replace(/\\(le|leq)\b/g, " less than or equal to ")
    .replace(/\\(ge|geq)\b/g, " greater than or equal to ").replace(/\\(ne|neq)\b/g, " not equal to ").replace(/\\pm/g, " plus or minus ")
    .replace(/\\([a-zA-Z]+)/g, " $1 ").replace(/[{}]/g, "");
  return toPlainText(math)
    .replace(/\s?\[[SW]\d+\]/g, "")
    .replace(/^•\s*/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ +([,.;:!?])/g, "$1")
    .replace(/^ +| +$/gm, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Short pieces (some browsers stop long utterances part-way). */
export function speechChunks(text: string, max = 220): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    let s = sentence.trim();
    while (s.length > max) {
      const cut = s.lastIndexOf(" ", max) > 40 ? s.lastIndexOf(" ", max) : max;
      out.push(s.slice(0, cut));
      s = s.slice(cut).trim();
    }
    if (s) out.push(s);
  }
  return out;
}
