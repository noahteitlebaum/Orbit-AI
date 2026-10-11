import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHelper, docxText, memoryStore, runTool } from "../public/helper/orbit-helper.mjs";

let root = "";
let outside = "";
beforeEach(() => {
  const base = mkdtempSync(path.join(tmpdir(), "orbit-helper-"));
  root = path.join(base, "Essays");
  outside = path.join(base, "secret");
  mkdirSync(path.join(root, "notes"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(root, "notes", "week1.md"), "# Week 1\nPhotosynthesis makes glucose.\n");
  writeFileSync(path.join(outside, "passwords.txt"), "hunter2");
});

describe("paths stay inside the folder", () => {
  it.each(["../secret/passwords.txt", "/etc/passwd", "C:\\Windows\\win.ini", "notes/../../secret/passwords.txt"])("refuses %s", async (p) => {
    await expect(runTool(root, "read_file", { path: p })).rejects.toThrow(/outside|relative/);
  });

  it("refuses a symlink that leads outside", async () => {
    symlinkSync(outside, path.join(root, "link"));
    await expect(runTool(root, "read_file", { path: "link/passwords.txt" })).rejects.toThrow(/outside/);
    await expect(runTool(root, "write_file", { path: "link/new.txt", content: "x" })).rejects.toThrow(/outside/);
  });

  it("won't touch the backup folder", async () => {
    await expect(runTool(root, "write_file", { path: ".orbit-trash/x.txt", content: "x" })).rejects.toThrow(/backups/);
  });
});

describe("tools", () => {
  it("lists, reads and searches", async () => {
    expect(await runTool(root, "list_files", { depth: 2 })).toContain("week1.md");
    expect(await runTool(root, "read_file", { path: "notes/week1.md" })).toContain("Photosynthesis");
    expect(await runTool(root, "search_files", { query: "glucose" })).toContain("notes/week1.md:2:");
  });

  it("dry run validates without changing anything", async () => {
    expect(await runTool(root, "edit_file", { path: "notes/week1.md", old_text: "glucose", new_text: "sugar" }, { dryRun: true })).toBe("Edit notes/week1.md");
    expect(readFileSync(path.join(root, "notes/week1.md"), "utf8")).toContain("glucose");
    await expect(runTool(root, "edit_file", { path: "notes/week1.md", old_text: "nope", new_text: "x" }, { dryRun: true })).rejects.toThrow(/wasn't found/);
  });

  it("edits once, backs up the old version, refuses ambiguous edits", async () => {
    const out = await runTool(root, "edit_file", { path: "notes/week1.md", old_text: "glucose", new_text: "sugar ($1)" });
    expect(out).toMatch(/Old version saved to \.orbit-trash\//);
    expect(readFileSync(path.join(root, "notes/week1.md"), "utf8")).toContain("sugar ($1)");
    writeFileSync(path.join(root, "a.txt"), "x x");
    await expect(runTool(root, "edit_file", { path: "a.txt", old_text: "x", new_text: "y" })).rejects.toThrow(/2 times/);
  });

  it("handles Windows line endings", async () => {
    writeFileSync(path.join(root, "win.txt"), "line one\r\nline two\r\n");
    await runTool(root, "edit_file", { path: "win.txt", old_text: "line one\nline two", new_text: "a\nb" });
    expect(readFileSync(path.join(root, "win.txt"), "utf8")).toBe("a\r\nb\r\n");
  });

  it("creates, moves and deletes (with a backup)", async () => {
    await runTool(root, "write_file", { path: "drafts/essay.md", content: "Draft" });
    await runTool(root, "move_path", { from: "drafts/essay.md", to: "final/essay.md" });
    expect(existsSync(path.join(root, "final/essay.md"))).toBe(true);
    await runTool(root, "delete_path", { path: "final" });
    expect(existsSync(path.join(root, "final"))).toBe(false);
    const trash = readdirSync(path.join(root, ".orbit-trash"));
    expect(readFileSync(path.join(root, ".orbit-trash", trash[0], "final", "essay.md"), "utf8")).toBe("Draft");
  });

  it("won't edit binary or Office files", async () => {
    writeFileSync(path.join(root, "pic.bin"), Buffer.from([0, 1, 2, 0]));
    await expect(runTool(root, "write_file", { path: "pic.bin", content: "x" })).rejects.toThrow(/plain text/);
    await expect(runTool(root, "write_file", { path: "essay.docx", content: "x" })).rejects.toThrow(/plain-text/);
  });

  it("reads text out of a .docx", () => {
    expect(docxText(makeDocx("<w:p><w:r><w:t>Hello</w:t></w:r></w:p><w:p><w:r><w:t>World &amp; more</w:t></w:r></w:p>"))).toBe("Hello\nWorld & more");
  });
});

describe("HTTP server", () => {
  const PORT = 47699;
  const ORIGIN = "https://orbit.test";
  const store = memoryStore();
  let base = "";
  let other = "";
  let helper: { listen(): Promise<unknown>; close(): Promise<void>; openPairing(ms?: number): void; root: string };
  beforeAll(async () => {
    base = mkdtempSync(path.join(tmpdir(), "orbit-http-"));
    other = mkdtempSync(path.join(tmpdir(), "orbit-other-"));
    writeFileSync(path.join(base, "a.txt"), "hello");
    helper = createHelper({ root: base, port: PORT, origins: [ORIGIN], log: () => {}, store, pickFolder: async () => other });
    await helper.listen();
  });
  afterAll(() => helper.close());

  const call = (p: string, init: RequestInit & { origin?: string | null; token?: string } = {}) =>
    fetch(`http://127.0.0.1:${PORT}${p}`, {
      ...init,
      headers: {
        ...(init.origin === null ? {} : { Origin: init.origin ?? ORIGIN }),
        "Content-Type": "application/json",
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
  const pair = async () => (await (await call("/pair", { method: "POST" })).json()) as { token: string; folder: string };

  it("rejects other websites and wrong hosts", async () => {
    expect((await call("/status", { origin: "https://evil.example" })).status).toBe(403);
    // fetch() won't let us fake Host (DNS rebinding), so use a raw request.
    const status = await new Promise<number>((resolve) =>
      request({ host: "127.0.0.1", port: PORT, path: "/status", headers: { Origin: ORIGIN, Host: `evil.example:${PORT}` } }, (r) => resolve(r.statusCode ?? 0)).end(),
    );
    expect(status).toBe(421);
  });

  it("answers the private-network preflight", async () => {
    const res = await call("/tool", { method: "OPTIONS", headers: { "Access-Control-Request-Private-Network": "true" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-private-network")).toBe("true");
  });

  it("pairs only while the window the student opened is open, once", async () => {
    expect((await call("/tool", { method: "POST", body: JSON.stringify({ name: "list_files" }) })).status).toBe(401);
    expect((await call("/pair", { method: "POST" })).status).toBe(403);
    helper.openPairing();
    expect(await (await call("/status")).json()).toMatchObject({ pairable: true, paired: false });
    const { token, folder } = await pair();
    expect(folder).toBe(path.basename(base));
    expect((await call("/pair", { method: "POST" })).status).toBe(403); // window closes after one browser connects
    expect(store.data.tokens).toHaveLength(1);
    expect(store.data.tokens[0]).not.toBe(token); // stored hashed
    const res = await call("/tool", { method: "POST", token, body: JSON.stringify({ name: "read_file", args: { path: "a.txt" } }) });
    expect(await res.json()).toMatchObject({ ok: true, output: expect.stringContaining("hello") });
    expect(await (await call("/status", { token })).json()).toMatchObject({ paired: true, folder: path.basename(base) });
  });

  it("local control needs the secret and no browser origin", async () => {
    expect((await call("/local/open-pairing", { method: "POST", origin: null })).status).toBe(403);
    expect((await call("/local/open-pairing", { method: "POST", headers: { "x-orbit-local": store.data.localSecret } })).status).toBe(403);
    expect((await call("/local/open-pairing", { method: "POST", origin: null, headers: { "x-orbit-local": store.data.localSecret } })).status).toBe(200);
    expect(await (await call("/status")).json()).toMatchObject({ pairable: true });
  });

  it("changes folder from the app, and disconnect forgets the token", async () => {
    helper.openPairing();
    const { token } = await pair();
    const res = await call("/choose-folder", { method: "POST", token });
    expect(await res.json()).toMatchObject({ ok: true, folder: path.basename(other) });
    expect(store.data.folder).toBe(realpathSync(other));
    await call("/disconnect", { method: "POST", token });
    expect((await call("/tool", { method: "POST", token, body: JSON.stringify({ name: "list_files" }) })).status).toBe(401);
  });
});

// A tiny one-file .docx (just word/document.xml, deflated).
function makeDocx(body: string): Buffer {
  const name = Buffer.from("word/document.xml");
  const data = deflateRawSync(Buffer.from(`<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`));
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const cdStart = local.length + name.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(cdStart, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}
