// Server side of voice input: send a recording to OpenAI's transcription API.
import { VOICE } from "@/config/voice";

export const AUDIO_TYPES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/aac", "audio/m4a", "audio/x-m4a"];
const EXT: Record<string, string> = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "mp4", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/aac": "aac", "audio/m4a": "m4a", "audio/x-m4a": "m4a" };

/** "audio/webm;codecs=opus" → "audio/webm" (or null if it isn't audio we accept). */
export function baseAudioType(type: string): string | null {
  const t = type.split(";")[0].trim().toLowerCase();
  return AUDIO_TYPES.includes(t) ? t : null;
}

/** Seconds of audio to bill: what the browser measured, but never less than the file size implies. */
export function billableSeconds(clientSeconds: number, bytes: number): number {
  const fromSize = bytes / (VOICE.bitsPerSecond / 8);
  const s = Math.max(Number.isFinite(clientSeconds) ? clientSeconds : 0, fromSize * 0.8);
  return Math.min(VOICE.maxSeconds, Math.max(1, Math.ceil(s)));
}

export const micros = (seconds: number, perMinute: number) => Math.ceil((seconds / 60) * perMinute * 1_000_000);

/** Transcribe. `hint` (course/topic words) helps with technical vocabulary. */
export async function transcribe(audio: Blob, type: string, apiKey: string, hint?: string, signal?: AbortSignal): Promise<string> {
  const form = new FormData();
  form.append("file", audio, `question.${EXT[type] ?? "webm"}`);
  form.append("model", VOICE.model);
  form.append("response_format", "json");
  if (hint) form.append("prompt", hint.slice(0, 500));
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: signal ?? AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`transcribe_${res.status}`);
  const out = (await res.json()) as { text?: string };
  return (out.text ?? "").trim();
}
