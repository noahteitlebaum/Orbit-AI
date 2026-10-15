import { beforeEach, describe, expect, it, vi } from "vitest";

const env = process.env;
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  requireAppUser: async () => ({ user: { id: "u1" }, supabase: {} }),
}));
vi.mock("@/lib/billing/budget", () => ({
  reserve: vi.fn(async () => ({ ok: true, remaining: 1 })),
  settle: vi.fn(async () => {}),
}));

import { GET, POST } from "./route";
import * as budget from "@/lib/billing/budget";

const post = (body: object) => POST(new Request("http://x/api/speak", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  process.env = { ...env, LIVE_MODELS: "on", OPENAI_API_KEY: "sk", ELEVENLABS_API_KEY: "" };
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "audio/mpeg" } })));
});

describe("/api/speak", () => {
  it("uses OpenAI voices when there's no ElevenLabs key, billed by characters", async () => {
    expect(await (await GET()).json()).toMatchObject({ service: "openai", defaultVoice: "marin" });
    const res = await post({ text: "Standard deviation is the square root of variance.", voice: "cedar" });
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    expect(JSON.parse(String(init!.body))).toMatchObject({ model: "gpt-4o-mini-tts", voice: "cedar" });
    expect(budget.reserve).toHaveBeenCalledWith("u1", expect.any(String), "voice-speak", "text", 1000, { provider: "openai", operation: "speech" }); // 50 chars × $0.02 per 1,000
  });

  it("prefers ElevenLabs when its key is set", async () => {
    process.env.ELEVENLABS_API_KEY = "xi";
    await post({ text: "Hello there." });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toMatch(/^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/21m00Tcm4TlvDq8ikWAM\/stream/);
    expect((init!.headers as Record<string, string>)["xi-api-key"]).toBe("xi");
    expect(JSON.parse(String(init!.body))).toMatchObject({ model_id: "eleven_flash_v2_5" });
  });

  it("falls back to browser voices in demo mode, and doesn't charge failures", async () => {
    process.env.LIVE_MODELS = "off";
    expect(await (await GET()).json()).toMatchObject({ service: "browser" });
    process.env.LIVE_MODELS = "on";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    expect((await post({ text: "Hi." })).status).toBe(502);
    expect(budget.settle).toHaveBeenCalledWith(expect.any(String), "released", 0, undefined, "speak_500");
  });
});
