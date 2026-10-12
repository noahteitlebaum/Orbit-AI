import type { SupabaseClient } from "@supabase/supabase-js";
import { referenceLabel } from "@/lib/files/extract";
import type { TurnDocument, TurnImage } from "@/lib/providers/types";
import { estimateTokens } from "./context";

// Course material for one question: passages from the chat's attachments and its course's files,
// each numbered [S1], [S2]… so the answer can point at exactly what was sent.
// Visual material is never silently skipped: PDF pages that are scanned or carry a diagram are sent as a small PDF of
// just those pages (apps with PDF_INPUT), and anything that can't be shown is named in `notes` for the model.

export type Source = { n: number; fileId: string; fileName: string; page: number | null; label: string; excerpt: string };
type FileRow = {
  id: string; name: string; kind: string; status: string; char_count: number | null; page_count: number | null;
  project_id: string | null; conversation_id: string | null; storage_path: string; mime: string;
  visual_pages?: number[] | null; image_count?: number | null;
};
type ChunkRow = { file_id: string; page: number | null; chunk_index: number; content: string };

export const MATERIAL_TOKEN_BUDGET = 12_000;
const SMALL_FILE_CHARS = 24_000; // attachments this small are sent whole
export const IMAGE_TOKENS = 1_600; // rough cost of one image in the prompt
export const MAX_IMAGES = 4;
export const EXCERPT_CHARS = 600;     // passage text kept with each reference, so students can check it
export const MAX_VISUAL_PAGES = 8;   // PDF pages sent as images per question
export const PAGE_TOKENS = 2_000;    // rough cost of one PDF page read visually (image + text)

export interface Material {
  sources: Source[];
  block: string;         // text added to the system prompt
  unreadable: string[];  // names of files that failed, so the model can say it couldn't read them
  notes: string[];       // visual material that wasn't shown (page limits, Word pictures, no PDF support…)
  documents: TurnDocument[]; // PDF pages to read visually, attached to the question
  images: TurnImage[];   // course images that match the question
  tokens: number;        // text passages + visual pages
  visualTokens: number;  // visual pages + course images only (the passages are counted with the system prompt)
  hasFiles: boolean;
}

