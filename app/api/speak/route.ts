import { randomUUID } from "node:crypto";
import { SPEECH } from "@/config/voice";
import { json, requireAppUser } from "@/lib/api";
import { reserve, settle } from "@/lib/billing/budget";
import { defaultVoice, listVoices, speechMicros, speechService, synthesize } from "@/lib/voice/tts";

// Spoken replies.
// GET  /api/speak → { service: "elevenlabs" | "openai" | "browser", voices, defaultVoice }
// POST /api/speak { text, voice? } → audio/mpeg (streamed). Billed by characters; failures aren't charged.
export const maxDuration = 60;

export async function GET() {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  const s = speechService();
  if (!s) return json({ service: "browser", voices: [], defaultVoice: null });
  return json({ service: s.kind, voices: await listVoices(s), defaultVoice: defaultVoice(s) });
}

export async function POST(request: Request) {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  const s = speechService();
  if (!s) return json({ error: "speech_not_configured" }, 503);
  const body = (await request.json().catch(() => ({}))) as { text?: unknown; voice?: unknown };
  const text = typeof body.text === "string" ? body.text.replace(/\s+/g, " ").trim().slice(0, SPEECH.maxChars) : "";
  if (!text) return json({ error: "bad_request" }, 400);
  const voice = typeof body.voice === "string" && /^[\w-]{1,64}$/.test(body.voice) ? body.voice : defaultVoice(s);

  const id = randomUUID();
  const cost = speechMicros(s.kind, text.length);
  const r = await reserve(auth.user.id, id, SPEECH.ledgerId, "text", cost);
  if (!r.ok) return json({ error: r.reason === "budget" ? "budget" : "reserve_failed" }, r.reason === "budget" ? 402 : 503);
  const res = await synthesize(s, text, voice, request.signal).catch(() => null);
  if (!res?.ok || !res.body) {
    await settle(id, "released", 0, undefined, `speak_${res?.status ?? "failed"}`);
    return json({ error: "speak_failed" }, 502);
  }
  await settle(id, "settled", cost);
  return new Response(res.body, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
}
