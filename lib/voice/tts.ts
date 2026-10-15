// Server side of spoken replies: which service to use, its voices, and one request for a few sentences of audio.
import { SPEECH } from "@/config/voice";
import { apiKeyFor, isLive } from "@/lib/providers";

export type SpeechService = { kind: "elevenlabs" | "openai"; key: string } | null;
export type VoiceOption = { id: string; name: string; note?: string };

export function speechService(env: Record<string, string | undefined> = process.env): SpeechService {
  if (!isLive(env)) return null;
  const eleven = env.ELEVENLABS_API_KEY?.trim();
  if (eleven) return { kind: "elevenlabs", key: eleven };
  const openai = apiKeyFor("openai", env);
  return openai ? { kind: "openai", key: openai } : null;
}

export const speechMicros = (kind: "elevenlabs" | "openai", chars: number) =>
  Math.ceil((chars / 1000) * SPEECH[kind].pricePer1kChars * 1_000_000);

export function defaultVoice(s: NonNullable<SpeechService>, env: Record<string, string | undefined> = process.env): string {
  return s.kind === "elevenlabs" ? env.ELEVENLABS_VOICE_ID?.trim() || SPEECH.elevenlabs.defaultVoice : SPEECH.openai.defaultVoice;
}

let cache: { at: number; voices: VoiceOption[] } | null = null;
/** Voices to pick from. ElevenLabs: the account's voices (cached for an hour). */
export async function listVoices(s: NonNullable<SpeechService>): Promise<VoiceOption[]> {
  if (s.kind === "openai") return SPEECH.openai.voices.map((v) => ({ id: v, name: v[0].toUpperCase() + v.slice(1), note: v === "marin" || v === "cedar" ? "most natural" : undefined }));
  if (cache && Date.now() - cache.at < 3_600_000) return cache.voices;
  const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": s.key }, signal: AbortSignal.timeout(8_000) }).catch(() => null);
  if (!res?.ok) return [{ id: defaultVoice(s), name: "Default voice" }];
  const out = (await res.json()) as { voices?: { voice_id: string; name: string; labels?: Record<string, string> }[] };
  const voices = (out.voices ?? []).slice(0, 60).map((v) => ({
    id: v.voice_id, name: v.name.split(" - ")[0], note: [v.labels?.accent, v.labels?.gender, v.labels?.description ?? v.labels?.descriptive].filter(Boolean).join(", ") || undefined,
  }));
  cache = { at: Date.now(), voices };
  return voices;
}

/** Start generating audio (MP3). Returns the provider's response, whose body streams the audio. */
export function synthesize(s: NonNullable<SpeechService>, text: string, voice: string, signal?: AbortSignal): Promise<Response> {
  if (s.kind === "elevenlabs") {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=${SPEECH.elevenlabs.format}`;
    return fetch(url, {
      method: "POST",
      headers: { "xi-api-key": s.key, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: SPEECH.elevenlabs.model, voice_settings: { stability: 0.45, similarity_boost: 0.8, speed: 1.05 } }),
      signal: signal ?? AbortSignal.timeout(30_000),
    });
  }
  return fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${s.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: SPEECH.openai.model, voice, input: text, response_format: "mp3", instructions: SPEECH.openai.instructions }),
    signal: signal ?? AbortSignal.timeout(30_000),
  });
}