export async function gatherMaterial(
  supabase: SupabaseClient,
  opts: {
    conversationId: string; projectId: string | null; question: string; newAttachmentIds: string[]; pdfInput: boolean; imageSlots?: number;
    previousQuestion?: string; // the student's message before this one, for follow-ups like "and the second one?"
  },
): Promise<Material> {
  const cols = "id, name, kind, status, char_count, page_count, project_id, conversation_id, storage_path, mime";
  const load = (extra: string) => {
    const q = supabase.from("files").select(cols + extra);
    return opts.projectId ? q.or(`conversation_id.eq.${opts.conversationId},project_id.eq.${opts.projectId}`) : q.eq("conversation_id", opts.conversationId);
  };
  // visual_pages/image_count come with migration 0005; still works before it's run.
  const first = (await load(", visual_pages, image_count")) as unknown as { data: FileRow[] | null; error: unknown };
  const { data } = first.error ? ((await load("")) as unknown as { data: FileRow[] | null }) : first;
  const all = (data ?? []) as FileRow[];
  const files = all.filter((f) => f.kind === "document");
  const notes: string[] = [];
  const images = await courseImages(supabase, all, opts, notes);
  const ready = files.filter((f) => f.status === "ready" || f.status === "needs_ocr");
  const unreadable = files.filter((f) => f.status === "failed").map((f) => f.name);
  for (const f of ready) {
    if ((f.image_count ?? 0) > 0) notes.push(`${f.name} contains ${f.image_count} picture${f.image_count === 1 ? "" : "s"} (diagrams, figures…) that can't be read from the file; only its text is available. If the question depends on them, ask the student to upload screenshots.`);
    if (f.mime !== "application/pdf" && f.visual_pages?.length) {
      notes.push(`${f.name}: ${f.visual_pages.length === 1 ? `slide ${f.visual_pages[0]} has a picture or chart` : `slides ${f.visual_pages.slice(0, 15).join(", ")}${f.visual_pages.length > 15 ? "…" : ""} have pictures or charts`} that can't be seen here (only slide text is read). If they matter, ask the student to export the slides as PDF and upload that instead.`);
    }
  }
  // The model always knows what the course contains, even when nothing matches this question.
  const courseFiles = opts.projectId ? all.filter((f) => f.project_id === opts.projectId) : [];
  if (courseFiles.length) notes.push(`Files in this course: ${courseIndex(courseFiles)}. If the answer is probably in one of them but nothing below covers it, say which file and ask the student to point to the page or topic.`);
  const imageTokens = images.length * IMAGE_TOKENS;
  const empty = { sources: [], block: "", unreadable, notes, documents: [], images, tokens: imageTokens, visualTokens: imageTokens, hasFiles: all.length > 0 };
  if (!ready.length) return empty;

  const byId = new Map(ready.map((f) => [f.id, f]));
  const picked: ChunkRow[] = [];
  const seen = new Set<string>();
  let tokens = 0;
  const take = (c: ChunkRow) => {
    const key = `${c.file_id}:${c.chunk_index}`;
    if (seen.has(key)) return true;
    const t = estimateTokens(c.content);
    if (tokens + t > MATERIAL_TOKEN_BUDGET) return false;
    seen.add(key);
    picked.push(c);
    tokens += t;
    return true;
  };

  // 1. Small chat attachments are sent whole (newest first) — "summarize this" has no keywords to search for.
  const small = ready
    .filter((f) => f.conversation_id === opts.conversationId && (f.char_count ?? 0) <= SMALL_FILE_CHARS)
    .sort((a, b) => Number(opts.newAttachmentIds.includes(b.id)) - Number(opts.newAttachmentIds.includes(a.id)));
  for (const f of small) {
    const { data: chunks } = await supabase.from("file_chunks").select("file_id, page, chunk_index, content").eq("file_id", f.id).order("chunk_index");
    for (const c of (chunks ?? []) as ChunkRow[]) if (!take(c)) break;
  }

  // 2. Files the question names ("lecture 3", "the assignment 2 spec", "page 12 of week4.pdf"): that page,
  //    else the best matches in that file, else its opening passages.
  const searchIds = ready.filter((f) => !small.includes(f)).map((f) => f.id);
  const named = namedFiles(opts.question, ready.filter((f) => !small.includes(f)));
  const pages = mentionedPages(opts.question);
  for (const f of named) {
    let rows: ChunkRow[] = [];
    if (pages.length) {
      const { data: d } = await supabase.from("file_chunks").select("file_id, page, chunk_index, content").eq("file_id", f.id).in("page", pages).order("chunk_index");
      rows = (d ?? []) as ChunkRow[];
    }
    if (!rows.length) {
      const { data: d } = await supabase.rpc("search_chunks", { p_query: opts.question, p_file_ids: [f.id], p_limit: 6 });
      rows = (d ?? []) as ChunkRow[];
    }
    if (!rows.length) {
      const { data: d } = await supabase.from("file_chunks").select("file_id, page, chunk_index, content").eq("file_id", f.id).order("chunk_index").limit(4);
      rows = (d ?? []) as ChunkRow[];
    }
    for (const c of rows) if (!take(c)) break;
  }

  // 3. Keyword search across the rest (course files and big attachments). A follow-up with no keywords of its own
  //    ("what about the second one?") searches with the previous question too.
  if (searchIds.length && opts.question.trim()) {
    const search = async (q: string) => ((await supabase.rpc("search_chunks", { p_query: q, p_file_ids: searchIds, p_limit: 10 })).data ?? []) as ChunkRow[];
    let hits = await search(opts.question);
    if (!hits.length && opts.previousQuestion?.trim()) hits = await search(`${opts.previousQuestion}\n${opts.question}`);
    for (const c of hits) if (!take(c)) break;
  }

  // 4. A big file attached just now with no keyword hits: send its opening passages so the model sees it.
  for (const id of opts.newAttachmentIds) {
    if (!byId.has(id) || picked.some((c) => c.file_id === id)) continue;
    const { data: chunks } = await supabase.from("file_chunks").select("file_id, page, chunk_index, content").eq("file_id", id).order("chunk_index").limit(6);
    for (const c of (chunks ?? []) as ChunkRow[]) if (!take(c)) break;
  }

  // Keep document order within each file so passages read naturally.
  picked.sort((a, b) => (a.file_id === b.file_id ? a.chunk_index - b.chunk_index : 0));
  const sources: Source[] = picked.map((c, i) => {
    const f = byId.get(c.file_id)!;
    return { n: i + 1, fileId: c.file_id, fileName: f.name, page: c.page, label: referenceLabel(f.name, c.page, c.chunk_index), excerpt: c.content.slice(0, EXCERPT_CHARS) };
  });
  const blocks = picked.map((c, i) => `[S${i + 1}] ${sources[i].label}\n${c.content}`);

  // Visual pages: scanned pages and pages with diagrams/pictures, from the files this question touches.
  const wanted = pickVisualPages(ready, picked, small, opts);
  const documents: TurnDocument[] = [];
  let visualTokens = 0;
  for (const { file, pages, skipped } of wanted) {
    if (skipped.length) notes.push(`${file.name}: ${describePages(skipped)} ${skipped.length === 1 ? "is a scanned/diagram page" : "are scanned/diagram pages"} that weren't included this time (a few pages per question). If they matter, ask the student which pages to look at.`);
    if (!pages.length) continue;
    if (!opts.pdfInput) {
      notes.push(`${file.name}: ${describePages(pages)} ${pages.length === 1 ? "is a scanned page or diagram" : "are scanned pages or diagrams"} this app can't see (it can't read PDFs visually). Say so if it matters, and suggest uploading screenshots of those pages.`);
      continue;
    }
    const pdf = await pagesAsPdf(supabase, file, pages);
    if (!pdf) {
      notes.push(`${file.name}: ${describePages(pages)} couldn't be prepared as images (the PDF may be protected).`);
      continue;
    }
    const docName = `${file.name} (pages ${pages.join(", ")})`;
    documents.push({ name: docName, mime: "application/pdf", data: pdf });
    visualTokens += pages.length * PAGE_TOKENS;
    pages.forEach((page, i) => {
      const n = sources.length + 1;
      sources.push({ n, fileId: file.id, fileName: file.name, page, label: `${file.name}, p. ${page}`, excerpt: "(page read as an image)" });
      blocks.push(`[S${n}] ${file.name}, p. ${page}\nShown as page ${i + 1} of the attached PDF "${docName}" (a scanned page or one with a diagram/picture). Read it there; cite it as [S${n}].`);
    });
  }
  visualTokens += imageTokens;
  return { sources, block: blocks.join("\n\n"), unreadable, notes, documents, images, tokens: tokens + visualTokens, visualTokens, hasFiles: true };
}

