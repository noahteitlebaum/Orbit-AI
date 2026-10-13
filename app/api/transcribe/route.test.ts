import { beforeEach, describe, expect, it, vi } from "vitest";

const state = { live: true, key: "sk" as string | null, reserveOk: true };
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  requireAppUser: async () => ({ user: { id: "u1" }, supabase: {} }),
}));
vi.mock("@/lib/providers", () => ({ isLive: () => state.live, apiKeyFor: () => state.key }));
vi.mock("@/lib/billing/budget", () => ({
  overRateLimit: vi.fn(async () => false),
  reserve: vi.fn(async () => (state.reserveOk ? { ok: true, remaining: 1 } : { ok: false, reason: "budget" })),
  settle: vi.fn(async () => {}),
}));

import { POST } from "./route";
import * as budget from "@/lib/billing/budget";

const req = (audio: Blob | null, seconds = "10") => {
  const form = new FormData();
  if (audio) form.append("audio", audio, "q");
  form.append("seconds", seconds);
  return new Request("http://x/api/transcribe", { method: "POST", body: form });
};
const webm = () => new Blob([new Uint8Array(8000)], { type: "audio/webm;codecs=opus" });

beforeEach(() => {
  Object.assign(state, { live: true, key: "sk", reserveOk: true });
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ text: " What is a p-value? " })));
});

describe("POST /api/transcribe", () => {
  it("transcribes, reserving first and charging the real length after", async () => {
    const res = await POST(req(webm()));
    expect(await res.json()).toEqual({ text: "What is a p-value?", seconds: 10 });
    expect(budget.reserve).toHaveBeenCalledWith("u1", expect.any(String), "voice-transcribe", "text", 1000);
    expect(budget.settle).toHaveBeenCalledWith(expect.any(String), "settled", 500);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((init!.body as FormData).get("model")).toBe("gpt-4o-mini-transcribe");
  });

  it("doesn't charge a failed transcription", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    expect((await POST(req(webm()))).status).toBe(502);
    expect(budget.settle).toHaveBeenCalledWith(expect.any(String), "released", 0, undefined, "transcribe_failed");
  });

  it("refuses demo mode, missing key, no budget, non-audio and huge files", async () => {
    state.live = false;
    expect(await (await POST(req(webm()))).json()).toEqual({ error: "voice_demo" });
    state.live = true;
    state.key = null;
    expect(await (await POST(req(webm()))).json()).toEqual({ error: "voice_not_configured" });
    state.key = "sk";
    state.reserveOk = false;
    expect((await POST(req(webm()))).status).toBe(402);
    state.reserveOk = true;
    expect((await POST(req(new Blob(["x"], { type: "text/plain" })))).status).toBe(415);
    expect((await POST(req(new Blob([new Uint8Array(4_100_000)], { type: "audio/webm" })))).status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });
});
