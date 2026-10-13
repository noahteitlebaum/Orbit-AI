// Downloads of answers and chats: Markdown (equations kept as LaTeX), plain text, and CSV for tables.
// Pure functions (tested in export.test.ts); the browser download itself is saveFile().
import { citationParts, type Source } from "@/components/answer-text";
import { hideQuizMarkers } from "@/lib/chat/quiz";
import { hideRememberMarkers } from "@/lib/profile/personal";

export type ExportRun = { code?: string; stdout?: string; files?: string[] };
export type ExportMessage = { role: "user" | "assistant"; content: string; sources?: Source[]; author?: string; attachments?: string[]; runs?: ExportRun[] };

const tag = (s: Source) => `${s.kind === "web" ? "W" : "S"}${s.n}`;

/** Split text into code (fenced or inline) and prose, so changes never touch code. */
function mapProse(md: string, fn: (prose: string) => string): string {
  return md
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/g)
    .map((part, i) => (i % 2 ? part : fn(part)))
    .join("");
}

/** \( \) and \[ \] become $ $ and $$ $$, which most Markdown apps (Obsidian, Typora, VS Code, Notion) render. */
export function normalizeMath(md: string): string {
  return mapProse(md, (p) =>
    p
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, m: string) => `$$${m.trim()}$$`)
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, m: string) => `$${m.trim()}$`),
  );
}

/** The answer as saved: quiz markers removed, only real citations kept ([S1], [W2]). */
export function cleanAnswer(text: string, sources: Source[] | undefined): string {
  return citationParts(hideRememberMarkers(hideQuizMarkers(text)), sources, true)
    .map((p) => ("text" in p ? p.text : `[${p.web ? "W" : "S"}${p.n}]`))
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function sourcesMarkdown(sources: Source[] | undefined): string {
  if (!sources?.length) return "";
  const files = sources.filter((s) => s.kind !== "web").map((s) => `- [${tag(s)}] ${s.label}`);
  const web = sources.filter((s) => s.kind === "web").map((s) => `- [${tag(s)}] ${s.label}${s.url ? ` — <${s.url}>` : ""}`);
  return [
    files.length ? `**Sources from your files**\n\n${files.join("\n")}` : "",
    web.length ? `**Web sources**\n\n${web.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

function runsMarkdown(runs: ExportRun[] | undefined): string {
  return (runs ?? [])
    .filter((r) => r.code)
    .map((r) => [
      "**Python code**", "```python", r.code!.trimEnd(), "```",
      r.stdout?.trim() ? ["**Output**", "```text", r.stdout.trimEnd(), "```"].join("\n") : "",
      r.files?.length ? `Files made: ${r.files.join(", ")}` : "",
    ].filter(Boolean).join("\n"))
    .join("\n\n");
}

export function answerMarkdown(m: ExportMessage): string {
  return [normalizeMath(cleanAnswer(m.content, m.sources)), runsMarkdown(m.runs), sourcesMarkdown(m.sources)].filter(Boolean).join("\n\n") + "\n";
}

export function chatMarkdown(title: string, messages: ExportMessage[], date = new Date()): string {
  const parts = [`# ${title || "Chat"}`, `_Exported ${date.toISOString().slice(0, 10)}_`];
  for (const m of messages) {
    if (m.role === "user") {
      const files = m.attachments?.length ? `\n\n_Attached: ${m.attachments.join(", ")}_` : "";
      parts.push(`## You\n\n${normalizeMath(m.content.trim())}${files}`);
    } else if (m.content.trim() || m.runs?.length) {
      parts.push(`## ${m.author ?? "AI"}\n\n${answerMarkdown(m).trim()}`);
    }
  }
  return parts.join("\n\n") + "\n";
}

/** Markdown → readable plain text. Equations stay as LaTeX source; links show their address. */
export function toPlainText(md: string): string {
  return md
    .split(/(```[\s\S]*?(?:```|$))/g)
    .map((part, i) => {
      if (i % 2) return part.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "");
      return part
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/^\s*>\s?/gm, "")
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1$2")
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1 ($2)")
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
        .replace(/<(https?:[^>]+)>/g, "$1")
        .replace(/`([^`\n]+)`/g, "$1")
        .replace(/^\s*[-*+]\s+/gm, "• ")
        .replace(/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, "")
        .replace(/\n{3,}/g, "\n\n");
    })
    .join("")
    .trim() + "\n";
}

const SEP = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|").replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/`([^`]+)`/g, "$1").replace(/<br\s*\/?>/gi, " "));
}

/** Every Markdown table in the text (outside code blocks), as rows of cells, header first. */
export function markdownTables(md: string): string[][][] {
  const lines = md.replace(/```[\s\S]*?(?:```|$)/g, "").split("\n");
  const tables: string[][][] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].includes("|") || !SEP.test(lines[i + 1].trim())) continue;
    const rows = [cells(lines[i])];
    let j = i + 2;
    for (; j < lines.length && lines[j].includes("|") && lines[j].trim(); j++) rows.push(cells(lines[j]));
    tables.push(rows);
    i = j - 1;
  }
  return tables;
}

/** CSV that Excel opens correctly (UTF-8 mark, quoted cells, no formula injection). */
export function toCsv(rows: string[][]): string {
  const cell = (v: string) => {
    let s = v;
    if (/^[=+\-@\t\r]/.test(s) && !/^[-+]?\d[\d,.]*(e[-+]?\d+)?%?$/i.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

export function fileSlug(text: string, fallback = "orbit-answer"): string {
  const s = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/, "");
  return s || fallback;
}

/** Browser only: download text as a file. */
export function saveFile(name: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
