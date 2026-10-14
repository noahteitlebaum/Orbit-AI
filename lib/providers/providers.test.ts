import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropic } from "./anthropic";
import { google } from "./google";
import { apiKeyFor, isLive, liveFor, liveProviders } from "./index";
import { openai } from "./openai";
import { readSse } from "./sse";
import { normalizeTurns, type StreamArgs, type StreamEvent, type ToolCall, type Usage } from "./types";
import { FOLDER_TOOLS } from "../folder/tools";
import { xai } from "./xai";
import type { ModelOption } from "../../config/models";

// Mock providers only: no live API calls.
const model = { apiModel: "test-model", label: "Test", inputPrice: 1, outputPrice: 2 } as ModelOption;
const args = (): StreamArgs => ({
  model, system: "sys", maxOutput: 100, apiKey: "k", signal: new AbortController().signal,
  history: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }, { role: "user", content: "again" }],
});

function sseResponse(events: string[], status = 200) {
  const body = new ReadableStream({
    start(c) {
      const enc = new TextEncoder();
      // split awkwardly to exercise buffering
      const all = events.map((e) => `${e}\n\n`).join("");
      for (let i = 0; i < all.length; i += 7) c.enqueue(enc.encode(all.slice(i, i + 7)));
      c.close();
    },
  });
  return new Response(body, { status });
}

async function collect(it: AsyncIterable<StreamEvent>) {
  let text = "";
  let usage: Usage | undefined;
  for await (const ev of it) {
    if (ev.delta) text += ev.delta;
    if (ev.usage) usage = ev.usage;
  }
  return { text, usage };
}

afterEach(() => vi.unstubAllGlobals());

describe("readSse", () => {
  it("parses events split across chunks, with CRLF and comments", async () => {
    const out: { event?: string; data: string }[] = [];
    const res = sseResponse([": ping", "event: a\r\ndata: 1", "data: x\ndata: y"]);
    for await (const e of readSse(res.body!)) out.push(e);
    expect(out).toEqual([{ event: "a", data: "1" }, { event: undefined, data: "x\ny" }]);
  });
});

describe("normalizeTurns", () => {
  it("merges repeated roles and drops a leading assistant turn", () => {
    expect(normalizeTurns([
      { role: "assistant", content: "a" }, { role: "user", content: "q1" }, { role: "user", content: "q2" }, { role: "assistant", content: "" },
    ])).toEqual([{ role: "user", content: "q1\n\nq2" }]);
  });
});

describe("adapters", () => {
  it("openai: streams text and usage (reasoning counted in output)", async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hel" })}`,
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "lo" })}`,
      `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } } } })}`,
    ]));
    vi.stubGlobal("fetch", fetchMock);
    expect(await collect(openai.stream(args()))).toEqual({ text: "Hello", usage: { input: 10, output: 5, reasoning: 2, cached: 0, cacheWrite: 0 } });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ model: "test-model", instructions: "sys", max_output_tokens: 100, stream: true });
  });

  it("anthropic: sends system separately and totals usage", async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 7, cache_read_input_tokens: 3, output_tokens: 1 } } })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } })}`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta:{stop_reason:"end_turn"}, usage: { output_tokens: 9 } })}`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
    ]));
    vi.stubGlobal("fetch", fetchMock);
    expect(await collect(anthropic.stream(args()))).toEqual({ text: "Hi", usage: { input: 10, output: 9, reasoning: 0, cached: 3, cacheWrite: 0, reasoningReported: false } });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.system).toBe("sys");
    expect(body.messages[0]).toEqual({ role: "user", content: "hi" });
  });

  it("google: maps assistant→model, skips thoughts, bills thinking as output", async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "hmm", thought: true }, { text: "A" }] } }] })}`,
      `data: ${JSON.stringify({ candidates: [{ finishReason:"STOP", content: { parts: [{ text: "B" }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, thoughtsTokenCount: 3 } })}`,
    ]));
    vi.stubGlobal("fetch", fetchMock);
    expect(await collect(google.stream(args()))).toEqual({ text: "AB", usage: { input: 4, output: 5, reasoning: 3, cached: 0 } });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.contents[1].role).toBe("model");
  });

  it("xai: OpenAI-style chunks with usage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "G" } }] })}`,
      `data: ${JSON.stringify({ choices: [{finish_reason:"stop"}], usage: { prompt_tokens: 3, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 1 } } })}`,
      "data: [DONE]",
    ])));
    expect(await collect(xai.stream(args()))).toEqual({ text: "G", usage: { input: 3, output: 3, reasoning: 1, cached: 0 } });
  });

  it("maps HTTP errors to provider error codes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 429 })));
    await expect(collect(anthropic.stream(args()))).rejects.toMatchObject({ code: "rate_limit", started: false });
  });
});

