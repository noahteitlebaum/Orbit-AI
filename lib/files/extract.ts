// Turn an uploaded document into searchable passages that keep their place (page, slide, sheet).
// PDF → per page · PowerPoint → per slide · Excel/CSV → per sheet, as rows · Word/text/code/notebooks → numbered parts.
// Images have no text: they go to vision models. Nothing visual is silently dropped: PDF pages that are scanned or
// carry diagrams are listed in `visualPages` (read as page images, see lib/chat/material.ts), and pictures inside
// Word/PowerPoint/Excel files are counted so the student and the model are told.

export type DocKind = "pdf" | "docx" | "pptx" | "sheet" | "notebook" | "text";
const OOXML = "application/vnd.openxmlformats-officedocument";
export const DOC_TYPES: Record<string, DocKind> = {
  "application/pdf": "pdf",
  [`${OOXML}.wordprocessingml.document`]: "docx",
  [`${OOXML}.presentationml.presentation`]: "pptx",
  [`${OOXML}.spreadsheetml.sheet`]: "sheet",
  "text/csv": "sheet",
  "text/tab-separated-values": "sheet",
  "application/x-ipynb+json": "notebook",
  "text/plain": "text",
  "text/markdown": "text",
};
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export const MAX_DOC_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // the strictest provider limit (Anthropic); the browser shrinks bigger photos
export const MAX_PAGES = 400;
const MAX_SHEET_ROWS = 5_000; // per sheet
const MAX_TEXT_CHARS = 2_000_000;

const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: `${OOXML}.wordprocessingml.document`,
  pptx: `${OOXML}.presentationml.presentation`,
  xlsx: `${OOXML}.spreadsheetml.sheet`,
  xlsm: `${OOXML}.spreadsheetml.sheet`,
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  ipynb: "application/x-ipynb+json",
  md: "text/markdown",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};
// Plain-text formats students upload (notes, code, data, LaTeX…). Anything else that turns out to be text works too.
export const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "rtf", "tex", "bib", "json", "xml", "yaml", "yml", "toml", "ini", "log", "html", "htm", "css",
  "js", "jsx", "ts", "tsx", "mjs", "py", "r", "rmd", "qmd", "m", "java", "kt", "c", "h", "cpp", "hpp", "cc", "cs", "go", "rs",
  "rb", "php", "swift", "scala", "sql", "sh", "bat", "ps1", "pl", "lua", "jl", "hs", "asm", "s", "v", "vhd", "sas", "do",
  "stata", "srt", "vtt",
]);
/** Formats we name explicitly when refusing, with what to do instead. */
export const UNSUPPORTED_HINTS: Record<string, string> = {
  doc: "Old Word files (.doc) aren't supported. Save it as .docx or PDF.",
  ppt: "Old PowerPoint files (.ppt) aren't supported. Save it as .pptx or PDF.",
  xls: "Old Excel files (.xls) aren't supported. Save it as .xlsx or CSV.",
  heic: "iPhone photos (HEIC) aren't supported in this browser. Share it as a JPG or take a screenshot.",
  heif: "iPhone photos (HEIF) aren't supported in this browser. Share it as a JPG or take a screenshot.",
  pages: "Apple Pages files aren't supported. Export it as PDF or Word.",
  key: "Keynote files aren't supported. Export it as PDF or PowerPoint.",
  numbers: "Apple Numbers files aren't supported. Export it as Excel or CSV.",
  odt: "OpenDocument files aren't supported. Save it as .docx or PDF.",
  zip: "Zip files can't be read. Unzip it and upload the files inside.",
};

/** Browsers often send an empty or generic type; the file extension decides. */
export function detectMime(name: string, type: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (EXT_MIME[ext]) return EXT_MIME[ext];
  if (TEXT_EXTS.has(ext)) return "text/plain";
  if (type && (DOC_TYPES[type] || IMAGE_TYPES.has(type))) return type;
  if (type.startsWith("text/")) return "text/plain";
  return type || "application/octet-stream";
}

