import { describe, expect, it, vi } from "vitest";
import { docxBlob } from "@/lib/export/office";

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  requireAppUser: async () => ({ user: { id: "u1" }, supabase: {} }),
}));
import { POST } from "./route";

const req = (body: BodyInit, name: string) => new Request("http://x/api/plugins/read", { method: "POST", headers: { "x-file-name": encodeURIComponent(name) }, body });

describe("/api/plugins/read", () => {
  it("turns a Word file into text without storing it", async () => {
    const blob = await docxBlob("Lab 3", "## Method\n\nMeasure the pendulum period ten times.");
    const res = await POST(req(await blob.arrayBuffer(), "Lab 3.docx"));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.text).toContain("Measure the pendulum period");
  });
  it("reads plain text and refuses other types", async () => {
    expect((await (await POST(req("hello notes", "notes.txt"))).json()).text).toContain("hello notes");
    expect((await POST(req(new Uint8Array([0, 1, 2, 3, 0, 0]), "photo.heic"))).status).toBe(415);
  });
});
