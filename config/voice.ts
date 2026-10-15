// Voice input: the student records a question, OpenAI transcribes it, and the text goes into the message box to check
// before sending. Used by every AI app (needs OPENAI_API_KEY). Prices checked Oct 12 2026: gpt-4o-mini-transcribe
// about $0.003 per minute. We set aside double that before each recording and charge the estimated real cost after.
export const VOICE = {
  model: "gpt-4o-mini-transcribe",
  ledgerId: "voice-transcribe",
  pricePerMinute: 0.003, // US$
  reservePerMinute: 0.006, // US$, set aside before transcribing (never under-charges)
  maxSeconds: 300, // recordings stop after 5 minutes
  maxBytes: 4_000_000, // under Vercel's 4.5 MB request limit (5 min of Opus at 32 kbps ≈ 1.2 MB)
  bitsPerSecond: 32_000,
};

// Spoken replies (voice conversations and "Listen"). The server picks the first that's set up:
// ElevenLabs (ELEVENLABS_API_KEY) → OpenAI (OPENAI_API_KEY) → the browser's own voices (free).
// Billed by characters. Prices checked Oct 12 2026 — ElevenLabs depends on your plan (Flash v2.5 ≈ $0.05 per
// 1,000 characters on usage plans); OpenAI gpt-4o-mini-tts ≈ $0.015 per minute (≈ 900 characters).
export const SPEECH = {
  ledgerId: "voice-speak",
  maxChars: 600, // per request (one or a few sentences)
  elevenlabs: {
    model: "eleven_flash_v2_5", // lowest latency
    format: "mp3_44100_64",
    pricePer1kChars: 0.05, // US$ — set to your plan's real rate
    defaultVoice: "21m00Tcm4TlvDq8ikWAM", // "Rachel"; override with ELEVENLABS_VOICE_ID
  },
  openai: {
    model: "gpt-4o-mini-tts",
    pricePer1kChars: 0.02, // US$ (rounded up from ≈ $0.015/min)
    defaultVoice: "marin",
    voices: ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"],
    instructions: "Speak like a warm, encouraging university tutor: natural, conversational pace, clear pronunciation of technical terms.",
  },
};
