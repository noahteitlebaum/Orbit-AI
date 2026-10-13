import { randomUUID } from "node:crypto";
import { VOICE } from "@/config/voice";
import { json, requireAppUser } from "@/lib/api";
import { overRateLimit, reserve, settle } from "@/lib/billing/budget";
import { apiKeyFor, isLive } from "@/lib/providers";
import { baseAudioType, billableSeconds, micros, transcribe } from "@/lib/voice/transcribe";

// POST /api/transcribe (multipart: audio, seconds, hint?) → { text }
// Voice questions: auth → limits → reserve (by length) → OpenAI transcription → settle. The text goes back into the
// message box for the student to check; nothing is saved here.
export const maxDuration = 60;

export async function POST(request: Request) {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  const { user } = auth;

  const key = apiKeyFor("openai");
  if (!isLive()) return json({ error: "voice_demo" }, 503);
  if (!key) return json({ error: "voice_not_configured" }, 503);
  if (await overRateLimit(user.id)) return json({ error: "rate_limited" }, 429);

  const form = await request.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) return json({ error: "bad_request" }, 400);
  if (audio.size > VOICE.maxBytes) return json({ error: "too_long" }, 413);
  const type = baseAudioType(audio.type);
  if (!type) return json({ error: "bad_audio" }, 415);
  const seconds = billableSeconds(Number(form?.get("seconds")), audio.size);
  const hint = typeof form?.get("hint") === "string" ? (form!.get("hint") as string) : undefined;

  const id = randomUUID();
  const r = await reserve(user.id, id, VOICE.ledgerId, "text", micros(seconds, VOICE.reservePerMinute));
  if (!r.ok) return json({ error: r.reason === "budget" ? "budget" : r.reason === "global_stop" ? "paused" : "reserve_failed" }, r.reason === "budget" ? 402 : 503);
  try {
    const text = await transcribe(audio, type, key, hint);
    await settle(id, "settled", micros(seconds, VOICE.pricePerMinute));
    return json({ text, seconds });
  } catch {
    await settle(id, "released", 0, undefined, "transcribe_failed"); // a failed transcription isn't charged
    return json({ error: "transcribe_failed" }, 502);
  }
}
