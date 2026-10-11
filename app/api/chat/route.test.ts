import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "@/test/fake-supabase";
import type { StreamEvent } from "@/lib/providers/types";
import { ProviderError } from "@/lib/providers/types";

// Route test with mocked auth, database, budget and providers (no live calls, no money).
const state = vi.hoisted(() => ({
  fake: null as ReturnType<typeof import("@/test/fake-supabase").fakeSupabase> | null,
  live: false,
  key: "k" as string | null,
  events: [] as unknown[],
  failBeforeStart: false,
  reserveOk: true,
  lastArgs: null as null | { system: string; history: { role: string; content: string; images?: unknown[]; toolCalls?: unknown[]; toolResults?: unknown[] }[]; tools?: { name: string }[] },
}));

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  requireAppUser: async () => ({ user: { id: "user-1" }, supabase: state.fake!.client }),
}));
vi.mock("@/lib/billing/budget", () => ({
  reserve: vi.fn(async () => (state.reserveOk ? { ok: true, remaining: 1 } : { ok: false, reason: "budget", remaining: 0 })),
  settle: vi.fn(async () => {}),
  isProviderDisabled: vi.fn(async () => false),
  overRateLimit: vi.fn(async () => false),
}));
vi.mock("@/lib/providers", () => ({
  isLive: () => state.live,
  liveFor: () => state.live && state.key !== null,
  apiKeyFor: () => state.key,
  ADAPTERS: {
    anthropic: {
      id: "anthropic",
      async *stream(args: { system: string; history: { role: string; content: string }[]; tools?: { name: string }[] }): AsyncGenerator<StreamEvent> {
        state.lastArgs = args;
        if (state.failBeforeStart) throw new ProviderError("unavailable", 503);
        for (const e of state.events as StreamEvent[]) yield e;
      },
    },
  },
}));

import { POST } from "./route";
import * as budget from "@/lib/billing/budget";

const req = (body: object) => new Request("http://x/api/chat", { method: "POST", body: JSON.stringify(body) });
async function readEvents(res: Response) {
  const text = await res.text();
  return text.trim().split("\n").map((l) => JSON.parse(l));
}

beforeEach(() => {
  state.fake = fakeSupabase();
  state.live = false;
  state.key = "k";
  state.failBeforeStart = false;
  state.reserveOk = true;
  state.events = [{ delta: "Hi " }, { delta: "there" }, { usage: { input: 1000, output: 100, reasoning: 0, cached: 0 } }];
  vi.clearAllMocks();
});