/** "lecture3.pdf (24 pages), syllabus.docx, …" — what the course holds, for the model. */
function courseIndex(files: FileRow[]): string {
  const shown = files.slice(0, 40).map((f) => {
    const n = f.page_count;
    const unit = /\.pptx$/i.test(f.name) ? "slide" : /\.(xlsx|xlsm|csv|tsv)$/i.test(f.name) ? "sheet" : "page";
    const state = f.status === "failed" ? ", couldn't be read" : f.kind === "image" ? ", image" : "";
    return `${f.name}${n ? ` (${n} ${unit}${n === 1 ? "" : "s"}${state})` : state ? ` (${state.slice(2)})` : ""}`;
  });
  return shown.join(", ") + (files.length > shown.length ? `, and ${files.length - shown.length} more` : "");
}

// Words in file names that don't identify a file.
const GENERIC = new Set(["pdf", "docx", "pptx", "xlsx", "csv", "txt", "final", "copy", "the", "and", "for", "notes", "file", "version", "draft"]);
/** Lowercase words and numbers, splitting "lecture3" into "lecture" + "3". */
export function nameTokens(text: string): string[] {
  return text.toLowerCase().replace(/([a-z])(\d)/g, "$1 $2").replace(/(\d)([a-z])/g, "$1 $2").split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Files the question refers to by name. A file matches when the question contains one of its distinctive words, and
 * — if the file name has a number (Lecture 3, Assignment 2) — that same number. "lecture 4" doesn't match Lecture 3.
 */
export function namedFiles<T extends { name: string }>(question: string, files: T[]): T[] {
  const q = new Set(nameTokens(question));
  const isNum = (w: string) => /^\d+$/.test(w);
  return files.filter((f) => {
    const words = nameTokens(f.name.replace(/\.[a-z0-9]+$/i, "")).filter((w) => !GENERIC.has(w));
    const nums = words.filter(isNum);
    const named = words.filter((w) => !isNum(w) && w.length >= 3).some((w) => q.has(w));
    return named && (nums.length === 0 || nums.some((n) => q.has(n)));
  });
}

/** Pages or slides the question points to: "page 12", "p. 4", "slide 7", "pages 3-5". */
export function mentionedPages(question: string): number[] {
  const out = new Set<number>();
  for (const m of question.toLowerCase().matchAll(/\b(?:pages?|pp?\.?|slides?)\s*(\d{1,4})(?:\s*(?:-|–|to)\s*(\d{1,4}))?/g)) {
    const a = Number(m[1]);
    const b = m[2] ? Math.min(Number(m[2]), a + 10) : a;
    for (let p = a; p <= b; p++) out.add(p);
  }
  return [...out];
}

/** "p. 4", "pp. 4, 7 and 9" */
function describePages(pages: number[]): string {
  if (pages.length === 1) return `page ${pages[0]}`;
  const shown = pages.slice(0, 12);
  return `pages ${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}${pages.length > shown.length ? ` (+${pages.length - shown.length} more)` : ""}`;
}

/**
 * Which visual pages to send, newest attachments first, at most MAX_VISUAL_PAGES:
 * every visual page of small attachments (sent whole) and scanned attachments (no text to search), plus the
 * visual pages of the passages picked by search. Scanned course files can't be searched; they're named in a note.
 */
export function pickVisualPages(
  ready: FileRow[], picked: { file_id: string; page: number | null }[], small: FileRow[],
  opts: { conversationId: string; newAttachmentIds: string[] },
): { file: FileRow; pages: number[]; skipped: number[] }[] {
  const order = [...ready].sort((a, b) => Number(opts.newAttachmentIds.includes(b.id)) - Number(opts.newAttachmentIds.includes(a.id)));
  let left = MAX_VISUAL_PAGES;
  const out: { file: FileRow; pages: number[]; skipped: number[] }[] = [];
  for (const f of order) {
    if (f.mime !== "application/pdf") continue; // only PDF pages can be sent as images
    const visual = [...new Set(f.visual_pages ?? [])].sort((a, b) => a - b);
    if (!visual.length) continue;
    const isAttachment = f.conversation_id === opts.conversationId;
    const whole = isAttachment && (small.includes(f) || f.status === "needs_ocr");
    const relevant = whole ? visual : visual.filter((p) => picked.some((c) => c.file_id === f.id && c.page === p));
    if (!relevant.length) continue;
    const pages = relevant.slice(0, Math.max(0, left));
    left -= pages.length;
    out.push({ file: f, pages, skipped: relevant.slice(pages.length) });
  }
  return out;
}

/** A small PDF with just these pages of the stored file, as base64. null if the file can't be split. */
async function pagesAsPdf(supabase: SupabaseClient, file: FileRow, pages: number[]): Promise<string | null> {
  try {
    const { data: blob } = await supabase.storage.from("uploads").download(file.storage_path);
    if (!blob) return null;
    const { PDFDocument } = await import("pdf-lib");
    const src = await PDFDocument.load(new Uint8Array(await blob.arrayBuffer()), { ignoreEncryption: true });
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, pages.map((p) => p - 1).filter((i) => i >= 0 && i < src.getPageCount()));
    copied.forEach((p) => out.addPage(p));
    return Buffer.from(await out.save()).toString("base64");
  } catch {
    return null;
  }
}

