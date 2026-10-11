#!/usr/bin/env node
// Orbit Helper: lets Orbit AI read and (with the student's approval in the app) change files in ONE folder.
//
// Students download it as an app (OrbitHelper.exe / macOS) and open it. On first open it asks for a folder, keeps
// running in the background until the computer restarts or they stop it, and opens Orbit AI, which connects to it
// automatically. It never starts by itself: opening it again starts it (and re-opens the 10-minute connection window).
// "--pick" chooses another folder; "--stop" stops it.
// Developers can also run it directly:  node orbit-helper.mjs ["C:\\path\\to\\folder"]
//
// Safety model
// - Listens on 127.0.0.1 only. Requests must come from an Orbit AI web page (Origin allowlist) to this exact host
//   (Host check, blocks DNS rebinding), and carry a token. Tokens are only handed out during a 10-minute window that
//   opens when the student opens the helper themselves; they're stored hashed in the helper's settings file.
// - Every path is resolved inside the chosen folder; "..", absolute paths and symlinks that lead outside are refused.
// - Before a file is overwritten, edited, moved over or deleted, the old copy goes to <folder>/.orbit-trash/<time>/.
// - Approval happens in the app: changes only run after the student clicks Apply. This helper also logs every action.
// No dependencies (Node.js 18+ when run as a script).

import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

export const VERSION = "1.1.0";
export const DEFAULT_PORT = 47613;
export const APP_URL = "https://polar-ai-dusky.vercel.app"; // where "open Orbit AI" goes; change if the site moves
export const DEFAULT_ORIGINS = [APP_URL, "http://localhost:3000"];
export const PAIR_WINDOW_MS = 10 * 60 * 1000;
const TRASH = ".orbit-trash";
const SKIP_DIRS = new Set([TRASH, ".git", "node_modules", ".next", "__pycache__", ".venv"]);
const MAX_READ_BYTES = 2 * 1024 * 1024; // files bigger than this aren't read
const MAX_READ_CHARS = 60_000;          // most text returned per read
const MAX_WRITE_CHARS = 1_000_000;
const MAX_LIST = 400;
const MAX_MATCHES = 60;
const WRITE_TOOLS = new Set(["write_file", "edit_file", "make_folder", "move_path", "delete_path"]);

// ---------------------------------------------------------------- paths

export class ToolError extends Error {}

const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
const inside = (root, p) => norm(p) === norm(root) || norm(p).startsWith(norm(root.endsWith(path.sep) ? root : root + path.sep));

/** Resolve a folder-relative path. Throws unless the result (after following symlinks) stays inside root. */
export function resolveInside(root, rel, { allowRoot = true } = {}) {
  if (typeof rel !== "string") throw new ToolError("path must be a string");
  const cleaned = rel.trim().replace(/\\/g, "/").replace(/^\.\/+/, "") || ".";
  if (path.isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) throw new ToolError("Use a path relative to the connected folder.");
  const full = path.resolve(root, cleaned);
  if (!inside(root, full)) throw new ToolError("That path is outside the connected folder.");
  if (!allowRoot && norm(full) === norm(root)) throw new ToolError("That's the connected folder itself.");
  const rel2 = path.relative(root, full);
  if (norm(rel2.split(path.sep)[0]) === TRASH) throw new ToolError(`${TRASH} holds backups and can't be changed here.`);
  // Follow symlinks on the longest existing prefix.
  let probe = full;
  while (!exists(probe)) probe = path.dirname(probe);
  const real = realpathSync(probe);
  if (!inside(root, real)) throw new ToolError("That path leads outside the connected folder.");
  return full;
}

function exists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

const relOf = (root, full) => path.relative(root, full).split(path.sep).join("/") || ".";

