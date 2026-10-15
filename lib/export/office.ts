// Office downloads (integration memo #11–12): an answer or a whole chat as Word (.docx), its tables as Excel (.xlsx),
// or its outline as PowerPoint (.pptx). Built in the browser from the same Markdown as the other downloads; the
// libraries load only when a student picks one of these. mdBlocks/slidesFrom are pure and unit-tested.
import { markdownTables } from "./export";

export type Inline = { text: string; bold?: boolean; italic?: boolean; code?: boolean };
export type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "para"; runs: Inline[] }
  | { type: "list"; ordered: boolean; items: { runs: Inline[]; depth: number }[] }
  | { type: "code"; lang: string; text: string }
  | { type: "math"; text: string }
  | { type: "quote"; runs: Inline[] }
  | { type: "table"; rows: string[][] }
  | { type: "rule" };

const plain = (s: string) => s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s?\[[SW]\d+\]/g, "");

/** **bold**, *italic*, `code` → runs (links become their text, citation markers drop). Pure. */
export function inlineRuns(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /(\*\*|__)(.+?)\1|(?<![*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\*)|`([^`]+)`/g;
  const src = plain(text);
  let at = 0;
  for (const m of src.matchAll(re)) {
    if (m.index! > at) out.push({ text: src.slice(at, m.index) });
    if (m[2] != null) out.push({ text: m[2], bold: true });
    else if (m[3] != null) out.push({ text: m[3], italic: true });
    else out.push({ text: m[4], code: true });
    at = m.index! + m[0].length;
  }
  if (at < src.length) out.push({ text: src.slice(at) });
  return out.filter((r) => r.text);
}
export const runsText = (runs: Inline[]) => runs.map((r) => r.text).join("");

/** Markdown → simple blocks for Word and PowerPoint. Pure. */
export function mdBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: "para", runs: inlineRuns(para.join(" ")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    const fence = t.match(/^(`{3,}|~{3,})\s*([\w+-]*)/);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      blocks.push({ type: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }
    if (t.startsWith("$$")) {
      flush();
      const body = [t.slice(2)];
      if (!(t.length > 2 && t.endsWith("$$"))) for (i++; i < lines.length && !lines[i].includes("$$"); i++) body.push(lines[i]);
      if (i < lines.length && !(t.length > 2 && t.endsWith("$$"))) body.push(lines[i].replace("$$", ""));
      blocks.push({ type: "math", text: body.join("\n").replace(/\$\$/g, "").trim() });
      continue;
    }
    if (!t) { flush(); continue; }
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flush(); blocks.push({ type: "heading", level: Math.min(3, h[1].length) as 1 | 2 | 3, text: plain(h[2]).replace(/[*_`]/g, "") }); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flush(); blocks.push({ type: "rule" }); continue; }
    if (t.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flush();
      const chunk = [line, lines[i + 1]];
      for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) chunk.push(lines[i]);
      i--;
      const rows = markdownTables(chunk.join("\n"))[0];
      if (rows) blocks.push({ type: "table", rows: rows.map((r) => r.map(plain)) });
      continue;
    }
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]);
      const item = { runs: inlineRuns(li[3].replace(/^\[( |x)\]\s*/i, (_, x: string) => (x.trim() ? "☑ " : "☐ "))), depth: Math.min(2, Math.floor(li[1].replace(/\t/g, "  ").length / 2)) };
      const last = blocks.at(-1);
      if (last?.type === "list" && (last.ordered === ordered || item.depth > 0)) last.items.push(item);
      else blocks.push({ type: "list", ordered, items: [item] });
      continue;
    }
    if (t.startsWith(">")) { flush(); blocks.push({ type: "quote", runs: inlineRuns(t.replace(/^>\s?/, "")) }); continue; }
    para.push(t);
  }
  flush();
  return blocks;
}

// ---------------------------------------------------------------- PowerPoint outline
export type Slide = { title: string; bullets: { text: string; depth: number }[]; table?: string[][]; code?: string };
const MAX_BULLETS = 7;
const clipText = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Blocks → slides: a slide per heading, long sections split, tables and code on their own slides. Pure. */
export function slidesFrom(title: string, blocks: Block[]): Slide[] {
  const slides: Slide[] = [];
  let cur: Slide | null = null;
  const start = (t: string) => { cur = { title: t, bullets: [] }; slides.push(cur); return cur; };
  const add = (text: string, depth = 0) => {
    const s: Slide = cur ?? start(title);
    if (s.bullets.length >= MAX_BULLETS || s.table || s.code) start(`${s.title.replace(/ \(cont\.\)$/, "")} (cont.)`);
    cur!.bullets.push({ text: clipText(text), depth });
  };
  for (const b of blocks) {
    if (b.type === "heading") start(b.text);
    else if (b.type === "para" || b.type === "quote") {
      // Long paragraphs become one bullet per sentence.
      const t = runsText(b.runs);
      for (const s of t.length > 220 ? t.split(/(?<=[.!?])\s+(?=[A-Z0-9])/) : [t]) add(s);
    } else if (b.type === "list") b.items.forEach((it) => add(runsText(it.runs), it.depth));
    else if (b.type === "math") add(b.text);
    else if (b.type === "table") {
      const head: string = (cur as Slide | null)?.title ?? title;
      if (cur && ((cur as Slide).bullets.length || (cur as Slide).table || (cur as Slide).code)) start(head);
      (cur ?? start(head)).table = b.rows.slice(0, 12).map((r) => r.slice(0, 6).map((c) => clipText(c, 60)));
    } else if (b.type === "code") {
      const head: string = (cur as Slide | null)?.title ?? title;
      if (cur && ((cur as Slide).bullets.length || (cur as Slide).table || (cur as Slide).code)) start(head);
      (cur ?? start(head)).code = b.text.split("\n").slice(0, 18).join("\n");
    }
  }
  return slides.filter((s) => s.bullets.length || s.table || s.code);
}

// ---------------------------------------------------------------- builders (browser)
function saveBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function docxBlob(title: string, md: string): Promise<Blob> {
  const d = await import("docx");
  const runs = (rs: Inline[]) => rs.map((r) => new d.TextRun({ text: r.text, bold: r.bold, italics: r.italic, ...(r.code ? { font: "Consolas", shading: { type: d.ShadingType.CLEAR, fill: "F1F1EF", color: "auto" } } : {}) }));
  const HEAD = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3];
  const children: (InstanceType<typeof d.Paragraph> | InstanceType<typeof d.Table>)[] = [new d.Paragraph({ text: title, heading: d.HeadingLevel.TITLE })];
  for (const b of mdBlocks(md)) {
    if (b.type === "heading") children.push(new d.Paragraph({ text: b.text, heading: HEAD[b.level - 1] }));
    else if (b.type === "para") children.push(new d.Paragraph({ children: runs(b.runs), spacing: { after: 120 } }));
    else if (b.type === "quote") children.push(new d.Paragraph({ children: runs(b.runs), indent: { left: 480 }, border: { left: { style: d.BorderStyle.SINGLE, size: 12, color: "BBBBBB", space: 8 } } }));
    else if (b.type === "list") for (const it of b.items) children.push(new d.Paragraph({ children: runs(it.runs), ...(b.ordered ? { numbering: { reference: "num", level: it.depth } } : { bullet: { level: it.depth } }) }));
    else if (b.type === "code" || b.type === "math")
      for (const l of b.text.split("\n")) children.push(new d.Paragraph({ children: [new d.TextRun({ text: l || " ", font: b.type === "code" ? "Consolas" : "Cambria Math", size: 20 })], shading: { type: d.ShadingType.CLEAR, fill: "F6F6F4", color: "auto" } }));
    else if (b.type === "rule") children.push(new d.Paragraph({ border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: "CCCCCC", space: 1 } } }));
    else if (b.type === "table") {
      const cols = Math.max(...b.rows.map((r) => r.length));
      children.push(new d.Table({
        width: { size: 100, type: d.WidthType.PERCENTAGE },
        rows: b.rows.map((r, ri) => new d.TableRow({
          tableHeader: ri === 0,
          children: Array.from({ length: cols }, (_, ci) => new d.TableCell({
            children: [new d.Paragraph({ children: [new d.TextRun({ text: r[ci] ?? "", bold: ri === 0 })] })],
            ...(ri === 0 ? { shading: { type: d.ShadingType.CLEAR, fill: "EFEFEC", color: "auto" } } : {}),
          })),
        })),
      }), new d.Paragraph({ text: "" }));
    }
  }
  const doc = new d.Document({
    creator: "Orbit", title,
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    numbering: { config: [{ reference: "num", levels: [0, 1, 2].map((level) => ({ level, format: d.LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: d.AlignmentType.START, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } })) }] },
    sections: [{ children }],
  });
  return d.Packer.toBlob(doc);
}

const NUM = /^-?\$?\d{1,3}(,\d{3})*(\.\d+)?%?$|^-?\$?\d+(\.\d+)?%?$/;
export async function xlsxBlob(tables: string[][][]): Promise<Blob> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Orbit";
  tables.forEach((rows, i) => {
    const ws = wb.addWorksheet(tables.length === 1 ? "Table" : `Table ${i + 1}`);
    rows.forEach((r, ri) => {
      ws.addRow(r.map((c) => {
        if (ri === 0 || !NUM.test(c.trim())) return c;
        const n = Number(c.replace(/[$,%]/g, ""));
        return c.trim().endsWith("%") ? n / 100 : n;
      }));
      if (ri > 0) r.forEach((c, ci) => c.trim().endsWith("%") && NUM.test(c.trim()) && (ws.getRow(ri + 1).getCell(ci + 1).numFmt = "0.##%"));
    });
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEC" } };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    ws.columns.forEach((col, ci) => (col.width = Math.min(60, Math.max(8, ...rows.map((r) => (r[ci] ?? "").length + 2)))));
  });
  return new Blob([await wb.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export async function pptxBlob(title: string, md: string): Promise<Blob> {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = title;
  const INK = "1F1E1D", MUTED = "6B6A66", ACCENT = "C96442";
  const cover = pptx.addSlide();
  cover.background = { color: "FAF9F5" };
  cover.addShape("rect", { x: 0.6, y: 3.2, w: 1.2, h: 0.08, fill: { color: ACCENT }, line: { color: ACCENT } });
  cover.addText(title, { x: 0.6, y: 1.6, w: 12, h: 1.5, fontSize: 40, bold: true, color: INK, fontFace: "Calibri", valign: "bottom" });
  cover.addText(`Made with Orbit · ${new Date().toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" })}`, { x: 0.6, y: 3.45, w: 12, h: 0.5, fontSize: 14, color: MUTED });
  for (const s of slidesFrom(title, mdBlocks(md))) {
    const sl = pptx.addSlide();
    sl.background = { color: "FFFFFF" };
    sl.addText(s.title, { x: 0.6, y: 0.4, w: 12.1, h: 0.9, fontSize: 28, bold: true, color: INK, fontFace: "Calibri" });
    sl.addShape("rect", { x: 0.6, y: 1.25, w: 0.8, h: 0.05, fill: { color: ACCENT }, line: { color: ACCENT } });
    if (s.table) {
      sl.addTable(s.table.map((r, ri) => r.map((c) => ({ text: c, options: { bold: ri === 0, fill: { color: ri === 0 ? "EFEFEC" : "FFFFFF" } } }))),
        { x: 0.6, y: 1.6, w: 12.1, fontSize: 14, color: INK, border: { type: "solid", color: "D9D8D3", pt: 0.75 }, autoPage: false });
    } else if (s.code) {
      sl.addText(s.code, { x: 0.6, y: 1.6, w: 12.1, h: 5.4, fontFace: "Consolas", fontSize: 13, color: INK, fill: { color: "F6F6F4" }, valign: "top", margin: 12 });
    } else {
      sl.addText(s.bullets.map((b) => ({ text: b.text, options: { bullet: true, indentLevel: b.depth, breakLine: true } })),
        { x: 0.6, y: 1.6, w: 12.1, h: 5.4, fontSize: 20, color: INK, valign: "top", paraSpaceAfter: 8, fontFace: "Calibri" });
    }
  }
  return (await pptx.write({ outputType: "blob" })) as Blob;
}

/** Browser: build and download. */
export async function downloadOffice(kind: "docx" | "xlsx" | "pptx", base: string, title: string, md: string) {
  const blob = kind === "docx" ? await docxBlob(title, md) : kind === "xlsx" ? await xlsxBlob(markdownTables(md)) : await pptxBlob(title, md);
  saveBlob(`${base}.${kind}`, blob);
}
