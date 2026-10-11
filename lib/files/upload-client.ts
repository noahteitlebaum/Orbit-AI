"use client";

import { createBrowserSupabase } from "@/lib/supabase/browser";

// Browser side of an upload: check type/size, put the file in Storage (the student's own folder),
// then ask the server to read and index it.
export type UploadedFile = {
  id: string; name: string; kind: "document" | "image"; status: "ready" | "failed" | "needs_ocr";
  pageCount: number | null; error: string | null; mime: string;
  visualPages?: number[]; imageCount?: number;
};

/** One line under a file chip: what was read, and what the AI will look at as images or can't read. */
export function fileNote(f: UploadedFile): string | undefined {
  if (f.status === "failed") return f.error ?? undefined;
  if (f.status === "needs_ocr") return `Scanned${f.pageCount ? ` · ${f.pageCount} pages` : ""} · read as page images`;
  const ext = f.name.toLowerCase().split(".").pop() ?? "";
  const n = f.pageCount;
  const count = n ? (ext === "pptx" ? `${n} slide${n === 1 ? "" : "s"}` : /^(xlsx|xlsm|csv|tsv)$/.test(ext) ? `${n} sheet${n === 1 ? "" : "s"}` : `${n} page${n === 1 ? "" : "s"}`) : "";
  const v = f.visualPages?.length ?? 0;
  const visual = !v ? "" : ext === "pptx" ? `${v} with pictures/charts not readable — upload as PDF to include them` : `${v} with diagrams or scans read as images`;
  const pics = f.imageCount ? `${f.imageCount} picture${f.imageCount === 1 ? "" : "s"} not readable — add screenshots if needed` : "";
  return [count, visual, pics].filter(Boolean).join(" · ") || undefined;
}

// Any file can be picked; the server reads what it can and explains what it can't.
export const ACCEPT_ATTR = "";
const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "gif", "heic", "heif", "bmp", "tif", "tiff", "avif"];
const SENDABLE_IMAGES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;
const MAX_IMAGE_SIDE = 2400;
const HINTS: Record<string, string> = {
  doc: "Old Word files (.doc) aren't supported. Save it as .docx or PDF.",
  ppt: "Old PowerPoint files (.ppt) aren't supported. Save it as .pptx or PDF.",
  xls: "Old Excel files (.xls) aren't supported. Save it as .xlsx or CSV.",
  zip: "Zip files can't be read. Unzip it and upload the files inside.",
  mp4: "Videos can't be read. Upload a screenshot or the transcript instead.",
  mov: "Videos can't be read. Upload a screenshot or the transcript instead.",
  mp3: "Audio can't be read. Upload a transcript instead.",
  m4a: "Audio can't be read. Upload a transcript instead.",
};

export function checkFile(file: File): string | null {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  if (HINTS[ext]) return HINTS[ext];
  if (!IMAGE_EXT.includes(ext) && file.size > 20 * 1024 * 1024) return "Too large — files can be up to 20 MB. Try splitting it or exporting a smaller PDF.";
  return null;
}

/**
 * Photos from phones are often too big (or HEIC). Re-encode them in the browser as a JPEG the AI apps accept:
 * at most 2400 px on the long side and under 4.5 MB. Returns the file unchanged when it's already fine.
 */
export async function prepareImage(file: File): Promise<File | { error: string }> {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  if (!IMAGE_EXT.includes(ext) && !file.type.startsWith("image/")) return file;
  if (SENDABLE_IMAGES.has(file.type) && file.size <= MAX_IMAGE_BYTES) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { error: ext === "heic" || ext === "heif" ? "This browser can't open iPhone photos (HEIC). Share it as a JPG or take a screenshot." : "That image couldn't be opened. Try a PNG or JPG." };
  }
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.85, 0.7, 0.5]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", quality));
    if (blob && blob.size <= MAX_IMAGE_BYTES) return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  }
  return { error: "That image is too large even after shrinking it. Try a screenshot instead." };
}

export async function uploadFile(original: File, userId: string, projectId?: string): Promise<UploadedFile | { error: string }> {
  const problem = checkFile(original);
  if (problem) return { error: problem };
  const file = await prepareImage(original);
  if ("error" in file) return file;
  const id = crypto.randomUUID();
  const safe = file.name.replace(/[^\w.\- ]+/g, "_").slice(-120) || "file";
  const path = `${userId}/${id}/${safe}`;
  const { error } = await createBrowserSupabase().storage.from("uploads").upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (error) {
    // A missing bucket or storage policy means migration 0002 hasn't been run.
    const setup = /bucket|policy|row-level|not found/i.test(error.message);
    return { error: setup ? "File storage isn't set up yet (run migration 0002 in Supabase)." : "Upload failed. Check your connection and try again." };
  }
  const res = await fetch("/api/files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, path, name: file.name, projectId }),
  }).catch(() => null);
  if (!res) return { error: "Upload failed. Check your connection and try again." };
  const out = (await res.json().catch(() => ({}))) as { file?: UploadedFile; error?: string; message?: string };
  if (!res.ok || !out.file) {
    // The server says what went wrong; the code in brackets helps when reporting a problem.
    return { error: out.message ?? `We couldn't process that file (${out.error ?? `error ${res.status}`}). Try again, or upload it as PDF.` };
  }
  return out.file;
}
