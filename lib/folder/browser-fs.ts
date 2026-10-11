// Folder access in the browser (File System Access API, Chrome/Edge on a computer). The student picks a folder and
// the browser asks "Let this site edit files?". The AI's file tools then run here, on that folder only: a directory
// handle can't reach anything outside it. Nothing is installed and file contents never pass through our server
// except what's sent to the model.
//
// Safety rules: paths stay inside the folder, only plain-text files can be changed (.docx is readable), changes need
// the student's approval unless they chose "Don't ask for edits", and deletes always ask. Nothing extra is written
// into the student's folder.

export type FolderLink = { handle: FileSystemDirectoryHandle; name: string };
export type ToolOutcome = { ok: true; output: string } | { ok: false; error: string };
/** ask = approve every change; edits = edits/new files/moves run straight away. Deletes always ask. */
export type ApprovalMode = "ask" | "edits";

const SKIP_DIRS = new Set([".git", "node_modules", ".next", "__pycache__", ".venv"]);
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_READ_CHARS = 60_000;
const MAX_WRITE_CHARS = 1_000_000;
const MAX_LIST = 400;
const MAX_MATCHES = 60;
const MAX_SEARCH_FILES = 2000;

class ToolError extends Error {}

// ---------------------------------------------------------------- picking and remembering the folder