/**
 * Course images (uploaded to the course, not attached to this chat) can't be searched. Send the ones whose file name
 * shares a word with the question; name the rest so the model knows they exist.
 */
async function courseImages(
  supabase: SupabaseClient, all: FileRow[], opts: { conversationId: string; question: string; imageSlots?: number }, notes: string[],
): Promise<TurnImage[]> {
  const imgs = all.filter((f) => f.kind === "image" && f.conversation_id !== opts.conversationId);
  if (!imgs.length) return [];
  const words = new Set((opts.question.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w)));
  const nameWords = (n: string) => n.toLowerCase().replace(/\.[a-z0-9]+$/, "").split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const matching = imgs.filter((f) => nameWords(f.name).some((w) => words.has(w))).slice(0, Math.max(0, opts.imageSlots ?? 2));
  const out: TurnImage[] = [];
  for (const f of matching) {
    const { data: blob } = await supabase.storage.from("uploads").download(f.storage_path);
    if (blob) out.push({ mime: f.mime, data: Buffer.from(await blob.arrayBuffer()).toString("base64") });
  }
  const sent = matching.slice(0, out.length);
  if (sent.length) notes.push(`Course images attached to this question: ${sent.map((f) => f.name).join(", ")}.`);
  const rest = imgs.filter((f) => !sent.includes(f));
  if (rest.length) {
    notes.push(`The course also has ${rest.length} image${rest.length === 1 ? "" : "s"} that ${rest.length === 1 ? "wasn't" : "weren't"} shown: ${rest.slice(0, 15).map((f) => f.name).join(", ")}${rest.length > 15 ? "…" : ""}. If one is needed, ask the student to attach it to the chat.`);
  }
  return out;
}

