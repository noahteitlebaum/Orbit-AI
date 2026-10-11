import { deflateRawSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { docxText, runFolderTool, runTool, segments, type FolderLink } from "./browser-fs";

// In-memory stand-in for the browser's folder handles (File System Access API).
type Node = FakeDir | FakeFile;
const err = (name: string) => Object.assign(new Error(name), { name });
class FakeFile {
  kind = "file" as const;
  constructor(public name: string, public data: Uint8Array = new Uint8Array()) {}
  async getFile() {
    return new File([this.data as BlobPart], this.name);
  }
  async createWritable() {
    const parts: BlobPart[] = [];
    return {
      write: async (d: string | Blob) => void parts.push(d),
      close: async () => {
        this.data = new Uint8Array(await new Blob(parts).arrayBuffer());
      },
    };
  }
}
class FakeDir {
  kind = "directory" as const;
  children = new Map<string, Node>();
  constructor(public name: string) {}
  async getDirectoryHandle(name: string, o?: { create?: boolean }) {
    const c = this.children.get(name);
    if (c?.kind === "directory") return c;
    if (c) throw err("TypeMismatchError");
    if (!o?.create) throw err("NotFoundError");
    const d = new FakeDir(name);
    this.children.set(name, d);
    return d;
  }
  async getFileHandle(name: string, o?: { create?: boolean }) {
    const c = this.children.get(name);
    if (c?.kind === "file") return c;
    if (c) throw err("TypeMismatchError");
    if (!o?.create) throw err("NotFoundError");
    const f = new FakeFile(name);
    this.children.set(name, f);
    return f;
  }
  async removeEntry(name: string) {
    if (!this.children.delete(name)) throw err("NotFoundError");
  }
  async *values() {
    yield* this.children.values();
  }
}
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (f: Node | undefined) => new TextDecoder().decode((f as FakeFile).data);

let root: FakeDir;
const run = (name: string, args: Record<string, unknown> = {}, dryRun = false) =>
  runTool(root as unknown as FileSystemDirectoryHandle, name, args, { dryRun });

beforeEach(async () => {
  root = new FakeDir("Essays");
  const notes = await root.getDirectoryHandle("notes", { create: true });
  notes.children.set("week1.md", new FakeFile("week1.md", enc("# Week 1\nPhotosynthesis makes glucose.\n")));
});

describe("paths stay inside the folder", () => {
  it.each(["../secret.txt", "/etc/passwd", "C:\\Windows\\win.ini", "notes/../../x"])("refuses %s", (p) => {
    expect(() => segments(p)).toThrow(/outside|relative/);
  });
});

describe("tools", () => {
  it("lists, reads and searches", async () => {
    expect(await run("list_files", { depth: 2 })).toContain("week1.md");
    expect(await run("read_file", { path: "notes/week1.md" })).toContain("Photosynthesis");
    expect(await run("search_files", { query: "glucose" })).toContain("notes/week1.md:2:");
  });

  it("dry run checks without changing anything", async () => {
    expect(await run("edit_file", { path: "notes/week1.md", old_text: "glucose", new_text: "sugar" }, true)).toBe("Edit notes/week1.md");
    expect(dec((root.children.get("notes") as FakeDir).children.get("week1.md"))).toContain("glucose");
    await expect(run("edit_file", { path: "notes/week1.md", old_text: "nope", new_text: "x" }, true)).rejects.toThrow(/wasn't found/);
  });

  it("edits exactly once, and adds nothing else to the folder", async () => {
    expect(await run("edit_file", { path: "notes/week1.md", old_text: "glucose", new_text: "sugar ($1)" })).toBe("Edited notes/week1.md.");
    expect(dec((root.children.get("notes") as FakeDir).children.get("week1.md"))).toContain("sugar ($1)");
    expect([...root.children.keys()]).toEqual(["notes"]);
    root.children.set("a.txt", new FakeFile("a.txt", enc("x x")));
    await expect(run("edit_file", { path: "a.txt", old_text: "x", new_text: "y" })).rejects.toThrow(/2 times/);
  });

  it("handles Windows line endings", async () => {
    root.children.set("win.txt", new FakeFile("win.txt", enc("line one\r\nline two\r\n")));
    await run("edit_file", { path: "win.txt", old_text: "line one\nline two", new_text: "a\nb" });
    expect(dec(root.children.get("win.txt"))).toBe("a\r\nb\r\n");
  });

  it("creates, moves and deletes", async () => {
    await run("write_file", { path: "drafts/essay.md", content: "Draft" });
    await run("move_path", { from: "drafts/essay.md", to: "final/essay.md" });
    expect((root.children.get("drafts") as FakeDir).children.size).toBe(0);
    expect(dec((root.children.get("final") as FakeDir).children.get("essay.md"))).toBe("Draft");
    await expect(run("move_path", { from: "final", to: "final/inner" })).rejects.toThrow(/inside itself/);
    await run("delete_path", { path: "final" });
    expect([...root.children.keys()].sort()).toEqual(["drafts", "notes"]);
  });

  it("won't edit binary or Office files", async () => {
    root.children.set("pic.bin", new FakeFile("pic.bin", new Uint8Array([0, 1, 2, 0])));
    await expect(run("write_file", { path: "pic.bin", content: "x" })).rejects.toThrow(/plain text/);
    await expect(run("write_file", { path: "essay.docx", content: "x" })).rejects.toThrow(/plain-text/);
  });

  it("reads text out of a .docx", async () => {
    expect(await docxText(makeDocx("<w:p><w:r><w:t>Hello</w:t></w:r></w:p><w:p><w:r><w:t>World &amp; more</w:t></w:r></w:p>"))).toBe("Hello\nWorld & more");
  });

  it("turns errors into text for the model", async () => {
    const link = { handle: root as unknown as FileSystemDirectoryHandle, name: "Essays" } satisfies FolderLink;
    expect(await runFolderTool(link, "read_file", { path: "missing.md" })).toEqual({ ok: false, error: "File not found." });
    expect(await runFolderTool(link, "rm_rf", {})).toMatchObject({ ok: false, error: expect.stringContaining("Unknown tool") });
  });
});

// A tiny one-file .docx (just word/document.xml, deflated).
function makeDocx(body: string): Uint8Array {
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
  return new Uint8Array(Buffer.concat([local, name, data, central, name, end]));
}