// ---------------------------------------------------------------- reading

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Minimal .docx reader: unzip word/document.xml and keep paragraph text. Read-only. */
export function docxText(buf) {
  // Find the central directory via the end-of-central-directory record.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ToolError("This .docx file looks damaged.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name !== "word/document.xml") continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    const xml = (method === 8 ? inflateRawSync(raw) : raw).toString("utf8");
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

async function readText(full) {
  const st = await fs.stat(full).catch(() => null);
  if (!st) throw new ToolError("File not found.");
  if (st.isDirectory()) throw new ToolError("That's a folder. Use list_files.");
  if (st.size > MAX_READ_BYTES) throw new ToolError(`That file is too big to read (${Math.round(st.size / 1024)} KB, limit ${MAX_READ_BYTES / 1024} KB).`);
  const buf = await fs.readFile(full);
  if (/\.docx$/i.test(full)) return { text: docxText(buf), editable: false };
  if (looksBinary(buf)) throw new ToolError("That's not a text file (images, PDFs and other binary files can't be read here).");
  return { text: buf.toString("utf8"), editable: true };
}

async function assertEditableText(full) {
  if (/\.(docx|pdf|xlsx|pptx|doc|xls|ppt|png|jpe?g|gif|zip|exe)$/i.test(full)) {
    throw new ToolError("Only plain-text files (.txt, .md, code, .csv…) can be changed. Offer to write a new .md or .txt file instead.");
  }
  const st = await fs.stat(full).catch(() => null);
  if (st?.isDirectory()) throw new ToolError("That's a folder, not a file.");
  if (st) {
    const head = Buffer.alloc(Math.min(8000, st.size));
    const fh = await fs.open(full, "r");
    try {
      await fh.read(head, 0, head.length, 0);
    } finally {
      await fh.close();
    }
    if (looksBinary(head)) throw new ToolError("That file isn't plain text, so it can't be changed here.");
  }
  return st;
}

// ---------------------------------------------------------------- backups

async function backup(root, full, stamp) {
  if (!exists(full)) return null;
  const dest = path.join(root, TRASH, stamp, path.relative(root, full));
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(full, dest, { recursive: true });
  return relOf(root, dest);
}

const stampNow = () => new Date().toISOString().replace(/[:.]/g, "-");

// ---------------------------------------------------------------- tools

const str = (v, name) => {
  if (typeof v !== "string") throw new ToolError(`${name} must be text.`);
  return v;
};

/** Run one tool. With dryRun, write tools only validate and describe what they would do. Returns text for the model. */
export async function runTool(root, name, args = {}, { dryRun = false } = {}) {
  switch (name) {
    case "list_files": {
      const base = resolveInside(root, args.path ?? ".");
      const depth = Math.max(1, Math.min(3, Number(args.depth) || 1));
      const st = await fs.stat(base).catch(() => null);
      if (!st?.isDirectory()) throw new ToolError("Folder not found.");
      const lines = [];
      let more = false;
      const walk = async (dir, d, indent) => {
        const entries = (await fs.readdir(dir, { withFileTypes: true }))
          .filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        for (const e of entries) {
          if (lines.length >= MAX_LIST) {
            more = true;
            return;
          }
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            lines.push(`${indent}${e.name}/`);
            if (d < depth) await walk(full, d + 1, indent + "  ");
          } else if (e.isFile()) {
            const size = (await fs.stat(full).catch(() => ({ size: 0 }))).size;
            lines.push(`${indent}${e.name}  (${size < 1024 ? `${size} B` : `${Math.round(size / 1024)} KB`})`);
          }
        }
      };
      await walk(base, 1, "");
      const head = `${relOf(root, base) === "." ? "Connected folder" : relOf(root, base)}:`;
      return [head, ...(lines.length ? lines : ["(empty)"]), ...(more ? [`…more than ${MAX_LIST} entries; list a subfolder.`] : [])].join("\n");
    }

    case "read_file": {
      const full = resolveInside(root, str(args.path, "path"), { allowRoot: false });
      const { text, editable } = await readText(full);
      const lines = text.split("\n");
      const from = Math.max(1, Number(args.start_line) || 1);
      let out = lines.slice(from - 1).join("\n");
      let note = "";
      if (out.length > MAX_READ_CHARS) {
        out = out.slice(0, MAX_READ_CHARS);
        const shown = out.split("\n").length;
        note = `\n\n[Showing lines ${from}–${from + shown - 1} of ${lines.length}. Read again with start_line=${from + shown - 1} for more.]`;
      }
      return `${relOf(root, full)} (${lines.length} lines${editable ? "" : ", read-only text extracted from .docx"}):\n${out}${note}`;
    }

    case "search_files": {
      const q = str(args.query, "query").toLowerCase();
      if (!q.trim()) throw new ToolError("query is empty.");
      const base = resolveInside(root, args.path ?? ".");
      const hits = [];
      const walk = async (dir) => {
        for (const e of await fs.readdir(dir, { withFileTypes: true })) {
          if (hits.length >= MAX_MATCHES) return;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name)) await walk(full);
          } else if (e.isFile()) {
            if (e.name.toLowerCase().includes(q)) hits.push(`${relOf(root, full)}  (file name)`);
            const r = await readText(full).catch(() => null);
            if (!r) continue;
            r.text.split("\n").forEach((line, i) => {
              if (hits.length < MAX_MATCHES && line.toLowerCase().includes(q)) hits.push(`${relOf(root, full)}:${i + 1}: ${line.trim().slice(0, 200)}`);
            });
          }
        }
      };
      await walk(base);
      return hits.length ? hits.join("\n") + (hits.length >= MAX_MATCHES ? "\n…more matches; search a subfolder." : "") : "No matches.";
    }

    case "write_file": {
      const full = resolveInside(root, str(args.path, "path"), { allowRoot: false });
      const content = str(args.content, "content");
      if (content.length > MAX_WRITE_CHARS) throw new ToolError("That content is too long to write in one go.");
      const st = await assertEditableText(full);
      const lines = content.split("\n").length;
      if (dryRun) return st ? `Overwrite ${relOf(root, full)} (${lines} lines)` : `Create ${relOf(root, full)} (${lines} lines)`;
      const saved = st ? await backup(root, full, stampNow()) : null;
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf8");
      return `${st ? "Overwrote" : "Created"} ${relOf(root, full)} (${lines} lines).${saved ? ` Old version saved to ${saved}.` : ""}`;
    }

    case "edit_file": {
      const full = resolveInside(root, str(args.path, "path"), { allowRoot: false });
      const oldText = str(args.old_text, "old_text");
      const newText = str(args.new_text, "new_text");
      if (!oldText) throw new ToolError("old_text is empty. Use write_file to create a file.");
      const st = await assertEditableText(full);
      if (!st) throw new ToolError("File not found.");
      const text = (await fs.readFile(full)).toString("utf8");
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
      if (dryRun) return `Edit ${relOf(root, full)}`;
      const saved = await backup(root, full, stampNow());
      await fs.writeFile(full, text.replace(find, () => repl), "utf8");
      return `Edited ${relOf(root, full)}. Old version saved to ${saved}.`;
    }

    case "make_folder": {
      const full = resolveInside(root, str(args.path, "path"), { allowRoot: false });
      if (exists(full)) return `${relOf(root, full)} already exists.`;
      if (dryRun) return `Create folder ${relOf(root, full)}`;
      await fs.mkdir(full, { recursive: true });
      return `Created folder ${relOf(root, full)}.`;
    }

    case "move_path": {
      const from = resolveInside(root, str(args.from, "from"), { allowRoot: false });
      const to = resolveInside(root, str(args.to, "to"), { allowRoot: false });
      if (!exists(from)) throw new ToolError("Nothing to move: source not found.");
      if (exists(to)) throw new ToolError("Something already exists at the destination. Pick another name, or delete it first.");
      if (inside(from, to)) throw new ToolError("Can't move a folder inside itself.");
      if (dryRun) return `Move ${relOf(root, from)} → ${relOf(root, to)}`;
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to);
      return `Moved ${relOf(root, from)} to ${relOf(root, to)}.`;
    }

    case "delete_path": {
      const full = resolveInside(root, str(args.path, "path"), { allowRoot: false });
      if (!exists(full)) throw new ToolError("Not found.");
      if (dryRun) return `Delete ${relOf(root, full)} (a backup is kept in ${TRASH})`;
      const saved = await backup(root, full, stampNow());
      await fs.rm(full, { recursive: true, force: true });
      return `Deleted ${relOf(root, full)}. A copy was kept at ${saved}.`;
    }

    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- settings (per computer user)

