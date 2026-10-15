import { trackEvent } from "@/lib/analytics/events";
import { dbError, isUuid, json, requireAppUser } from "@/lib/api";
import { DOC_TYPES, IMAGE_TYPES, MAX_DOC_BYTES, MAX_IMAGE_BYTES, UNSUPPORTED_HINTS, detectMime, extractDocument, looksLikeText } from "@/lib/files/extract";

// Uploads go browser → Supabase Storage directly (uploads/<user>/<fileId>/<name>), then the browser calls:
//   POST /api/files { id, path, name, projectId? }  → we check, extract text with page numbers, and index it.
//   GET  /api/files?projectId=…                      → a course's files
export const maxDuration = 120;

export type FileSummary = {
  id: string; name: string; kind: "document" | "image"; status: "ready" | "failed" | "needs_ocr";
  pageCount: number | null; error: string | null; mime: string;
  visualPages: number[]; imageCount: number; // see lib/files/extract.ts
};

const toSummary = (f: Record<string, unknown>): FileSummary => ({
  id: f.id as string, name: f.name as string, kind: f.kind as FileSummary["kind"], status: f.status as FileSummary["status"],
  pageCount: (f.page_count as number | null) ?? null, error: (f.error as string | null) ?? null, mime: f.mime as string,
  visualPages: (f.visual_pages as number[] | null) ?? [], imageCount: (f.image_count as number | null) ?? 0,
});
const COLS = "id, name, kind, status, page_count, error, mime";
const NEW_COLS = ", visual_pages, image_count"; // migration 0005; uploads still work before it's run

export async function GET(request: Request) {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!isUuid(projectId)) return json({ error: "bad_request" }, 400);
  const list = (cols: string) => auth.supabase.from("files").select(cols).eq("project_id", projectId).order("created_at", { ascending: false });
  let { data, error } = (await list(COLS + NEW_COLS)) as unknown as { data: Record<string, unknown>[] | null; error: { code?: string } | null };
  if (error) ({ data, error } = (await list(COLS)) as unknown as { data: Record<string, unknown>[] | null; error: { code?: string } | null });
  if (error) return dbError(error, "load_failed");
  return json({ files: (data ?? []).map(toSummary) });
}

// Every failure says which step failed (and is logged without file contents), so "couldn't process" is never a mystery.
export async function POST(request: Request): Promise<Response> {
  try {
    return await handleUpload(request);
  } catch (e) {
    console.error("files.upload crashed", { name: (e as Error)?.name, message: (e as Error)?.message?.slice(0, 200) });
    return json({ error: "server_error", message: "Something went wrong reading that file. Try again, or upload it as PDF." }, 500);
  }
}

async function handleUpload(request: Request): Promise<Response> {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  const { user, supabase } = auth;
  const body = (await request.json().catch(() => null)) as { id?: unknown; path?: unknown; name?: unknown; projectId?: unknown } | null;
  if (!body || !isUuid(body.id) || typeof body.path !== "string" || typeof body.name !== "string") return json({ error: "bad_request" }, 400);
  const id = body.id;
  const path = body.path;
  const name = body.name.slice(0, 200);
  // The object must be in this student's own folder for this file id.
  if (!path.startsWith(`${user.id}/${id}/`) || path.includes("..")) return json({ error: "bad_request" }, 400);

  const { data: blob, error: dlErr } = await supabase.storage.from("uploads").download(path);
  if (dlErr || !blob) {
    console.error("files.upload download failed", { id, message: dlErr?.message?.slice(0, 200) });
    return json({ error: "upload_missing", message: "The upload didn't arrive. Check your connection and try again." }, 400);
  }
  let mime = detectMime(name, blob.type);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const size = bytes.length; // read before anything else touches the bytes
  const isImage = IMAGE_TYPES.has(mime);
  // Unknown formats that are really text (code, data, notes) are read as text.
  if (!isImage && !DOC_TYPES[mime] && looksLikeText(bytes)) mime = "text/plain";
  const isDoc = Boolean(DOC_TYPES[mime]);

  const reject = async (code: string, message: string) => {
    await supabase.storage.from("uploads").remove([path]);
    return json({ error: code, message }, 400);
  };
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (!isImage && !isDoc) {
    return reject("unsupported_type", UNSUPPORTED_HINTS[ext] ?? "That file type can't be read. Supported: PDF, Word, PowerPoint, Excel/CSV, text, code, notebooks and images.");
  }
  if (size === 0) return reject("empty", "That file is empty.");
  if (size > (isImage ? MAX_IMAGE_BYTES : MAX_DOC_BYTES)) {
    return reject("too_large", isImage ? "That image is over 5 MB." : "That file is over 20 MB. Try splitting it or exporting a smaller PDF.");
  }

  let status: FileSummary["status"] = "ready";
  let pageCount: number | null = null;
  let charCount: number | null = null;
  let errorText: string | null = null;
  let chunks: { page: number | null; chunkIndex: number; content: string }[] = [];
  let visualPages: number[] = [];
  let imageCount = 0;
  if (isDoc) {
    try {
      const r = await extractDocument(bytes, mime);
      status = r.status;
      pageCount = r.pageCount;
      charCount = r.charCount;
      chunks = r.chunks;
      visualPages = r.visualPages;
      imageCount = r.imageCount;
      // Not an error: scanned pages are read as images by ChatGPT, Claude and Gemini (see lib/chat/material.ts).
      if (status === "needs_ocr") errorText = "Scanned PDF: pages are read as images, a few at a time.";
    } catch (e) {
      status = "failed";
      const msg = (e as Error)?.message ?? "";
      console.error("files.upload extract failed", { id, mime, message: msg.slice(0, 200) });
      errorText = msg === "too_many_pages" ? "That document has too many pages (max 400)."
        : /password|encrypt/i.test(msg) ? "This file is password-protected. Remove the password and upload it again."
        : "We couldn't read this file. Try saving it as PDF and uploading that.";
    }
  }

  const base: Record<string, unknown> = {
    id, user_id: user.id, name, mime, size_bytes: size, storage_path: path,
    kind: isImage ? "image" : "document", status, page_count: pageCount, char_count: charCount, error: errorText,
    project_id: isUuid(body.projectId) ? body.projectId : null,
  };
  const insert = (withNew: boolean) =>
    supabase.from("files").insert(withNew ? { ...base, visual_pages: visualPages, image_count: imageCount } : base).select(withNew ? COLS + NEW_COLS : COLS).single();
  let { data: row, error } = (await insert(true)) as unknown as { data: Record<string, unknown> | null; error: { code?: string } | null };
  if (error?.code === "PGRST204" || error?.code === "42703") ({ data: row, error } = (await insert(false)) as unknown as { data: Record<string, unknown> | null; error: { code?: string } | null });
  if (error || !row) {
    console.error("files.upload save failed", { id, code: error?.code });
    await supabase.storage.from("uploads").remove([path]);
    return dbError(error, "save_failed", 400);
  }

  for (let i = 0; i < chunks.length; i += 500) {
    const batch = chunks.slice(i, i + 500).map((c) => ({ file_id: id, user_id: user.id, page: c.page, chunk_index: c.chunkIndex, content: c.content }));
    const { error: cErr } = await supabase.from("file_chunks").insert(batch);
    if (cErr) {
      await supabase.from("files").update({ status: "failed", error: "We couldn't index this file." }).eq("id", id);
      return json({ file: { ...toSummary(row), status: "failed", error: "We couldn't index this file." } });
    }
  }
  await trackEvent(user.id,"file_uploaded",{feature:row.kind as string},undefined,`file:${id}`);
  return json({ file: toSummary(row) });
}
