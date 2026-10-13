// Speaks a reply while it is still being written: complete sentences are queued as they arrive.
// Cloud voices (ElevenLabs or OpenAI via /api/speak) when the server has them, otherwise the browser's own voices.
// Audio for the next sentences is fetched while the current one plays, so there are no gaps. Browser only.
import { speechChunks, spokenText } from "./speech";

/** The part of `text` (from `from`) that ends at a finished sentence, and where it stops. Pure, for tests. */
export function nextSpeakable(text: string, from: number, final: boolean): { piece: string; to: number } {
  const rest = text.slice(from);
  if (final) return { piece: rest, to: text.length };
  // Last sentence end (. ! ? or a line break) followed by whitespace, outside an unfinished [[marker.
  const open = rest.lastIndexOf("[[");
  const scan = open >= 0 && rest.indexOf("]]", open) < 0 ? rest.slice(0, open) : rest;
  let end = -1;
  for (const m of scan.matchAll(/[.!?](?=\s)|\n/g)) end = m.index! + 1;
  if (end < 0) return { piece: "", to: from };
  return { piece: rest.slice(0, end), to: from + end };
}

/** Sentences grouped into requests of up to `max` characters (fewer requests, natural flow). */
export function groupChunks(text: string, max = 300): string[] {
  const out: string[] = [];
  for (const s of speechChunks(text)) {
    const last = out.at(-1);
    if (last && last.length + s.length + 1 <= max) out[out.length - 1] = `${last} ${s}`;
    else out.push(s);
  }
  return out;
}

/** The nicest available browser voice for the language: "Natural"/"Online"/Google voices first. */
export function pickVoice(voices: SpeechSynthesisVoice[], lang = "en", preferred?: string | null): SpeechSynthesisVoice | null {
  if (preferred) {
    const v = voices.find((x) => x.voiceURI === preferred);
    if (v) return v;
  }
  const mine = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
  const score = (v: SpeechSynthesisVoice) =>
    (/natural|neural|online/i.test(v.name) ? 4 : 0) + (/google/i.test(v.name) ? 3 : 0) + (/samantha|aria|jenny|guy|daniel/i.test(v.name) ? 2 : 0) +
    (/en-(us|ca)/i.test(v.lang) ? 1 : 0);
  return [...mine].sort((a, b) => score(b) - score(a))[0] ?? voices[0] ?? null;
}

// ---------------------------------------------------------------- which voices the server offers
export type SpeechSetup = { service: "elevenlabs" | "openai" | "browser"; voices: { id: string; name: string; note?: string }[]; defaultVoice: string | null };
const CLOUD_VOICE_KEY = "orbit.voice.cloud";
let setup: Promise<SpeechSetup> | null = null;
export function speechSetup(): Promise<SpeechSetup> {
  setup ??= fetch("/api/speak")
    .then((r) => (r.ok ? (r.json() as Promise<SpeechSetup>) : { service: "browser" as const, voices: [], defaultVoice: null }))
    .catch(() => ({ service: "browser" as const, voices: [], defaultVoice: null }));
  return setup;
}
export function savedCloudVoice(s: SpeechSetup): string | null {
  let v: string | null = null;
  try {
    v = localStorage.getItem(`${CLOUD_VOICE_KEY}.${s.service}`);
  } catch {}
  return v && s.voices.some((x) => x.id === v) ? v : s.defaultVoice;
}
export function saveCloudVoice(s: SpeechSetup, id: string) {
  try {
    localStorage.setItem(`${CLOUD_VOICE_KEY}.${s.service}`, id);
  } catch {}
}

// ---------------------------------------------------------------- the speaker
type Item = { text: string; audio: Promise<Blob | null>; ctrl: AbortController };

export class Speaker {
  cloud = false; // use /api/speak
  cloudVoice: string | null = null;
  voice: SpeechSynthesisVoice | null = null; // browser voice (fallback)
  rate = 1.05;
  onIdle: () => void = () => {};
  private items: Item[] = [];
  private gen = 0;
  private playing = false;
  private browserQueue = 0;
  private audio: HTMLAudioElement | null = null;
  private endCurrent: (() => void) | null = null;