describe("POST /api/chat", () => {
  it("rejects a model from another app", async () => {
    const res = await POST(req({ provider: "anthropic", modelId: "openai-default", content: "hi" }));
    expect(res.status).toBe(400);
  });

  it("demo mode: creates the chat, streams, saves both messages, never touches the budget", async () => {
    const res = await POST(req({ provider: "anthropic", modelId: "anthropic-default", content: "hello" }));
    const events = await readEvents(res);
    expect(events[0]).toMatchObject({ t: "meta", title: "hello" });
    expect(events.at(-1)).toMatchObject({ t: "done", status: "complete" });
    const { db } = state.fake!;
    expect(db.conversations).toHaveLength(1);
    expect(db.conversations[0]).toMatchObject({ provider: "anthropic", user_id: "user-1" });
    expect(db.messages.map((m) => [m.role, m.status])).toEqual([["user", "complete"], ["assistant", "complete"]]);
    expect(budget.reserve).not.toHaveBeenCalled();
  });

  it("live: reserves first, then settles at the actual cost", async () => {
    state.live = true;
    const res = await POST(req({ provider: "anthropic", modelId: "anthropic-default", content: "hello" }));
    await readEvents(res);
    expect(budget.reserve).toHaveBeenCalledOnce();
    // Sonnet 5.5: $2 in / $10 out per 1M → 1000×2 + 100×10 = 3000 micros
    expect(budget.settle).toHaveBeenCalledWith(expect.any(String), "settled", 3000, expect.anything(), undefined);
    expect(state.fake!.db.messages[1]).toMatchObject({ content: "Hi there", status: "complete", model_id: "anthropic-default" });
  });

  it("live: a provider that fails before replying is released (not charged) and the reply is marked error", async () => {
    state.live = true;
    state.failBeforeStart = true;
    const events = await readEvents(await POST(req({ provider: "anthropic", modelId: "anthropic-default", content: "hello" })));
    expect(events.at(-1)).toEqual({ t: "error", code: "unavailable" });
    expect(budget.settle).toHaveBeenCalledWith(expect.any(String), "released", 0, undefined, "unavailable");
    expect(state.fake!.db.messages[1].status).toBe("error");
  });

  it("live: no usage reported → charged the full reservation (uncertain)", async () => {
    state.live = true;
    state.events = [{ delta: "partial" }];
    await readEvents(await POST(req({ provider: "anthropic", modelId: "anthropic-default", content: "hello" })));
    expect(budget.settle).toHaveBeenCalledWith(expect.any(String), "uncertain", 0, undefined, "no_usage");
  });

  it("live: out of budget → 402, no provider call, chat id returned so the question isn't lost", async () => {
    state.live = true;
    state.reserveOk = false;
    const res = await POST(req({ provider: "anthropic", modelId: "anthropic-default", content: "hello" }));
    expect(res.status).toBe(402);
    expect((await res.json()).conversationId).toBe(state.fake!.db.conversations[0].id);
    expect(state.fake!.db.messages.filter((m) => m.role === "assistant")).toHaveLength(0);
  });

  it("LIVE_MODELS=on but this app has no key → labelled demo reply, no charge", async () => {
    state.live = true;
    state.key = null;
    const events = await readEvents(await POST(req({ provider: "anthropic", modelId: "anthropic-default", content: "hello" })));
    expect(events.map((e) => e.t === "delta" ? e.v : "").join("")).toContain("demo reply");
    expect(budget.reserve).not.toHaveBeenCalled();
  });

  it("retry drops the failed reply and answers the same question once", async () => {
    const first = await readEvents(await POST(req({ provider: "anthropic", modelId: "anthropic-default", content: "q" })));
    const conversationId = first[0].conversationId;
    state.fake!.db.messages[1].status = "error";
    await readEvents(await POST(req({ provider: "anthropic", modelId: "anthropic-default", conversationId, retry: true })));
    const msgs = state.fake!.db.messages;
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(1);
    expect(msgs.filter((m) => m.role === "assistant").map((m) => m.status)).toEqual(["complete"]);
  });

  it("won't continue a chat from another app", async () => {
    const first = await readEvents(await POST(req({ provider: "anthropic", modelId: "anthropic-default", content: "q" })));
    const res = await POST(req({ provider: "openai", modelId: "openai-default", content: "q2", conversationId: first[0].conversationId }));
    expect(res.status).toBe(400);
  });

  describe("files", () => {
    const seedFile = (over: Record<string, unknown> = {}) => {
      const f = { id: crypto.randomUUID(), user_id: "user-1", name: "lecture3.pdf", kind: "document", status: "ready", char_count: 200, page_count: 2, project_id: null, conversation_id: null, storage_path: "p", mime: "application/pdf", ...over };
      state.fake!.db.files.push(f);
      return f;
    };

    it("attaches an upload to the chat, sends its passages, and keeps only cited sources", async () => {
      state.live = true;
      state.events = [{ delta: "Stratified sampling splits into strata [S1]." }, { usage: { input: 10, output: 10, reasoning: 0, cached: 0 } }];
      const f = seedFile();
      state.fake!.db.file_chunks.push(
        { id: "c1", file_id: f.id, page: 1, chunk_index: 0, content: "Stratified sampling divides the population into strata." },
        { id: "c2", file_id: f.id, page: 2, chunk_index: 1, content: "Cluster sampling picks whole groups." },
      );
      const events = await readEvents(await POST(req({ provider: "anthropic", modelId: "anthropic-default", content: "Explain this", attachmentIds: [f.id] })));
      expect(state.fake!.db.files[0].conversation_id).toBe(events[0].conversationId);
      expect(state.lastArgs!.system).toContain("[S1] lecture3.pdf, p. 1");
      expect(state.lastArgs!.system).toContain("[S2] lecture3.pdf, p. 2");
      const done = events.at(-1);
      expect(done.sources.map((x: { label: string }) => x.label)).toEqual(["lecture3.pdf, p. 1"]); // S2 wasn't cited
      expect(state.fake!.db.messages[0].attachment_ids).toEqual([f.id]);
    });

    it("won't attach someone else's or an already-used file", async () => {
      const used = seedFile({ conversation_id: "other-chat" });
      await readEvents(await POST(req({ provider: "anthropic", modelId: "anthropic-default", content: "hi", attachmentIds: [used.id] })));
      expect(state.fake!.db.messages[0].attachment_ids).toEqual([]);
      expect(used.conversation_id).toBe("other-chat");
    });

    it("course-only with no matching passages tells the model to say so", async () => {
      state.live = true;
      const p = { id: crypto.randomUUID(), user_id: "user-1", name: "STATS 2244", instructions: "" };
      state.fake!.db.projects.push(p);
      const f = seedFile({ project_id: p.id, char_count: 99_999 });
      state.fake!.db.file_chunks.push({ id: "c", file_id: f.id, page: 1, chunk_index: 0, content: "Cluster sampling" });
      await readEvents(await POST(req({ provider: "anthropic", modelId: "anthropic-default", content: "photosynthesis?", projectId: p.id, courseOnly: true })));
      expect(state.lastArgs!.system).toContain("I couldn't find this in your course files");
      expect(state.fake!.db.conversations[0].course_only).toBe(true);
    });

    it("scanned PDFs are read visually: their pages go to the model as a PDF, with page references", async () => {
      state.live = true;
      const f = seedFile({ status: "needs_ocr", name: "scan.pdf", char_count: 0, page_count: 1, visual_pages: [1], storage_path: "u/scan.pdf" });
      state.fake!.storage["u/scan.pdf"] = { bytes: new Uint8Array(readFileSync(new URL("../../../test/fixtures/scanned.pdf", import.meta.url))), type: "application/pdf" };
      await readEvents(await POST(req({ provider: "anthropic", modelId: "anthropic-default", content: "read it", attachmentIds: [f.id] })));
      const last = state.lastArgs!.history.at(-1)! as { documents?: { name: string; data: string }[] };
      expect(last.documents).toHaveLength(1);
      expect(last.documents![0].name).toBe("scan.pdf (pages 1)");
      expect(Buffer.from(last.documents![0].data, "base64").subarray(0, 5).toString()).toBe("%PDF-");
      expect(state.lastArgs!.system).toContain("[S1] scan.pdf, p. 1");
    });

    it("failed files are named to the model as unreadable", async () => {
      state.live = true;
      const f = seedFile({ status: "failed", name: "broken.pdf" });
      await readEvents(await POST(req({ provider: "anthropic", modelId: "anthropic-default", content: "read it", attachmentIds: [f.id] })));
      expect(state.lastArgs!.system).toContain("couldn't be read");
      expect(state.lastArgs!.system).toContain("broken.pdf");
    });

    it("images attached to the message go to the vision model", async () => {
      state.live = true;
      const img = seedFile({ kind: "image", name: "diagram.png", mime: "image/png", storage_path: "u/img.png" });
      state.fake!.storage["u/img.png"] = { bytes: new Uint8Array([1, 2, 3]), type: "image/png" };
      await readEvents(await POST(req({ provider: "anthropic", modelId: "anthropic-default", content: "what is this?", attachmentIds: [img.id] })));
      const last = state.lastArgs!.history.at(-1)!;
      expect(last.images).toEqual([{ mime: "image/png", data: Buffer.from([1, 2, 3]).toString("base64") }]);
    });

    it("study mode sticks to the chat and reaches the prompt", async () => {
      state.live = true;
      await readEvents(await POST(req({ provider: "anthropic", modelId: "anthropic-default", content: "derivatives", mode: "quiz" })));
      expect(state.lastArgs!.system).toContain("QUIZ ME");
      expect(state.fake!.db.conversations[0].mode).toBe("quiz");
    });
  });
});