/** True if the bytes are readable text (no NUL bytes, mostly valid UTF-8): lets unknown text formats through. */
export function looksLikeText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 8000);
  if (head.includes(0)) return false;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(head);
  const bad = (text.match(/\uFFFD/g) ?? []).length;
  return bad <= Math.max(2, text.length / 200);
}

export interface Extracted {
  status: "ready" | "needs_ocr"; // needs_ocr = scanned: no text layer, only readable as page images
  pageCount: number | null;
  chunks: { page: number | null; chunkIndex: number; content: string }[];
  charCount: number;
  visualPages: number[]; // PDF pages that are scanned or have a diagram/picture the text doesn't capture
  imageCount: number;    // pictures inside a Word/PowerPoint/Excel file (not readable from its text)
}

const MIN_PAGE_CHARS = 40;     // fewer than this = a scanned or picture-only page
const MIN_IMAGE_SHARE = 0.08;  // a picture covering ≥8% of the page is content, not a logo
const MIN_DRAWING_OPS = 60;    // this many vector shapes = a chart or diagram (tables use fewer)

/** Which pages need to be looked at, not just read: little text, a sizeable picture, or a vector drawing. */
async function findVisualPages(pdf: Awaited<ReturnType<typeof import("unpdf").getDocumentProxy>>, pages: { page: number; text: string }[]): Promise<number[]> {
  const { getResolvedPDFJS } = await import("unpdf");
  const { OPS } = await getResolvedPDFJS();
  const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObject]);
  const out: number[] = [];
  for (const { page, text } of pages) {
    if (text.length < MIN_PAGE_CHARS) {
      out.push(page);
      continue;
    }
    const p = await pdf.getPage(page);
    const [x0, y0, x1, y1] = p.view;
    const pageArea = Math.abs((x1 - x0) * (y1 - y0)) || 1;
    const { fnArray, argsArray } = await p.getOperatorList();
    // Track the current transform so each picture's drawn size is known (a picture is a unit square scaled by it).
    let m = [1, 0, 0, 1, 0, 0];
    const stack: number[][] = [];
    let imageArea = 0;
    let drawings = 0;
    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i];
      if (fn === OPS.save) stack.push(m);
      else if (fn === OPS.restore) m = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform) {
        const [a, b, c, d, e, f] = argsArray[i] as number[];
        m = [a * m[0] + b * m[2], a * m[1] + b * m[3], c * m[0] + d * m[2], c * m[1] + d * m[3], e * m[0] + f * m[2] + m[4], e * m[1] + f * m[3] + m[5]];
      } else if (imageOps.has(fn)) imageArea += Math.abs(m[0] * m[3] - m[1] * m[2]);
      else if (fn === OPS.constructPath) drawings++;
    }
    p.cleanup();
    if (imageArea / pageArea >= MIN_IMAGE_SHARE || drawings >= MIN_DRAWING_OPS) out.push(page);
  }
  return out;
}

/** Count pictures inside an Office file (word/media, ppt/media, xl/media in the zip's central directory). */
export function officeImageCount(bytes: Uint8Array): number {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return 0;
  let p = b.readUInt32LE(eocd + 16);
  let count = 0;
  for (let n = b.readUInt16LE(eocd + 10); n > 0 && p + 46 <= b.length && b.readUInt32LE(p) === 0x02014b50; n--) {
    const nameLen = b.readUInt16LE(p + 28);
    const name = b.toString("utf8", p + 46, p + 46 + nameLen);
    if (/^(word|ppt|xl)\/media\//.test(name) && /\.(png|jpe?g|gif|bmp|tiff?|emf|wmf|svg|webp)$/i.test(name)) count++;
    p += 46 + nameLen + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
  }
  return count;
}
/** @deprecated name kept for tests */
export const docxImageCount = officeImageCount;

const xmlText = (xml: string) =>
  xml.replace(/<a:br\/>/g, "\n").replace(/<\/a:p>/g, "\n").replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** PowerPoint: text of each slide (and its speaker notes), in slide order. */
async function pptxSlides(bytes: Uint8Array): Promise<{ page: number; text: string; visual: boolean }[]> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  const num = (n: string) => Number(/(\d+)\.xml$/.exec(n)?.[1] ?? 0);
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b));
  const out: { page: number; text: string; visual: boolean }[] = [];
  for (const name of slides) {
    const n = num(name);
    const xml = await zip.file(name)!.async("string");
    const body = clean(xmlText(xml));
    // A picture, chart or diagram on the slide: its content isn't in the text.
    const visual = /<p:pic\b|<c:chart\b|<dgm:relIds\b/.test(xml);
    const notesFile = zip.file(`ppt/notesSlides/notesSlide${n}.xml`);
    const notes = notesFile ? clean(xmlText(await notesFile.async("string"))).replace(/^\d+$/m, "").trim() : "";
    out.push({ page: n, text: [body, notes && `Speaker notes: ${notes}`].filter(Boolean).join("\n\n"), visual });
  }
  return out;
}