const hashToken = (t) => createHash("sha256").update(t).digest("hex");

/** Settings live in the user's home: chosen folder, hashed tokens, local secret. */
export function settingsStore(dir = path.join(os.homedir(), ".orbit-helper")) {
  const file = path.join(dir, "settings.json");
  let data = {};
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {}
  data.tokens ??= [];
  data.localSecret ??= randomBytes(32).toString("hex");
  const save = () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  };
  return { dir, file, data, save };
}

/**
 * @typedef {{ tokens: string[], localSecret: string, folder?: string, origins?: string[] }} Settings
 * @returns {{ data: Settings, save(): void }}
 */
export const memoryStore = () => ({ data: { tokens: [], localSecret: randomBytes(32).toString("hex") }, save() {} });

// ---------------------------------------------------------------- server

/**
 * @param {{ root: string, port?: number, origins?: string[], log?: (msg: string) => void, store?: ReturnType<typeof memoryStore>,
 *           pickFolder?: () => Promise<string | null> }} opts
 */
export function createHelper(opts) {
  const { port = DEFAULT_PORT, origins = DEFAULT_ORIGINS, log = console.log, store = memoryStore(), pickFolder = pickFolderDialog } = opts;
  let root = realpathSync(path.resolve(opts.root));
  if (!statSync(root).isDirectory()) throw new Error(`${root} is not a folder`);
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  let pairUntil = 0;
  let picking = false;

  const isToken = (t) => {
    if (!t) return false;
    const h = Buffer.from(hashToken(t));
    return store.data.tokens.some((x) => x.length === h.length && timingSafeEqual(Buffer.from(x), h));
  };
  const isLocal = (s) => typeof s === "string" && s.length === store.data.localSecret.length && timingSafeEqual(Buffer.from(s), Buffer.from(store.data.localSecret));

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    const send = (status, body) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...(origin && origins.includes(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
      });
      res.end(JSON.stringify(body));
    };

    if (!allowedHosts.has(req.headers.host ?? "")) return send(421, { error: "bad_host" });
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    // From the helper app itself (a second launch): no browser Origin, proven by the secret in the settings file.
    if (url.pathname.startsWith("/local/")) {
      if (origin || !isLocal(req.headers["x-orbit-local"])) return send(403, { error: "forbidden" });
      if (req.method === "POST" && url.pathname === "/local/open-pairing") {
        pairUntil = Date.now() + PAIR_WINDOW_MS;
        return send(200, { ok: true, folder: path.basename(root) });
      }
      if (req.method === "POST" && url.pathname === "/local/quit") {
        send(200, { ok: true });
        setTimeout(() => process.exit(0), 100);
        return;
      }
      return send(404, { error: "not_found" });
    }

    if (!origin || !origins.includes(origin)) return send(403, { error: "origin_not_allowed" });

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Private-Network": "true",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      });
      return res.end();
    }

    const authed = isToken((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    const pairable = Date.now() < pairUntil;

    if (req.method === "GET" && url.pathname === "/status") {
      return send(200, { app: "orbit-helper", version: VERSION, paired: authed, pairable, folder: authed ? path.basename(root) : undefined });
    }

    let body = {};
    if (req.method === "POST") {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 4 * MAX_WRITE_CHARS) return send(413, { error: "too_large" });
      }
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return send(400, { error: "bad_json" });
      }
    }

    if (req.method === "POST" && url.pathname === "/pair") {
      if (!pairable) return send(403, { error: "not_pairable" });
      const token = randomBytes(32).toString("hex");
      store.data.tokens = [...store.data.tokens, hashToken(token)].slice(-10);
      store.save();
      pairUntil = 0; // one browser per opening
      log(`Connected to ${origin}.`);
      return send(200, { token, folder: path.basename(root) });
    }

    if (!authed) return send(401, { error: "not_paired" });

    if (req.method === "POST" && url.pathname === "/choose-folder") {
      if (picking) return send(409, { error: "busy" });
      picking = true;
      try {
        const chosen = await pickFolder();
        if (!chosen) return send(200, { ok: false, folder: path.basename(root) });
        root = realpathSync(chosen);
        store.data.folder = root;
        store.save();
        log(`Folder changed to ${root}`);
        return send(200, { ok: true, folder: path.basename(root) });
      } catch (e) {
        return send(200, { ok: false, error: String(e?.message ?? e), folder: path.basename(root) });
      } finally {
        picking = false;
      }
    }

    if (req.method === "POST" && url.pathname === "/disconnect") {
      const h = hashToken((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      store.data.tokens = store.data.tokens.filter((x) => x !== h);
      store.save();
      return send(200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/tool") {
      const name = String(body.name ?? "");
      const dryRun = body.dryRun === true;
      try {
        const output = await runTool(root, name, body.args ?? {}, { dryRun });
        if (!dryRun) log(`${WRITE_TOOLS.has(name) ? "✎" : "·"} ${output.split("\n")[0]}`);
        return send(200, { ok: true, output });
      } catch (e) {
        const message = e instanceof ToolError ? e.message : `Couldn't do that: ${e?.code ?? "unknown error"}`;
        return send(200, { ok: false, error: message });
      }
    }

    return send(404, { error: "not_found" });
  });

  return {
    server,
    get root() {
      return root;
    },
    openPairing: (ms = PAIR_WINDOW_MS) => {
      pairUntil = Date.now() + ms;
    },
    listen: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve(server));
    }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------- the computer: folder picker, browser