type PickerWindow = Window & { showDirectoryPicker?: (o?: { mode?: "read" | "readwrite"; id?: string }) => Promise<FileSystemDirectoryHandle> };
type PermissionHandle = FileSystemDirectoryHandle & {
  queryPermission?: (o: { mode: "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (o: { mode: "readwrite" }) => Promise<PermissionState>;
};

/** Chrome and Edge on a computer. Not Safari, Firefox or phones. */
export function folderAccessSupported(): boolean {
  return typeof window !== "undefined" && typeof (window as PickerWindow).showDirectoryPicker === "function";
}

/** Opens the browser's folder picker; the browser then asks the student to allow editing. null if they cancel. */
export async function pickFolder(): Promise<FolderLink | null> {
  try {
    const handle = await (window as PickerWindow).showDirectoryPicker!({ mode: "readwrite", id: "orbit-folder" });
    if ((await permission(handle, false)) !== "granted") return null;
    return { handle, name: handle.name };
  } catch {
    return null; // cancelled, or a system folder the browser won't share
  }
}

/** granted / prompt / denied. With ask=true, shows the browser prompt (must follow a click). */
export async function permission(handle: FileSystemDirectoryHandle, ask: boolean): Promise<PermissionState> {
  const h = handle as PermissionHandle;
  const state = (await h.queryPermission?.({ mode: "readwrite" })) ?? "granted";
  if (state === "granted" || !ask) return state;
  return (await h.requestPermission?.({ mode: "readwrite" })) ?? "denied";
}

// The handle is kept in IndexedDB (it can't go in localStorage). The browser still decides whether access lasts:
// usually it asks again next visit, or offers "Allow on every visit".
const DB = "orbit-folder";
const STORE = "kv";
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function kv<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  try {
    const d = await db();
    return await new Promise<T>((resolve, reject) => {
      const r = fn(d.transaction(STORE, mode).objectStore(STORE));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } catch {
    return undefined;
  }
}
export async function loadFolder(): Promise<FolderLink | null> {
  const handle = await kv<FileSystemDirectoryHandle>("readonly", (s) => s.get("folder") as IDBRequest<FileSystemDirectoryHandle>);
  return handle ? { handle, name: handle.name } : null;
}
export async function saveFolder(link: FolderLink | null) {
  await kv<unknown>("readwrite", (s) => (link ? s.put(link.handle, "folder") : s.delete("folder")) as IDBRequest<unknown>);
}

const MODE_KEY = "orbit.folder.approval.v1";
export function loadApprovalMode(): ApprovalMode {
  try {
    return localStorage.getItem(MODE_KEY) === "edits" ? "edits" : "ask";
  } catch {
    return "ask";
  }
}
export function saveApprovalMode(mode: ApprovalMode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {}
}

// ---------------------------------------------------------------- paths

/** Folder-relative path → name segments. Absolute paths and ".." are refused (handles can't go up anyway). */
export function segments(rel: unknown, { allowRoot = true } = {}): string[] {
  if (typeof rel !== "string") throw new ToolError("path must be text.");
  const raw = rel.trim().replace(/\\/g, "/");
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) throw new ToolError("Use a path relative to the connected folder.");
  const parts = raw.split("/").filter((p) => p && p !== ".");
  if (parts.includes("..")) throw new ToolError("That path is outside the connected folder.");
  if (!allowRoot && parts.length === 0) throw new ToolError("That's the connected folder itself.");
  return parts;
}

const notFound = (e: unknown) => (e as DOMException)?.name === "NotFoundError" || (e as DOMException)?.name === "TypeMismatchError";

async function dirAt(root: FileSystemDirectoryHandle, parts: string[], create = false): Promise<FileSystemDirectoryHandle> {
  let d = root;
  for (const p of parts) {
    try {
      d = await d.getDirectoryHandle(p, { create });
    } catch (e) {
      if (notFound(e)) throw new ToolError("Folder not found.");
      throw e;
    }
  }
  return d;
}

/** The entry at a path, or null. */
async function entryAt(root: FileSystemDirectoryHandle, parts: string[]): Promise<FileSystemHandle | null> {
  if (parts.length === 0) return root;
  const parent = await dirAt(root, parts.slice(0, -1)).catch(() => null);
  if (!parent) return null;
  const name = parts[parts.length - 1];
  for (const get of [() => parent.getFileHandle(name), () => parent.getDirectoryHandle(name)]) {
    try {
      return await get();
    } catch {}
  }
  return null;
}

const join = (parts: string[]) => parts.join("/") || ".";

async function* entries(dir: FileSystemDirectoryHandle): AsyncGenerator<FileSystemHandle> {
  for await (const h of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) yield h;
}

// ---------------------------------------------------------------- reading

const looksBinary = (b: Uint8Array) => b.subarray(0, 8000).includes(0);

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Minimal .docx reader: unzip word/document.xml and keep paragraph text. Read-only. */
export async function docxText(buf: Uint8Array): Promise<string> {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ToolError("This .docx file looks damaged.");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name !== "word/document.xml") continue;
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = buf.subarray(start, start + size);
    const xml = dec.decode(method === 8 ? await inflateRaw(raw) : raw);
    return xml
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:br\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  throw new ToolError("Couldn't find the text inside this .docx file.");
}

async function readText(h: FileSystemHandle | null): Promise<{ text: string; editable: boolean }> {
  if (!h) throw new ToolError("File not found.");
  if (h.kind === "directory") throw new ToolError("That's a folder. Use list_files.");
  const file = await (h as FileSystemFileHandle).getFile();
  if (file.size > MAX_READ_BYTES) throw new ToolError(`That file is too big to read (${Math.round(file.size / 1024)} KB, limit ${MAX_READ_BYTES / 1024} KB).`);
  const buf = new Uint8Array(await file.arrayBuffer());
  if (/\.docx$/i.test(h.name)) return { text: await docxText(buf), editable: false };
  if (looksBinary(buf)) throw new ToolError("That's not a text file (images, PDFs and other binary files can't be read here).");
  return { text: new TextDecoder().decode(buf), editable: true };
}

/** Throws unless the path can be written as plain text. Returns the existing file, if any. */
async function editableFile(h: FileSystemHandle | null, name: string): Promise<FileSystemFileHandle | null> {
  if (/\.(docx|pdf|xlsx|pptx|doc|xls|ppt|png|jpe?g|gif|zip|exe)$/i.test(name)) {
    throw new ToolError("Only plain-text files (.txt, .md, code, .csv…) can be changed. Offer to write a new .md or .txt file instead.");
  }
  if (!h) return null;
  if (h.kind === "directory") throw new ToolError("That's a folder, not a file.");
  const file = await (h as FileSystemFileHandle).getFile();
  if (looksBinary(new Uint8Array(await file.slice(0, 8000).arrayBuffer()))) throw new ToolError("That file isn't plain text, so it can't be changed here.");
  return h as FileSystemFileHandle;
}

// ---------------------------------------------------------------- writing, copying

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: string | Blob) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

