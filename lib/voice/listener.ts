// Hands-free listening for voice conversations: records one spoken turn and stops by itself when the student
// stops talking (voice activity detection on the microphone level). Browser only.
import { VOICE } from "@/config/voice";

export const VAD = {
  startMs: 180, // this much loud audio = the student started talking
  endSilenceMs: 1000, // this much quiet after talking = their turn is over (shorter = snappier, longer = fewer cut-offs)
  noSpeechMs: 25_000, // nobody spoke: give up and pause
  minLevel: 0.018, // RMS floor for "talking" (raised automatically in noisy rooms)
  noiseFactor: 2.6, // talking = this many times louder than the background noise
};

export type VadState = { speaking: boolean; loudMs: number; quietMs: number; elapsedMs: number; noise: number };
export type VadEvent = "none" | "start" | "end" | "timeout";
export const vadInit = (): VadState => ({ speaking: false, loudMs: 0, quietMs: 0, elapsedMs: 0, noise: 0.008 });

/** One step of voice detection: the mic level (RMS 0..1) over the last `dt` ms. Pure, so it can be tested. */
export function vadStep(s: VadState, level: number, dt: number): { state: VadState; event: VadEvent } {
  const threshold = Math.max(VAD.minLevel, s.noise * VAD.noiseFactor);
  const loud = level > threshold;
  // Background noise follows the quiet parts only.
  const noise = loud ? s.noise : s.noise * 0.95 + level * 0.05;
  const next: VadState = { ...s, noise, elapsedMs: s.elapsedMs + dt, loudMs: loud ? s.loudMs + dt : 0, quietMs: loud ? 0 : s.quietMs + dt };
  if (!s.speaking) {
    if (next.loudMs >= VAD.startMs) return { state: { ...next, speaking: true }, event: "start" };
    if (next.elapsedMs >= VAD.noSpeechMs) return { state: next, event: "timeout" };
    return { state: next, event: "none" };
  }
  if (next.quietMs >= VAD.endSilenceMs) return { state: next, event: "end" };
  if (next.elapsedMs >= VOICE.maxSeconds * 1000) return { state: next, event: "end" };
  return { state: next, event: "none" };
}

export type Turn = { audio: Blob; seconds: number } | null;

/** Keeps the microphone open for the whole conversation; `listen()` records one turn. */
export class Listener {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private buf: Float32Array<ArrayBuffer> | null = null;
  private cancel: (() => void) | null = null;
  private finishNow: (() => void) | null = null;
  level = 0; // live mic level for the animation

  async open() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
  }

  /** Current RMS level of the mic (0..1). */
  sample(): number {
    if (!this.analyser || !this.buf) return 0;
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (const v of this.buf) sum += v * v;
    this.level = Math.sqrt(sum / this.buf.length);
    return this.level;
  }

  /** Record until the student finishes talking. Resolves null on timeout or stop(). */
  listen(): Promise<Turn> {
    const stream = this.stream;
    if (!stream) return Promise.resolve(null);
    if (this.ctx?.state === "suspended") this.ctx.resume();
    return new Promise((resolve) => {
      const type = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
      const rec = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: VOICE.bitsPerSecond });
      const chunks: Blob[] = [];
      let state = vadInit();
      let spokeAt = 0;
      let done = false;
      let last = performance.now();
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const finish = (keep: boolean) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        this.cancel = null;
        this.finishNow = null;
        rec.onstop = () => {
          if (!keep) return resolve(null);
          const audio = new Blob(chunks, { type: (rec.mimeType || type || "audio/webm").split(";")[0] });
          resolve({ audio, seconds: (performance.now() - spokeAt) / 1000 + 0.3 });
        };
        if (rec.state !== "inactive") rec.stop();
        else rec.onstop(new Event("stop"));
      };
      const timer = setInterval(() => {
        const now = performance.now();
        const r = vadStep(state, this.sample(), now - last);
        last = now;
        state = r.state;
        if (r.event === "start") spokeAt = now - VAD.startMs;
        if (r.event === "end") finish(true);
        if (r.event === "timeout") finish(false);
      }, 50);
      this.cancel = () => finish(false);
      this.finishNow = () => finish(state.speaking);
      rec.start(250);
    });
  }

  /** "I'm done talking": end the turn now (keeps what was said). */
  done() {
    this.finishNow?.();
  }

  stop() {
    this.cancel?.();
  }

  close() {
    this.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
  }
}
