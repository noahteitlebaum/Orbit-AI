"use client";

import { useEffect, useRef, useState } from "react";
import { VOICE } from "@/config/voice";
import { transcribeAudio } from "@/lib/voice/client";

// Mic button in the message box: tap to record, tap again to stop. The recording is transcribed and the text is put
// in the message box so the student can check it before sending. Stops by itself after VOICE.maxSeconds.
type State = { kind: "idle" } | { kind: "recording"; started: number } | { kind: "working" };

function pickType(): string {
  const options = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return options.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) ?? "";
}

export function VoiceButton({ onText, onError, hint, disabled, className = "" }: {
  onText: (text: string) => void;
  onError: (message: string) => void;
  hint?: string; // course name etc., helps with technical words
  disabled?: boolean;
  className?: string;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [now, setNow] = useState(0);
  const [supported, setSupported] = useState(false);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const cancelled = useRef(false);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined");
    return () => {
      cancelled.current = true;
      rec.current?.stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    if (state.kind !== "recording") return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [state.kind]);

  async function start() {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      onError("Microphone access was blocked. Allow it in your browser's site settings to talk to the AI.");
      return;
    }
    const type = pickType();
    const r = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: VOICE.bitsPerSecond });
    chunks.current = [];
    cancelled.current = false;
    const started = Date.now();
    r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    r.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      if (stopTimer.current) clearTimeout(stopTimer.current);
      if (cancelled.current) return setState({ kind: "idle" });
      const blob = new Blob(chunks.current, { type: (r.mimeType || type || "audio/webm").split(";")[0] });
      const seconds = (Date.now() - started) / 1000;
      if (seconds < 0.6 || blob.size < 1000) {
        setState({ kind: "idle" });
        return onError("That was too short. Tap the mic, speak, then tap it again.");
      }
      setState({ kind: "working" });
      const out = await transcribeAudio(blob, seconds, hint);
      setState({ kind: "idle" });
      if ("error" in out) return onError(out.error);
      const { text } = out;
      if (text) onText(text);
      else onError("Didn't catch anything. Try speaking a little closer to the mic.");
    };
    rec.current = r;
    r.start(1000);
    setNow(started);
    setState({ kind: "recording", started });
    stopTimer.current = setTimeout(() => r.state === "recording" && r.stop(), VOICE.maxSeconds * 1000);
  }

  function stop(cancel = false) {
    cancelled.current = cancel;
    if (rec.current?.state === "recording") rec.current.stop();
  }

  if (!supported) return null;
  const base = `grid h-9 w-9 shrink-0 place-items-center rounded-full transition disabled:opacity-40 ${className}`;

  if (state.kind === "recording") {
    const secs = Math.max(0, Math.floor((now - state.started) / 1000));
    return (
      <div className="flex shrink-0 items-center gap-1">
        <button type="button" onClick={() => stop(true)} aria-label="Cancel recording" title="Cancel"
          className="grid h-8 w-8 place-items-center rounded-full text-ink-muted hover:bg-surface-300 hover:text-ink">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
        <span className="flex items-center gap-1.5 text-xs tabular-nums text-ink-muted" aria-live="polite">
          <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-danger" />
          {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
        </span>
        <button type="button" onClick={() => stop()} aria-label="Stop recording and transcribe" title="Done"
          className={`${base} bg-danger text-white hover:opacity-90`}>
          <span className="h-3 w-3 rounded-[2px] bg-current" />
        </button>
      </div>
    );
  }
  return (
    <button type="button" onClick={start} disabled={disabled || state.kind === "working"}
      aria-label={state.kind === "working" ? "Transcribing…" : "Ask by voice"} title={state.kind === "working" ? "Transcribing…" : "Ask by voice"}
      className={`${base} text-ink-muted hover:bg-surface-300 hover:text-ink`}>
      {state.kind === "working" ? (
        <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : (
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden>
          <rect x="7.25" y="2.75" width="5.5" height="9.5" rx="2.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}
