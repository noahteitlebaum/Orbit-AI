// Browser side of /api/transcribe, shared by the mic button and voice conversations.
const ERRORS: Record<string, string> = {
  voice_demo: "Voice works once live answers are turned on.",
  voice_not_configured: "Voice isn't set up yet (it needs the OpenAI key).",
  budget: "Not enough budget left to transcribe this.",
  trial_expired: "Your free trial has ended. Contact the Orbit team for next steps.",
  fx_not_configured: "Usage billing is not configured yet. Contact the Orbit team.",
  too_long: "That recording was too long. Keep it under 5 minutes.",
  rate_limited: "Too many requests. Wait a moment and try again.",
  bad_audio: "Your browser recorded audio in a format we can't read.",
};

export async function transcribeAudio(audio: Blob, seconds: number, hint?: string): Promise<{ text: string } | { error: string; code?: string }> {
  const form = new FormData();
  form.append("audio", audio, "question");
  form.append("seconds", String(Math.round(seconds)));
  if (hint) form.append("hint", hint);
  const res = await fetch("/api/transcribe", { method: "POST", body: form }).catch(() => null);
  if (!res?.ok) {
    const err = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
    return { error: ERRORS[err?.error ?? ""] ?? "Couldn't turn that into text. Try again.", code: err?.error };
  }
  const { text } = (await res.json()) as { text: string };
  return { text: text.trim() };
}
