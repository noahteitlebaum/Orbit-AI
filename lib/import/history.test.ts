import { describe, expect, it } from "vitest";
import { cleanChats, importBatches, parseExport } from "./history";

// A trimmed ChatGPT export: a tree where the student regenerated one answer (only the shown branch is imported).
const chatgpt = [{
  title: "Cell respiration", create_time: 1760000000, update_time: 1760000500, conversation_id: "c1", current_node: "a2",
  mapping: {
    root: { id: "root", message: null, parent: null, children: ["sys"] },
    sys: { id: "sys", message: { author: { role: "system" }, content: { content_type: "text", parts: [""] } }, parent: "root", children: ["u1"] },
    u1: { id: "u1", message: { author: { role: "user" }, content: { content_type: "text", parts: ["What is ATP?"] }, create_time: 1760000001 }, parent: "sys", children: ["a1", "a2"] },
    a1: { id: "a1", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["Old answer"] } }, parent: "u1", children: [] },
    a2: { id: "a2", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["ATP is the cell's energy currency."] } }, parent: "u1", children: [] },
  },
}, { title: "Empty", mapping: { r: { id: "r", message: null, parent: null } }, current_node: "r" }];

const claude = [{
  uuid: "k1", name: "Essay help", created_at: "2026-09-01T10:00:00Z", updated_at: "2026-09-02T10:00:00Z",
  chat_messages: [
    { sender: "human", text: "Fix my thesis", created_at: "2026-09-01T10:00:00Z" },
    { sender: "assistant", text: "", content: [{ type: "text", text: "Here's a sharper version." }] },
  ],
}];

describe("history import", () => {
  it("reads ChatGPT exports, following the branch the student last saw", () => {
    const p = parseExport(chatgpt);
    expect(p.source).toBe("chatgpt");
    expect(p.skipped).toBe(1);
    expect(p.chats).toEqual([{
      key: "chatgpt:c1", title: "Cell respiration", createdAt: "2025-10-09T08:53:20.000Z", updatedAt: "2025-10-09T09:01:40.000Z",
      messages: [
        { role: "user", content: "What is ATP?", at: "2025-10-09T08:53:21.000Z" },
        { role: "assistant", content: "ATP is the cell's energy currency.", at: null },
      ],
    }]);
  });

  it("reads Claude exports", () => {
    const p = parseExport(claude);
    expect(p.source).toBe("claude");
    expect(p.chats[0]).toMatchObject({ key: "claude:k1", title: "Essay help", messages: [{ role: "user", content: "Fix my thesis" }, { role: "assistant", content: "Here's a sharper version." }] });
  });

  it("rejects other files", () => {
    expect(() => parseExport({ hello: 1 })).toThrow(/isn't a ChatGPT or Claude export/);
    expect(() => parseExport([{ foo: 1 }])).toThrow(/isn't a ChatGPT or Claude export/);
  });

  it("batches by size and checks what the browser sends", () => {
    const chats = parseExport(chatgpt).chats;
    expect(importBatches([...chats, ...chats, ...chats], 10_000, 2).map((b) => b.length)).toEqual([2, 1]);
    expect(cleanChats([{ key: "evil:1", title: "x", messages: [] }])).toBeNull();
    expect(cleanChats([{ key: "chatgpt:1", title: "t", createdAt: "nope", messages: [{ role: "system", content: "x" }, { role: "user", content: "hi" }] }]))
      .toEqual([{ key: "chatgpt:1", title: "t", createdAt: null, updatedAt: null, messages: [{ role: "user", content: "hi", at: null }] }]);
  });
});