async function copyInto(src: FileSystemHandle, destDir: FileSystemDirectoryHandle, name: string) {
  if (src.kind === "file") return writeFile(destDir, name, await (src as FileSystemFileHandle).getFile());
  const d = await destDir.getDirectoryHandle(name, { create: true });
  for await (const child of entries(src as FileSystemDirectoryHandle)) await copyInto(child, d, child.name);
}

// ---------------------------------------------------------------- tools

const str = (v: unknown, name: string) => {
  if (typeof v !== "string") throw new ToolError(`${name} must be text.`);
  return v;
};
const kb = (n: number) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);

/** Run one folder tool. With dryRun, changes are only checked and described. Returns text for the model. */
export async function runTool(root: FileSystemDirectoryHandle, name: string, args: Record<string, unknown> = {}, { dryRun = false } = {}): Promise<string> {
  switch (name) {
    case "list_files": {
      const parts = segments(args.path ?? ".");
      const base = await dirAt(root, parts);
      const depth = Math.max(1, Math.min(3, Number(args.depth) || 1));
      const lines: string[] = [];
      let more = false;
      const walk = async (dir: FileSystemDirectoryHandle, d: number, indent: string) => {
        const list: FileSystemHandle[] = [];
        for await (const e of entries(dir)) if (!(e.kind === "directory" && SKIP_DIRS.has(e.name))) list.push(e);
        list.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
        for (const e of list) {
          if (lines.length >= MAX_LIST) {
            more = true;
            return;
          }
          if (e.kind === "directory") {
            lines.push(`${indent}${e.name}/`);
            if (d < depth) await walk(e as FileSystemDirectoryHandle, d + 1, indent + "  ");
          } else lines.push(`${indent}${e.name}  (${kb((await (e as FileSystemFileHandle).getFile()).size)})`);
        }
      };
      await walk(base, 1, "");
      return [parts.length ? `${join(parts)}:` : "Connected folder:", ...(lines.length ? lines : ["(empty)"]), ...(more ? [`…more than ${MAX_LIST} entries; list a subfolder.`] : [])].join("\n");
    }

    case "read_file": {
      const parts = segments(str(args.path, "path"), { allowRoot: false });
      const { text, editable } = await readText(await entryAt(root, parts));
      const lines = text.split("\n");
      const from = Math.max(1, Number(args.start_line) || 1);
      let out = lines.slice(from - 1).join("\n");
      let note = "";
      if (out.length > MAX_READ_CHARS) {
        out = out.slice(0, MAX_READ_CHARS);
        const shown = out.split("\n").length;
        note = `\n\n[Showing lines ${from}–${from + shown - 1} of ${lines.length}. Read again with start_line=${from + shown - 1} for more.]`;
      }
      return `${join(parts)} (${lines.length} lines${editable ? "" : ", read-only text extracted from .docx"}):\n${out}${note}`;
    }

    case "search_files": {
      const q = str(args.query, "query").toLowerCase();
      if (!q.trim()) throw new ToolError("query is empty.");
      const parts = segments(args.path ?? ".");
      const hits: string[] = [];
      let seen = 0;
      const walk = async (dir: FileSystemDirectoryHandle, at: string[]) => {
        for await (const e of entries(dir)) {
          if (hits.length >= MAX_MATCHES || seen >= MAX_SEARCH_FILES) return;
          const p = [...at, e.name];
          if (e.kind === "directory") {
            if (!SKIP_DIRS.has(e.name)) await walk(e as FileSystemDirectoryHandle, p);
            continue;
          }
          seen++;
          if (e.name.toLowerCase().includes(q)) hits.push(`${join(p)}  (file name)`);
          const r = await readText(e).catch(() => null);
          if (!r) continue;
          r.text.split("\n").forEach((line, i) => {
            if (hits.length < MAX_MATCHES && line.toLowerCase().includes(q)) hits.push(`${join(p)}:${i + 1}: ${line.trim().slice(0, 200)}`);
          });
        }
      };
      await walk(await dirAt(root, parts), parts);
      return hits.length ? hits.join("\n") + (hits.length >= MAX_MATCHES ? "\n…more matches; search a subfolder." : "") : "No matches.";
    }

    case "write_file": {
      const parts = segments(str(args.path, "path"), { allowRoot: false });
      const content = str(args.content, "content");
      if (content.length > MAX_WRITE_CHARS) throw new ToolError("That content is too long to write in one go.");
      const existing = await editableFile(await entryAt(root, parts), parts[parts.length - 1]);
      const lines = content.split("\n").length;
      if (dryRun) return `${existing ? "Overwrite" : "Create"} ${join(parts)} (${lines} lines)`;
      await writeFile(await dirAt(root, parts.slice(0, -1), true), parts[parts.length - 1], content);
      return `${existing ? "Overwrote" : "Created"} ${join(parts)} (${lines} lines).`;
    }

    case "edit_file": {
      const parts = segments(str(args.path, "path"), { allowRoot: false });
      const oldText = str(args.old_text, "old_text");
      const newText = str(args.new_text, "new_text");
      if (!oldText) throw new ToolError("old_text is empty. Use write_file to create a file.");
      const fh = await editableFile(await entryAt(root, parts), parts[parts.length - 1]);
      if (!fh) throw new ToolError("File not found.");
      const text = await (await fh.getFile()).text();
      // Match exactly; also accept the file's Windows line endings if the model sent \n.
      let find = oldText;
      let repl = newText;
      if (!text.includes(find) && text.includes("\r\n")) {
        find = oldText.replace(/\r?\n/g, "\r\n");
        repl = newText.replace(/\r?\n/g, "\r\n");
      }
      const count = text.split(find).length - 1;
      if (count === 0) throw new ToolError("old_text wasn't found in the file. Read the file again and copy the exact text.");
      if (count > 1) throw new ToolError(`old_text appears ${count} times. Include more surrounding text so it matches once.`);
      if (dryRun) return `Edit ${join(parts)}`;
      await writeFile(await dirAt(root, parts.slice(0, -1)), parts[parts.length - 1], text.replace(find, () => repl));
      return `Edited ${join(parts)}.`;
    }

    case "make_folder": {
      const parts = segments(str(args.path, "path"), { allowRoot: false });
      if (await entryAt(root, parts)) return `${join(parts)} already exists.`;
      if (dryRun) return `Create folder ${join(parts)}`;
      await dirAt(root, parts, true);
      return `Created folder ${join(parts)}.`;
    }

    case "move_path": {
      const from = segments(str(args.from, "from"), { allowRoot: false });
      const to = segments(str(args.to, "to"), { allowRoot: false });
      const src = await entryAt(root, from);
      if (!src) throw new ToolError("Nothing to move: source not found.");
      if (await entryAt(root, to)) throw new ToolError("Something already exists at the destination. Pick another name, or delete it first.");
      if (to.length > from.length && from.every((p, i) => p === to[i])) throw new ToolError("Can't move a folder inside itself.");
      if (dryRun) return `Move ${join(from)} → ${join(to)}`;
      await copyInto(src, await dirAt(root, to.slice(0, -1), true), to[to.length - 1]);
      await (await dirAt(root, from.slice(0, -1))).removeEntry(from[from.length - 1], { recursive: true });
      return `Moved ${join(from)} to ${join(to)}.`;
    }

    case "delete_path": {
      const parts = segments(str(args.path, "path"), { allowRoot: false });
      const h = await entryAt(root, parts);
      if (!h) throw new ToolError("Not found.");
      if (dryRun) return `Delete ${join(parts)} permanently`;
      await (await dirAt(root, parts.slice(0, -1))).removeEntry(parts[parts.length - 1], { recursive: true });
      return `Deleted ${join(parts)}.`;
    }

    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}

/** runTool, with errors turned into text for the model. */
export async function runFolderTool(link: FolderLink, name: string, args: Record<string, unknown>, dryRun = false): Promise<ToolOutcome> {
  try {
    return { ok: true, output: await runTool(link.handle, name, args, { dryRun }) };
  } catch (e) {
    if (e instanceof ToolError) return { ok: false, error: e.message };
    const n = (e as DOMException)?.name;
    if (n === "NotAllowedError" || n === "SecurityError") return { ok: false, error: "The browser didn't allow access to the folder. Reconnect it from the + menu." };
    if (n === "NotFoundError") return { ok: false, error: "Not found (the folder may have been moved or renamed)." };
    return { ok: false, error: `Couldn't do that (${n ?? "unknown error"}).` };
  }
}
