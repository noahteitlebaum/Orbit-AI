import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "@/test/fake-supabase";

// Upload route with mocked auth + database (files are read for real).
const state = vi.hoisted(() => ({ fake: null as ReturnType<typeof import("@/test/fake-supabase").fakeSupabase> | null }));
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  requireAppUser: async () => ({ user: { id: "user-1" }, supabase: state.fake!.client }),
}));
import { POST } from "./route";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../../test/fixtures/${name}`, import.meta.url)));
async function upload(name: string, bytes: Uint8Array, type = "") {
  const id = crypto.randomUUID();
  const path = `user-1/${id}/${name}`;
  state.fake!.storage[path] = { bytes, type };
  const res = await POST(new Request("http://x/api/files", { method: "POST", body: JSON.stringify({ id, path, name }) }));
  return { res, body: await res.json(), row: state.fake!.db.files.find((f) => f.id === id), path };
}

beforeEach(() => {
  state.fake = fakeSupabase();
});

describe("POST /api/files", () => {
  it("saves a PDF with its real size and page passages", async () => {
    const pdf = fixture("lecture.pdf");
    const { res, body, row } = await upload("lecture.pdf", pdf, "application/pdf");
    expect(res.status).toBe(200);
    expect(body.file).toMatchObject({ status: "ready", pageCount: 2 });
    expect(row!.size_bytes).toBe(pdf.length);
    expect(state.fake!.db.file_chunks.length).toBeGreaterThan(0);
  });

  it("reads code files and unknown text formats", async () => {
    const { body } = await upload("solver.py", new TextEncoder().encode("def solve():\n    return 42\n"));
    expect(body.file).toMatchObject({ status: "ready", kind: "document" });
  });

  it("explains what it can't read, and removes it", async () => {
    const { res, body, path } = await upload("old.xls", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]));
    expect(res.status).toBe(400);
    expect(body.message).toContain("Save it as .xlsx or CSV");
    expect(state.fake!.storage[path]).toBeUndefined();
  });
});
