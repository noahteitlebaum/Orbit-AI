import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "@/test/fake-supabase";

const state = { fake: fakeSupabase() };
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  requireAppUser: async () => ({ user: { id: "u1" }, supabase: state.fake.client }),
}));
vi.mock("@/lib/analytics/events", () => ({ trackEvent: vi.fn(async () => {}) }));

import { POST } from "./route";

const chat = (key: string) => ({ key, title: "Cell respiration", createdAt: "2026-09-01T10:00:00.000Z", updatedAt: "2026-09-02T10:00:00.000Z",
  messages: [{ role: "user", content: "What is ATP?", at: null }, { role: "assistant", content: "Energy currency.", at: null }] });
const post = (body: object) => POST(new Request("http://x/api/import", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  state.fake = fakeSupabase();
});

describe("POST /api/import", () => {
  it("saves chats into the chosen app, in order, and skips them on a second import", async () => {
    expect(await (await post({ provider: "openai", source: "chatgpt", chats: [chat("chatgpt:a"), chat("chatgpt:b")] })).json()).toEqual({ imported: 2, duplicates: 0 });
    const db = state.fake.db;
    expect(db.conversations).toHaveLength(2);
    expect(db.conversations[0]).toMatchObject({ user_id: "u1", provider: "openai", imported_from: "chatgpt", import_key: "chatgpt:a", title: "Cell respiration", updated_at: "2026-09-02T10:00:00.000Z" });
    expect(db.messages.filter((m) => m.conversation_id === db.conversations[0].id).map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(await (await post({ provider: "openai", source: "chatgpt", chats: [chat("chatgpt:a"), chat("chatgpt:c")] })).json()).toEqual({ imported: 1, duplicates: 1 });
    expect(db.conversations).toHaveLength(3);
  });

  it("rejects bad input", async () => {
    expect((await post({ provider: "nope", source: "chatgpt", chats: [chat("chatgpt:a")] })).status).toBe(400);
    expect((await post({ provider: "openai", source: "gemini", chats: [chat("chatgpt:a")] })).status).toBe(400);
    expect((await post({ provider: "openai", source: "chatgpt", chats: [{ ...chat("x:1") }] })).status).toBe(400);
  });
});