describe("folder tools", () => {
  const readCall = { id: "c1", name: "read_file", args: { path: "notes.md" } };

  async function startRun() {
    state.live = true;
    state.events = [{ delta: "Let me check." }, { toolCall: readCall }, { usage: { input: 10, output: 5, reasoning: 0, cached: 0 } }];
    const res = await POST(req({ provider: "anthropic", modelId: "anthropic-default", content: "fix my notes", folder: { name: "Essays" } }));
    return readEvents(res);
  }

  it("offers tools only when a folder is connected", async () => {
    state.live = true;
    await readEvents(await POST(req({ provider: "anthropic", modelId: "anthropic-default", content: "hi" })));
    expect(state.lastArgs!.tools).toBeUndefined();
    await startRun();
    expect(state.lastArgs!.tools!.map((t) => t.name)).toContain("edit_file");
    expect(state.lastArgs!.system).toContain('folder from their computer called "Essays"');
  });

  it("ends a round with tool_calls and keeps the reply open", async () => {
    const events = await startRun();
    const last = events.at(-1);
    expect(last).toMatchObject({ t: "tool_calls", text: "Let me check.", calls: [readCall] });
    const reply = state.fake!.db.messages.find((m) => m.id === last.replyId)!;
    expect(reply).toMatchObject({ role: "assistant", status: "partial", content: "Let me check." });
    expect(budget.settle).toHaveBeenCalledWith(expect.any(String), "settled", expect.any(Number), expect.anything(), undefined);
  });

  it("continues the same reply with the tool results, as a separate budgeted call", async () => {
    const first = await startRun();
    const { replyId } = first.at(-1);
    const conversationId = first[0].conversationId;
    state.events = [{ delta: "Fixed the typo." }, { usage: { input: 20, output: 5, reasoning: 0, cached: 0 } }];
    const steps = [{ text: "Let me check.", calls: [readCall], results: [{ id: "c1", output: "notes.md: teh cat", status: "ok" }] }];
    const res = await POST(req({ provider: "anthropic", modelId: "anthropic-default", conversationId, folder: { name: "Essays" }, run: { replyId, steps } }));
    const events = await readEvents(res);
    expect(events.at(-1)).toMatchObject({ t: "done", status: "complete" });
    const h = state.lastArgs!.history;
    expect(h.at(-2)).toMatchObject({ role: "assistant", content: "Let me check.", toolCalls: [readCall] });
    expect(h.at(-1)).toMatchObject({ role: "user", toolResults: [{ id: "c1", output: "notes.md: teh cat" }] });
    expect(h.filter((t) => t.role === "assistant" && t.content === "Let me check.")).toHaveLength(1); // not duplicated from the saved reply
    const msgs = state.fake!.db.messages;
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]); // no new rows
    expect(msgs[1]).toMatchObject({ content: "Let me check.\n\nFixed the typo.", status: "complete", tool_log: [{ name: "read_file", label: "Read notes.md", status: "ok" }] });
    expect(budget.reserve).toHaveBeenCalledTimes(2);
  });

  it("rejects a run for an old reply or with bad steps", async () => {
    const first = await startRun();
    const conversationId = first[0].conversationId;
    const good = [{ text: "", calls: [readCall], results: [{ id: "c1", output: "x", status: "ok" }] }];
    const bad = async (run: object) => (await POST(req({ provider: "anthropic", modelId: "anthropic-default", conversationId, run }))).status;
    expect(await bad({ replyId: crypto.randomUUID(), steps: good })).toBe(400);
    expect(await bad({ replyId: first.at(-1).replyId, steps: [{ ...good[0], calls: [{ ...readCall, name: "run_shell" }] }] })).toBe(400);
    expect(await bad({ replyId: first.at(-1).replyId, steps: [{ ...good[0], results: [{ id: "other", output: "x" }] }] })).toBe(400);
  });
});