const STOP = new Set(["the", "and", "for", "what", "this", "that", "with", "from", "are", "how", "why", "can", "you", "does", "about", "explain", "please", "image", "picture", "png", "jpg"]);

/** Images attached to the most recent user messages (newest MAX_IMAGES), as base64 for vision models. */
export async function loadImages(supabase: SupabaseClient, attachmentIdsByMessage: { messageIndex: number; ids: string[] }[]) {
  const wanted = attachmentIdsByMessage.flatMap((m) => m.ids.map((id) => ({ messageIndex: m.messageIndex, id }))).reverse();
  if (!wanted.length) return new Map<number, TurnImage[]>();
  const { data } = await supabase.from("files").select("id, storage_path, mime, kind").in("id", wanted.map((w) => w.id)).eq("kind", "image");
  const rows = new Map(((data ?? []) as Pick<FileRow, "id" | "storage_path" | "mime">[]).map((r) => [r.id, r]));
  const out = new Map<number, TurnImage[]>();
  let count = 0;
  for (const w of wanted) {
    const row = rows.get(w.id);
    if (!row || count >= MAX_IMAGES) continue;
    const { data: blob } = await supabase.storage.from("uploads").download(row.storage_path);
    if (!blob) continue;
    const img = { mime: row.mime, data: Buffer.from(await blob.arrayBuffer()).toString("base64") };
    out.set(w.messageIndex, [img, ...(out.get(w.messageIndex) ?? [])]);
    count++;
  }
  return out;
}

/** Which [S#] markers the answer actually cites — only those are shown as references. */
export function citedSources(answer: string, sources: Source[]): Source[] {
  const cited = new Set([...answer.matchAll(/\[S(\d+)\]/g)].map((m) => Number(m[1])));
  return sources.filter((s) => cited.has(s.n));
}

/** Remove [S#] markers that don't match a passage we actually sent (made-up citations), so they're never shown. */
export function stripInventedCitations(answer: string, sources: Source[]): string {
  const real = new Set(sources.map((s) => s.n));
  return answer.replace(/ ?\[S(\d+)\]/g, (m, n) => (real.has(Number(n)) ? m : ""));
}

/**
 * How an answer relates to the student's files, shown under it:
 * cited = uses passages (listed) · uncited = passages were sent but none used · none = nothing from the files was sent.
 * Stored as sources = [...] / [] / null, so it survives reloads without a schema change.
 */
export type Grounding = "cited" | "uncited" | "none";
export function grounding(sent: Source[], cited: Source[]): Grounding {
  return cited.length ? "cited" : sent.length ? "uncited" : "none";
}
