import { json, requireAppUser } from "@/lib/api";
import { DOC_TYPES, detectMime, extractDocument } from "@/lib/files/extract";

// POST /api/plugins/read (body: the file's bytes; header x-file-name) → { text }
// Turns a document a plugin fetched (OneDrive Word/PowerPoint/PDF/Excel…) into text for the AI, without storing it.
// The file came from the student's own account through their browser. Signed-in students only.
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_CHARS = 60_000;

export async function POST(request: Request) {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  const name = decodeURIComponent(request.headers.get("x-file-name") ?? "file").slice(0, 200);
  const len = Number(request.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES) return json({ error: "too_large" }, 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) return json({ error: "too_large" }, 413);
  const mime = detectMime(name, request.headers.get("content-type") ?? "");
  if (!DOC_TYPES[mime] && mime !== "text/plain") return json({ error: "unsupported" }, 415);
  try {
    const r = await extractDocument(bytes, mime);
    let last: number | null = null;
    let text = r.chunks.map((c) => {
      const mark = c.page != null && c.page !== last ? `[page ${c.page}]\n` : "";
      last = c.page;
      return mark + c.content;
    }).join("\n\n");
    if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n[cut off: the file is longer]`;
    if (r.status === "needs_ocr") text = `${text}\n[This looks like a scanned PDF; most pages are pictures, so little text could be read.]`;
    return json({ text, pages: r.pageCount });
  } catch {
    return json({ error: "unreadable" }, 422);
  }
}