describe("persistent chats and model switching", () => {
  async function ask(body: Record<string, unknown>) {
    return readEvents(await POST(req({ provider: "anthropic", ...body })));
  }

  it("switching models mid-chat: the new model gets the earlier turns and files; each reply keeps its model", async () => {
    state.live = true;
    const f1 = crypto.randomUUID();
    state.fake!.db.files.push({ id: f1, user_id: "user-1", name: "lecture3.pdf", kind: "document", status: "ready", char_count: 50, page_count: 1, project_id: null, conversation_id: null, storage_path: "p", mime: "application/pdf", visual_pages: [], image_count: 0 });
    state.fake!.db.file_chunks.push({ id: "c1", file_id: f1, page: 1, chunk_index: 0, content: "Stratified sampling splits a population into strata." });
    state.events = [{ delta: "Strata are subgroups." }, { usage: { input: 10, output: 5, reasoning: 0, cached: 0 } }];
    const first = await ask({ modelId: "anthropic-default", content: "What are strata?", attachmentIds: [f1] });
    const conversationId = first[0].conversationId;

    state.events = [{ delta: "Deeper answer." }, { usage: { input: 10, output: 5, reasoning: 0, cached: 0 } }];
    await ask({ modelId: "anthropic-opus", content: "Go deeper", conversationId });

    const h = state.lastArgs!.history;
    expect(h.map((t) => [t.role, t.content])).toEqual([["user", "What are strata?"], ["assistant", "Strata are subgroups."], ["user", "Go deeper"]]);
    expect(state.lastArgs!.system).toContain("You are Claude Opus 5.5");
    expect(state.lastArgs!.system).toContain("Stratified sampling splits"); // the file still reaches the new model
    const replies = state.fake!.db.messages.filter((m) => m.role === "assistant");
    expect(replies.map((m) => m.model_id)).toEqual(["anthropic-default", "anthropic-opus"]);
    expect(state.fake!.db.messages.find((m) => m.content === "What are strata?")!.attachment_ids).toEqual([f1]);
  });

  it("long chats keep recent messages and a structured summary of the rest; short ones get no summary", async () => {
    state.live = true;
    state.fake!.db.conversations.push({ id: "11111111-1111-4111-8111-111111111111", user_id: "user-1", provider: "anthropic", title: "t", project_id: null, mode: "chat", course_only: false, summary: "Goal: old summary", summary_upto: null });
    const conversationId = "11111111-1111-4111-8111-111111111111";
    // ~80 messages of ~3k chars: more than the 60k-token window. (Negative seq: older than anything inserted next.)
    for (let i = 0; i < 80; i++) {
      state.fake!.db.messages.push({ id: crypto.randomUUID(), seq: i - 1000, conversation_id: conversationId, user_id: "user-1", role: i % 2 ? "assistant" : "user", content: `msg ${i} ${"z".repeat(3000)}`, status: "complete", kind: "text", attachment_ids: [], model_id: "anthropic-default" });
    }
    state.events = [{ delta: "Goal: new summary" }, { usage: { input: 10, output: 5, reasoning: 0, cached: 0 } }];
    const events = await ask({ modelId: "anthropic-default", content: "and now?", conversationId });
    expect(events[0]).toMatchObject({ t: "meta", dropped: true, summarized: true });
    expect(state.lastArgs!.system).toContain("Summary of earlier parts of this chat");
    expect(state.lastArgs!.history.at(-1)!.content).toBe("and now?");
    const conv = state.fake!.db.conversations[0];
    expect(conv.summary).toBe("Goal: new summary");
    expect(conv.summary_upto as number).toBeGreaterThan(-1000);

    // A short chat with an old summary doesn't send it (everything fits).
    state.fake!.db.conversations.push({ id: "22222222-2222-4222-8222-222222222222", user_id: "user-1", provider: "anthropic", title: "s", project_id: null, mode: "chat", course_only: false, summary: "stale", summary_upto: 1 });
    await ask({ modelId: "anthropic-default", content: "hi", conversationId: "22222222-2222-4222-8222-222222222222" });
    expect(state.lastArgs!.system).not.toContain("stale");
  });
});