const run = (cmd, args) =>
  new Promise((resolve) => execFile(cmd, args, { windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? null : String(stdout).trim())));

/** Native "choose a folder" dialog. Resolves null if cancelled or unavailable. */
export async function pickFolderDialog() {
  if (process.platform === "win32") {
    const ps = [
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
      "Add-Type -AssemblyName System.Windows.Forms",
      "$d=New-Object System.Windows.Forms.FolderBrowserDialog",
      "$d.Description='Choose the folder Orbit AI can use'",
      "$d.ShowNewFolderButton=$true",
      "$f=New-Object System.Windows.Forms.Form -Property @{TopMost=$true}",
      "if($d.ShowDialog($f) -eq 'OK'){[Console]::Out.Write($d.SelectedPath)}",
    ].join(";");
    return (await run("powershell.exe", ["-NoProfile", "-STA", "-Command", ps])) || null;
  }
  if (process.platform === "darwin") {
    const out = await run("osascript", ["-e", 'POSIX path of (choose folder with prompt "Choose the folder Orbit AI can use")']);
    return out ? out.replace(/\/$/, "") || "/" : null;
  }
  return (await run("zenity", ["--file-selection", "--directory", "--title=Choose the folder Orbit AI can use"])) || null;
}

export function openBrowser(url) {
  if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  else spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

async function local(port, secret, what) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/local/${what}`, { method: "POST", headers: { "x-orbit-local": secret }, signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { folder: undefined, port: DEFAULT_PORT, origins: [...DEFAULT_ORIGINS], appUrl: APP_URL, background: false, pick: false, stop: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--origin") out.origins.push(argv[++i].replace(/\/$/, ""));
    else if (a === "--app-url") out.appUrl = argv[++i].replace(/\/$/, "");
    else if (a === "--background") out.background = true;
    else if (a === "--pick") out.pick = true;
    else if (a === "--stop") out.stop = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (!a.startsWith("-")) out.folder = a;
  }
  if (!out.origins.includes(out.appUrl)) out.origins.push(out.appUrl);
  return out;
}

/** Background service: serves the chosen folder until it's stopped or the computer restarts. */
async function serve(opts, store) {
  const folder = store.data.folder;
  if (!folder || !existsSync(folder)) {
    console.error("No folder chosen yet. Open Orbit Helper to pick one.");
    process.exit(1);
  }
  const origins = [...new Set([...opts.origins, ...(store.data.origins ?? [])])];
  const helper = createHelper({ root: folder, port: opts.port, origins, store });
  await helper.listen();
  console.log(`Orbit Helper ${VERSION} is serving ${helper.root} on 127.0.0.1:${opts.port}`);
}

/** What happens when the student opens the app: choose a folder (first time), start in the background, open Orbit AI. */
async function launch(opts, store) {
  const say = (m) => console.log(`  ${m}`);
  console.log(`\n  Orbit Helper ${VERSION}\n`);

  if (opts.stop) {
    await local(opts.port, store.data.localSecret, "quit");
    say("Stopped. Orbit AI can't reach your files until you open Orbit Helper again.");
    return;
  }

  // Already running? Stop it if the folder or the app version is changing, otherwise just open a connection window.
  const running = await fetch(`http://127.0.0.1:${opts.port}/status`, { headers: { Origin: opts.origins[0] }, signal: AbortSignal.timeout(1500) })
    .then((r) => r.json()).catch(() => null);

  let folder = opts.folder ? path.resolve(opts.folder) : store.data.folder;
  if (opts.pick || !folder || !existsSync(folder)) {
    say("Choose the folder Orbit AI can use…");
    folder = await pickFolderDialog();
    if (!folder) {
      say(process.platform === "linux" ? "No folder picker here. Run: orbit-helper /path/to/folder" : "No folder chosen. Open Orbit Helper again when you're ready.");
      await sleep(4000);
      return;
    }
  }
  const changed = folder !== store.data.folder;
  store.data.folder = folder;
  store.data.origins = opts.origins; // the background service uses the same allowed sites
  store.save();

  if (running && (changed || running.version !== VERSION)) {
    await local(opts.port, store.data.localSecret, "quit");
    await sleep(600);
  }

  let opened = running && !changed && running.version === VERSION ? await local(opts.port, store.data.localSecret, "open-pairing") : null;
  if (!opened) {
    // Start the background service (this same app/script with --background), then close this window.
    // process.argv[1] is the script, or the app's built-in entry point when packaged (pkg needs it to run the app itself).
    const child = spawn(process.execPath, [process.argv[1], "--background", "--port", String(opts.port), ...opts.origins.flatMap((o) => ["--origin", o])], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    child.unref();
    for (let i = 0; i < 25 && !opened; i++) {
      await sleep(200);
      opened = await local(opts.port, store.data.localSecret, "open-pairing");
    }
  }
  if (!opened) {
    say(`Couldn't start the helper. Is something else using port ${opts.port}?`);
    await sleep(8000);
    process.exitCode = 1;
    return;
  }

  say(`Folder: ${folder}`);
  say("Opening Orbit AI to connect… (works for the next 10 minutes)");
  say("It keeps running in the background until you restart your computer. It won't start by itself.");
  openBrowser(`${opts.appUrl}/?folder=connect`);
  await sleep(4000); // let the student read it; the window then closes by itself
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(`Orbit Helper ${VERSION}

Opens a connection between Orbit AI and one folder on this computer.

  orbit-helper [folder]     choose/keep the folder, start in the background, open Orbit AI
  --pick                    choose a different folder
  --stop                    stop it
  --app-url <url>           Orbit AI address (default ${APP_URL})`);
    return;
  }
  const store = settingsStore();
  try {
    if (opts.background) await serve(opts, store);
    else await launch(opts, store);
  } catch (e) {
    console.error(e?.message ?? e);
    process.exitCode = 1;
  }
}

// Run when started directly (as a script or as the packaged app), not when imported by tests.
const entry = process.argv[1] ? path.basename(process.argv[1]).toLowerCase() : "";
if (process.pkg || entry.startsWith("orbit-helper")) main();