  get speaking() {
    return this.playing || this.items.length > 0 || this.browserQueue > 0;
  }

  /** Queue some reply text (Markdown-ish); it's cleaned up for speech first. */
  say(text: string) {
    const clean = spokenText(text);
    if (!clean.trim()) return;
    if (!this.cloud) {
      this.speakBrowser(clean);
      return;
    }
    for (const chunk of groupChunks(clean)) {
      const ctrl = new AbortController();
      const audio = fetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: chunk, voice: this.cloudVoice ?? undefined }),
        signal: ctrl.signal,
      })
        .then((r) => (r.ok ? r.blob() : null))
        .catch(() => null);
      this.items.push({ text: chunk, audio, ctrl });
    }
    void this.pump();
  }

  /** A ready-made clip (a filler like "Hmm…"). With cloud voices but no audio yet, it's skipped rather than said in a
   *  different (browser) voice. Returns whether anything will be heard. */
  clip(text: string, audio: Blob | null): boolean {
    if (this.cloud) {
      if (!audio) return false;
      this.items.push({ text, audio: Promise.resolve(audio), ctrl: new AbortController() });
      void this.pump();
      return true;
    }
    this.speakBrowser(text);
    return true;
  }

  private async pump() {
    if (this.playing) return;
    this.playing = true;
    const gen = this.gen;
    while (this.items.length && gen === this.gen) {
      const it = this.items[0];
      const blob = await it.audio;
      if (gen !== this.gen) return;
      this.items.shift();
      if (blob && blob.size > 0) await this.play(blob, gen);
      else await this.speakBrowserNow(it.text, gen); // the cloud voice failed: don't skip the sentence
    }
    if (gen !== this.gen) return;
    this.playing = false;
    if (!this.speaking) this.onIdle();
  }

  private play(blob: Blob, gen: number): Promise<void> {
    this.audio ??= new Audio();
    const a = this.audio;
    const url = URL.createObjectURL(blob);
    return new Promise<void>((resolve) => {
      const done = () => {
        a.onended = a.onerror = null;
        this.endCurrent = null;
        URL.revokeObjectURL(url);
        resolve();
      };
      this.endCurrent = done;
      a.onended = done;
      a.onerror = done;
      a.src = url;
      a.playbackRate = 1;
      a.play().catch(done);
      if (gen !== this.gen) done();
    });
  }

  private utterances(text: string) {
    return speechChunks(text).map((c) => {
      const u = new SpeechSynthesisUtterance(c);
      if (this.voice) {
        u.voice = this.voice;
        u.lang = this.voice.lang;
      }
      u.rate = this.rate;
      return u;
    });
  }

  /** Browser voice, queued (no cloud voices). */
  private speakBrowser(text: string) {
    const synth = window.speechSynthesis;
    const gen = this.gen;
    for (const u of this.utterances(text)) {
      this.browserQueue++;
      const done = () => {
        if (gen !== this.gen) return;
        this.browserQueue = Math.max(0, this.browserQueue - 1);
        if (!this.speaking) this.onIdle();
      };
      u.onend = done;
      u.onerror = done;
      synth.speak(u);
    }
    if (synth.paused) synth.resume();
  }

  /** Browser voice inside the cloud queue (resolves when done). */
  private speakBrowserNow(text: string, gen: number): Promise<void> {
    return new Promise((resolve) => {
      const list = this.utterances(text);
      if (!list.length || gen !== this.gen) return resolve();
      list.at(-1)!.onend = () => resolve();
      list.forEach((u) => (u.onerror = () => resolve()));
      list.forEach((u) => window.speechSynthesis.speak(u));
    });
  }

  stop() {
    this.gen++;
    for (const it of this.items) it.ctrl.abort();
    this.items = [];
    this.playing = false;
    this.browserQueue = 0;
    this.audio?.pause();
    this.endCurrent?.();
    if (typeof window !== "undefined") window.speechSynthesis.cancel();
  }
}