describe("live switch and keys", () => {
  it("is off unless LIVE_MODELS=on", () => {
    expect(isLive({})).toBe(false);
    expect(isLive({ LIVE_MODELS: "ON " })).toBe(true);
  });
  it("goes live per app: only providers with a key", () => {
    const env = { LIVE_MODELS: "on", OPENAI_API_KEY: "sk-test" };
    expect(liveFor("openai", env)).toBe(true);
    expect(liveFor("anthropic", env)).toBe(false);
    expect(liveProviders(env)).toEqual(["openai"]);
    expect(liveFor("openai", { OPENAI_API_KEY: "sk-test" })).toBe(false);
  });
  it("maps a 404 to model_unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 404 })));
    await expect(collect(openai.stream(args()))).rejects.toMatchObject({ code: "model_unavailable" });
  });
  it("reads keys from env only", () => {
    expect(apiKeyFor("google", { GEMINI_API_KEY: " g " })).toBe("g");
    expect(apiKeyFor("xai", {})).toBeNull();
  });
});

describe("folder tools", () => {
  const tools = FOLDER_TOOLS.filter((t) => t.name === "read_file");
  // A run in progress: the model asked to read a file and got the result back.
  const toolHistory = (): StreamArgs["history"] => [
    { role: "user", content: "fix my notes" },
    { role: "assistant", content: "Let me look.", toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.md" }, meta: { thoughtSignature: "sig", providerId: true } }] },
    { role: "user", content: "", toolResults: [{ id: "c1", name: "read_file", output: "a.md: hello" }] },
  ];
  const run = async (adapter: typeof openai, events: string[]) => {
    const fetchMock = vi.fn(async () => sseResponse(events));
    vi.stubGlobal("fetch", fetchMock);
    const calls: ToolCall[] = [];
    for await (const ev of adapter.stream({ ...args(), history: toolHistory(), tools })) if (ev.toolCall) calls.push(ev.toolCall);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    return { calls, body };
  };

  it("OpenAI: sends function tools + call/output items, parses calls", async () => {
    const { calls, body } = await run(openai, [
      `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", call_id: "c2", name: "read_file", arguments: '{"path":"b.md"}' } })}`,
      `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } })}`,
    ]);
    expect(calls).toEqual([{ id: "c2", name: "read_file", args: { path: "b.md" } }]);
    expect(body.tools[0]).toMatchObject({ type: "function", name: "read_file" });
    expect(body.input).toEqual([
      { role: "user", content: "fix my notes" },
      { role: "assistant", content: "Let me look." },
      { type: "function_call", call_id: "c1", name: "read_file", arguments: '{"path":"a.md"}' },
      { type: "function_call_output", call_id: "c1", output: "a.md: hello" },
    ]);
  });

  it("Anthropic: tool_use / tool_result blocks, streamed JSON input", async () => {
    const { calls, body } = await run(anthropic, [
      `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1 } } })}`,
      `data: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t2", name: "read_file" } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"pa' } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'th":"b.md"}' } })}`,
      `data: ${JSON.stringify({ type: "content_block_stop", index: 1 })}`,
      `data: ${JSON.stringify({type:"message_delta",delta:{stop_reason:"tool_use"},usage:{output_tokens:1}})}`,
      `data: ${JSON.stringify({ type: "message_stop" })}`,
    ]);
    expect(calls).toEqual([{ id: "t2", name: "read_file", args: { path: "b.md" } }]);
    expect(body.tools[0]).toMatchObject({ name: "read_file", input_schema: { type: "object" } });
    expect(body.messages[1].content).toEqual([{ type: "text", text: "Let me look." }, { type: "tool_use", id: "c1", name: "read_file", input: { path: "a.md" } }]);
    expect(body.messages[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "a.md: hello" }] });
  });

  it("Gemini: functionDeclarations, returns thought signatures", async () => {
    const { calls, body } = await run(google, [
      `data: ${JSON.stringify({ candidates: [{ finishReason:"STOP", content: { parts: [{ functionCall: { name: "read_file", args: { path: "b.md" } }, thoughtSignature: "s2" }] } }] })}`,
    ]);
    expect(calls[0]).toMatchObject({ name: "read_file", args: { path: "b.md" }, meta: { thoughtSignature: "s2", providerId: false } });
    expect(body.tools[0].functionDeclarations[0].name).toBe("read_file");
    expect(body.contents[1]).toEqual({
      role: "model",
      parts: [{ text: "Let me look." }, { functionCall: { name: "read_file", args: { path: "a.md" }, id: "c1" }, thoughtSignature: "sig" }],
    });
    expect(body.contents[2]).toEqual({ role: "user", parts: [{ functionResponse: { name: "read_file", response: { output: "a.md: hello" } } }] });
  });

  it("xAI: assembles streamed tool_calls, sends tool messages", async () => {
    const chunk = (tc: object) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [tc] } }] })}`;
    const { calls, body } = await run(xai, [
      chunk({ index: 0, id: "x1", function: { name: "read_file", arguments: '{"path":' } }),
      chunk({ index: 0, function: { arguments: '"b.md"}' } }),
      `data: ${JSON.stringify({choices:[{finish_reason:"tool_calls"}]})}`,
      "data: [DONE]",
    ]);
    expect(calls).toEqual([{ id: "x1", name: "read_file", args: { path: "b.md" } }]);
    expect(body.tools[0]).toMatchObject({ type: "function", function: { name: "read_file" } });
    expect(body.messages[2]).toMatchObject({ role: "assistant", content: "Let me look.", tool_calls: [{ id: "c1", function: { name: "read_file", arguments: '{"path":"a.md"}' } }] });
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "a.md: hello" });
  });

  it("never merges tool turns into neighbours", () => {
    const out = normalizeTurns(toolHistory());
    expect(out).toHaveLength(3);
  });
});

describe("voice: think less so replies start sooner", () => {
  afterEach(() => vi.unstubAllGlobals());
  const done = () => sseResponse([`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}`, `data: ${JSON.stringify({ type: "response.completed", response: {} })}`]);
  const bodyOf = (m: ReturnType<typeof vi.fn>, i: number) => JSON.parse((m.mock.calls[i] as unknown as [string, RequestInit])[1].body as string);

  it("openai asks for low reasoning effort, and asks normally if the model doesn't support it", async () => {
    let fetchMock = vi.fn(async () => done());
    vi.stubGlobal("fetch", fetchMock);
    await collect(openai.stream({ ...args(), fast: true }));
    expect(bodyOf(fetchMock, 0).reasoning).toEqual({ effort: "low" });
    fetchMock = vi.fn().mockResolvedValueOnce(new Response("bad", { status: 400 })).mockResolvedValueOnce(done());
    vi.stubGlobal("fetch", fetchMock);
    expect((await collect(openai.stream({ ...args(), fast: true }))).text).toBe("ok");
    expect(bodyOf(fetchMock, 1).reasoning).toBeUndefined();
  });

  it("gemini asks for low thinking", async () => {
    const fetchMock = vi.fn(async () => sseResponse([`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] })}`]));
    vi.stubGlobal("fetch", fetchMock);
    await collect(google.stream({ ...args(), fast: true }));
    expect(bodyOf(fetchMock, 0).generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
    await collect(google.stream(args()));
    expect(bodyOf(fetchMock, 1).generationConfig.thinkingConfig).toBeUndefined();
  });

  it("gemini watches YouTube links at low resolution", async () => {
    const fetchMock = vi.fn(async () => sseResponse([`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] })}`]));
    vi.stubGlobal("fetch", fetchMock);
    const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    await collect(google.stream({ ...args(), history: [{ role: "user", content: `Summarize ${url}`, videos: [url] }] }));
    const body = bodyOf(fetchMock, 0);
    expect(body.contents[0].parts).toEqual([{ fileData: { fileUri: url } }, { text: `Summarize ${url}` }]);
    expect(body.generationConfig.mediaResolution).toBe("MEDIA_RESOLUTION_LOW");
    await collect(google.stream(args()));
    expect(bodyOf(fetchMock, 1).generationConfig.mediaResolution).toBeUndefined();
  });
});

describe("key names", () => {
  it("accepts CLAUDE_API_KEY for Claude and GOOGLE_API_KEY for Gemini", () => {
    expect(apiKeyFor("anthropic", { CLAUDE_API_KEY: " sk-ant " })).toBe("sk-ant");
    expect(apiKeyFor("anthropic", { ANTHROPIC_API_KEY: "a", CLAUDE_API_KEY: "b" })).toBe("a");
    expect(apiKeyFor("google", { GOOGLE_API_KEY: "g" })).toBe("g");
    expect(liveFor("anthropic", { LIVE_MODELS: "on", CLAUDE_API_KEY: "x" })).toBe(true);
  });
});

describe("openai optional settings", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("keeps prompt_cache_key within 64 characters and retries a 400 without optional settings", async () => {
    const ok = () => sseResponse([`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}`, `data: ${JSON.stringify({ type: "response.completed", response: {} })}`]);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("bad", { status: 400 })).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);
    expect((await collect(openai.stream({ ...args(), cacheKey: "x".repeat(80) }))).text).toBe("ok");
    const body = (i: number) => JSON.parse((fetchMock.mock.calls[i] as unknown as [string, RequestInit])[1].body as string);
    expect(body(0).prompt_cache_key).toHaveLength(64);
    expect(body(1).prompt_cache_key).toBeUndefined();
  });
});