/** Excel/CSV: each sheet as "Sheet: name" followed by rows of cells separated by " | ". Formulas give their result. */
async function sheetTexts(bytes: Uint8Array, mime: string): Promise<{ name: string; text: string; truncated: boolean }[]> {
  if (mime === "text/csv" || mime === "text/tab-separated-values") {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const rows = parseDelimited(text, mime === "text/csv" ? "," : "\t");
    return [{ name: "Sheet1", text: rows.slice(0, MAX_SHEET_ROWS).map((r, i) => `Row ${i + 1}: ${r.join(" | ")}`).join("\n"), truncated: rows.length > MAX_SHEET_ROWS }];
  }
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  const out: { name: string; text: string; truncated: boolean }[] = [];
  wb.eachSheet((ws) => {
    const lines: string[] = [];
    let truncated = false;
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (lines.length >= MAX_SHEET_ROWS) {
        truncated = true;
        return;
      }
      const cells = (row.values as unknown[]).slice(1).map(cellText);
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      if (cells.length) lines.push(`Row ${n}: ${cells.join(" | ")}`);
    });
    out.push({ name: ws.name, text: lines.join("\n"), truncated });
  });
  return out;
}

function cellText(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as { result?: unknown; text?: unknown; richText?: { text: string }[]; hyperlink?: string; error?: string; formula?: string };
    if (o.richText) return o.richText.map((r) => r.text).join("");
    if (o.result !== undefined) return cellText(o.result);
    if (o.text !== undefined) return cellText(o.text);
    if (o.error) return String(o.error);
    if (o.formula) return `=${o.formula}`;
    return "";
  }
  return String(v).replace(/\s+/g, " ").trim();
}

/** Minimal CSV/TSV parser (quoted fields, escaped quotes, newlines in quotes). */
export function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === sep) {
      row.push(cell.trim());
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

/** Jupyter notebook: markdown and code cells in order (outputs left out). */
function notebookText(bytes: Uint8Array): string {
  const nb = JSON.parse(new TextDecoder().decode(bytes)) as { cells?: { cell_type?: string; source?: string | string[] }[] };
  return (nb.cells ?? [])
    .map((c, i) => {
      const src = Array.isArray(c.source) ? c.source.join("") : c.source ?? "";
      return c.cell_type === "code" ? `[Cell ${i + 1}, code]\n${src}` : `[Cell ${i + 1}]\n${src}`;
    })
    .join("\n\n");
}

export async function extractDocument(bytes: Uint8Array, mime: string): Promise<Extracted> {
  const type = DOC_TYPES[mime] ?? (looksLikeText(bytes) ? "text" : undefined);
  const none = { visualPages: [] as number[], imageCount: 0 };
  if (type === "pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    // pdf.js takes over (empties) the buffer it's given, so give it a copy: the caller still needs the bytes.
    const pdf = await getDocumentProxy(bytes.slice());
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    if (totalPages > MAX_PAGES) throw new Error(`too_many_pages`);
    const pages = (text as string[]).map((t, i) => ({ page: i + 1, text: clean(t) }));
    const chars = pages.reduce((n, p) => n + p.text.length, 0);
    // Scanned PDFs are pictures of text: almost nothing to extract. Say so instead of silently missing it.
    const status = totalPages > 0 && chars / totalPages < MIN_PAGE_CHARS ? "needs_ocr" : "ready";
    const visualPages = await findVisualPages(pdf, pages);
    return { status, pageCount: totalPages, chunks: chunkPages(pages), charCount: chars, visualPages, imageCount: 0 };
  }
  if (type === "docx") {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    const text = clean(value);
    return { status: "ready", pageCount: null, chunks: chunkPages([{ page: null, text }]), charCount: text.length, visualPages: [], imageCount: officeImageCount(bytes) };
  }
  if (type === "pptx") {
    const slides = await pptxSlides(bytes);
    if (slides.length > MAX_PAGES) throw new Error("too_many_pages");
    const chars = slides.reduce((n, p) => n + p.text.length, 0);
    // visualPages = slides with pictures/charts. They can't be shown to the model (no slide images), so it's told.
    return { status: "ready", pageCount: slides.length, chunks: chunkPages(slides), charCount: chars, visualPages: slides.filter((s) => s.visual).map((s) => s.page), imageCount: 0 };
  }
  if (type === "sheet") {
    const sheets = await sheetTexts(bytes, mime);
    // Each sheet's rows are split into passages that start with the sheet name, so a passage is never orphaned.
    const parts = sheets.flatMap((sh) => {
      const header = `Sheet: ${sh.name}${sh.truncated ? ` (first ${MAX_SHEET_ROWS} rows only)` : ""}`;
      return chunkPages([{ page: null, text: sh.text || "(empty sheet)" }]).map((c) => `${header}\n${c.content}`);
    });
    const chunks = parts.map((content, chunkIndex) => ({ page: null, chunkIndex, content }));
    const chars = parts.reduce((n, p) => n + p.length, 0);
    return { status: "ready", pageCount: sheets.length, chunks, charCount: chars, visualPages: [], imageCount: mime.includes("spreadsheetml") ? officeImageCount(bytes) : 0 };
  }
  if (type === "notebook") {
    const text = clean(notebookText(bytes));
    return { status: "ready", pageCount: null, chunks: chunkPages([{ page: null, text }]), charCount: text.length, ...none };
  }
  if (type === "text") {
    const text = clean(new TextDecoder("utf-8", { fatal: false }).decode(bytes)).slice(0, MAX_TEXT_CHARS);
    return { status: "ready", pageCount: null, chunks: chunkPages([{ page: null, text }]), charCount: text.length, ...none };
  }
  throw new Error("unsupported_type");
}

function clean(t: string): string {
  return t.replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const TARGET = 1400; // characters per passage (~350 tokens)

/** Split each page into passages of ~TARGET chars at paragraph/sentence breaks. Passages never cross pages. */
export function chunkPages(pages: { page: number | null; text: string }[]) {
  const out: { page: number | null; chunkIndex: number; content: string }[] = [];
  for (const { page, text } of pages) {
    if (!text) continue;
    let rest = text;
    while (rest.length > 0) {
      if (rest.length <= TARGET * 1.3) {
        out.push({ page, chunkIndex: out.length, content: rest });
        break;
      }
      const window = rest.slice(0, TARGET);
      const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "), window.lastIndexOf("\n"));
      const at = cut > TARGET * 0.5 ? cut + 1 : TARGET;
      out.push({ page, chunkIndex: out.length, content: rest.slice(0, at).trim() });
      rest = rest.slice(at).trim();
    }
  }
  return out;
}

/** "lecture3.pdf, p. 4", "week2.pptx, slide 4" or "notes.docx, part 2" — what students see next to an answer. */
export function referenceLabel(fileName: string, page: number | null, chunkIndex: number): string {
  if (page == null) return `${fileName}, part ${chunkIndex + 1}`;
  return /\.pptx$/i.test(fileName) ? `${fileName}, slide ${page}` : `${fileName}, p. ${page}`;
}
