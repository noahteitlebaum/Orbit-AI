"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { transcribeAudio } from "@/lib/voice/client";
import { Listener } from "@/lib/voice/listener";
import { nextSpeakable, pickVoice, saveCloudVoice, savedCloudVoice, Speaker, speechSetup, type SpeechSetup } from "@/lib/voice/speaker";
import { spokenText } from "@/lib/voice/speech";
import { fillerAudio, pickFiller, prepareFillers, QUICK_FILLERS, SLOW_AFTER_MS, SLOW_FILLERS } from "@/lib/voice/fillers";

// Voice conversation with the open AI app: listen → transcribe → send as a normal chat message → read the reply
// aloud while it's written → listen again. Everything stays in the chat as text too.
type Phase = "starting" | "listening" | "transcribing" | "thinking" | "speaking" | "paused";
type Reply = { id: string; content: string; status: string; error?: string } | null;
const VOICE_KEY = "orbit.voice.name";

const LABEL: Record<Phase, string> = {
  starting: "Starting…",
  listening: "Listening…",
  transcribing: "Got it…",
  thinking: "Thinking…",
  speaking: "Speaking",
  paused: "Paused",
};
const HINT: Partial<Record<Phase, string>> = {
  listening: "Talk normally. Tap the circle when you're done, or just pause.",
  speaking: "Tap the circle to interrupt.",
  paused: "Tap the circle to talk.",
};

export function VoiceMode({ open, onClose, appName, modelLabel, reply, onSend, onStop, hint }: {
  open: boolean;
  onClose: () => void;
  appName: string;
  modelLabel?: string;
  reply: Reply; // the newest answer in this chat (updates while it streams)
  onSend: (text: string) => Promise<void>; // sends a normal chat message (with voice: true) and resolves when the reply is done
  onStop: () => void; // stop the reply being written
  hint?: string; // course name: helps transcription with technical words
}) {
  const [phase, setPhase] = useState<Phase>("starting");
  const [heard, setHeard] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [voices, setVoices] = useState<{ id: string; name: string }[]>([]); // what the picker shows
  const [voiceName, setVoiceName] = useState<string | null>(null);
  const [service, setService] = useState<SpeechSetup | null>(null); // cloud voices (ElevenLabs/OpenAI), if the server has them
  const browserVoices = useRef<SpeechSynthesisVoice[]>([]);
  const orb = useRef<HTMLButtonElement>(null);

  const listener = useRef<Listener | null>(null);
  const speaker = useRef<Speaker | null>(null);
  const phaseRef = useRef<Phase>("starting");
  const replyRef = useRef<Reply>(reply);
  const turn = useRef({ baseline: null as string | null, spokenTo: 0, sendDone: true, interrupted: false });
  const alive = useRef(false);
  const [baseline, setBaseline] = useState<string | null>(null); // newest reply before this turn (not spoken again)
  // Latest props, read inside the long-running listen loop without restarting it.
  const props = useRef({ onSend, onStop, hint });
  useEffect(() => {
    props.current = { onSend, onStop, hint };
  });

  const go = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  // Speak whatever finished sentences of the current reply haven't been spoken yet.
  const speakNew = useCallback(() => {
    const r = replyRef.current;
    const t = turn.current;
    if (!r || r.id === t.baseline || t.interrupted || !speaker.current) return;
    const { piece, to } = nextSpeakable(r.content, t.spokenTo, r.status !== "streaming");
    t.spokenTo = to;
    if (piece.trim() && spokenText(piece).trim()) {
      speaker.current.say(piece);
      if (phaseRef.current === "thinking") go("speaking");
    }
  }, []);

  // "Hmm…", "Okay, um…": fills the silence while the answer is on its way (never the same one twice in a row).
  const lastFiller = useRef<string | null>(null);
  const sayFiller = useCallback((list: string[]) => {
    const sp = speaker.current;
    if (!sp) return;
    const text = pickFiller(list, lastFiller.current);
    if (sp.clip(text, fillerAudio(sp.cloud ? sp.cloudVoice : null, text))) lastFiller.current = text;
  }, []);

  // One loop at a time: starting a new one (tap to interrupt, resume) makes any older one stop at its next step.
  const gen = useRef(0);
  const listen = useCallback(async () => {
    const me = ++gen.current;
    const stale = () => !alive.current || gen.current !== me;
    for (;;) {
      if (stale() || !listener.current) return;
      setError(null);
      go("listening");
      const got = await listener.current.listen();
      if (stale()) return;
      if (!got) return go("paused");
      // New turn (before the filler, so the speaker finishing it doesn't count as the end of an answer).
      turn.current = { baseline: replyRef.current?.id ?? null, spokenTo: 0, sendDone: false, interrupted: false };
      if (Math.random() < 0.85) sayFiller(QUICK_FILLERS); // most turns, like a person would
      go("transcribing");
      const out = await transcribeAudio(got.audio, got.seconds, props.current.hint);
      if (stale()) return;
      if ("error" in out) {
        speaker.current?.stop();
        setError(out.error);
        return go("paused");
      }
      if (!out.text) {
        speaker.current?.stop();
        setError("Didn't catch that. Tap the circle and try again.");
        return go("paused");
      }
      setHeard(out.text);
      setBaseline(turn.current.baseline);
      go("thinking");
      // A slow answer gets a second filler ("Um, give me a second…") instead of silence.
      const slow = setTimeout(() => {
        if (!stale() && turn.current.spokenTo === 0 && !turn.current.interrupted && !speaker.current?.speaking) sayFiller(SLOW_FILLERS);
      }, SLOW_AFTER_MS);
      await props.current.onSend(out.text);
      clearTimeout(slow);
      // The final reply reaches this screen on the next render: wait for it so the last sentence isn't lost.
      for (let i = 0; i < 40; i++) {
        const r = replyRef.current;
        if (r && r.id !== turn.current.baseline && r.status !== "streaming") break;
        await new Promise((res) => setTimeout(res, 50));
      }
      if (stale()) return;
      turn.current.sendDone = true;
      const r = replyRef.current;
      if (r && r.id !== turn.current.baseline && r.status === "error") {
        setError(r.error ?? "The AI didn't answer. Tap the circle to try again.");
        return go("paused");
      }
      speakNew();
      if (speaker.current?.speaking) return; // the speaker calls listen() again when it finishes
    }
  }, [speakNew, sayFiller]);

  // Open the mic and voices when the screen opens; close everything when it closes.
  useEffect(() => {
    if (!open) return;
    alive.current = true;
    const sp = new Speaker();
    speaker.current = sp;
    sp.onIdle = () => {
      if (!alive.current) return;
      if (turn.current.sendDone && (phaseRef.current === "speaking" || phaseRef.current === "thinking")) listen();
    };
    // Browser voices are the fallback (and the only voices when the server has no speech service).
    const loadVoices = () => {
      const list = window.speechSynthesis.getVoices();
      browserVoices.current = list.filter((v) => v.lang.toLowerCase().startsWith("en"));
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(VOICE_KEY);
      } catch {}
      sp.voice = pickVoice(list, "en", saved);
      if (!sp.cloud) {
        setVoices(browserVoices.current.map((v) => ({ id: v.voiceURI, name: v.name.replace(/^(Microsoft|Google)\s+/, "") })));
        setVoiceName(sp.voice?.voiceURI ?? null);
      }
    };
    loadVoices();
    window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
    speechSetup().then((setup) => {
      if (!alive.current || setup.service === "browser") return;
      sp.cloud = true;
      sp.cloudVoice = savedCloudVoice(setup);
      setService(setup);
      setVoices(setup.voices.map((v) => ({ id: v.id, name: v.note ? `${v.name} (${v.note})` : v.name })));
      setVoiceName(sp.cloudVoice);
      if (sp.cloudVoice) void prepareFillers(sp.cloudVoice);
    });

    const l = new Listener();
    listener.current = l;
    // (The parent mounts this screen fresh each time, so state starts at "starting".)
    l.open()
      .then(() => {
        if (alive.current) listen();
      })
      .catch(() => {
        setError("Microphone access was blocked. Allow it in your browser's site settings, then try again.");
        go("paused");
      });
    return () => {
      alive.current = false;
      window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
      sp.stop();
      l.close();
      listener.current = null;
      speaker.current = null;
    };
  }, [open, listen]);

  // New text in the reply → speak it.
  useEffect(() => {
    replyRef.current = reply;
    if (open && (phaseRef.current === "thinking" || phaseRef.current === "speaking")) speakNew();
  }, [reply, open, speakNew]);

  // The circle follows the mic level while listening.
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const tick = () => {
      const el = orb.current;
      if (el) {
        const lvl = phaseRef.current === "listening" ? Math.min(1, (listener.current?.level ?? 0) * 9) : 0;
        el.style.setProperty("--level", lvl.toFixed(3));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [open]);

  function tapOrb() {
    const p = phaseRef.current;
    if (p === "listening") listener.current?.done();
    else if (p === "speaking" || p === "thinking") {
      turn.current.interrupted = true;
      speaker.current?.stop();
      if (!turn.current.sendDone) props.current.onStop();
      listen();
    } else if (p === "paused") listen();
  }

  function pause() {
    if (phaseRef.current === "listening") listener.current?.stop();
    else if (phaseRef.current === "speaking") {
      turn.current.interrupted = true;
      speaker.current?.stop();
      go("paused");
    }
  }

  function end() {
    if (!turn.current.sendDone) props.current.onStop();
    onClose();
  }

  function chooseVoice(id: string) {
    setVoiceName(id);
    if (service) {
      if (speaker.current) speaker.current.cloudVoice = id;
      saveCloudVoice(service, id);
      void prepareFillers(id);
      return;
    }
    if (speaker.current) speaker.current.voice = browserVoices.current.find((x) => x.voiceURI === id) ?? null;
    try {
      localStorage.setItem(VOICE_KEY, id);
    } catch {}
  }

  if (!open) return null;
  const answer = reply && reply.id !== baseline ? spokenText(reply.content) : "";
  const busy = phase === "thinking" || phase === "transcribing" || phase === "starting";

  return (
    <div role="dialog" aria-modal="true" aria-label={`Voice conversation with ${appName}`}
      className="fixed inset-0 z-50 flex flex-col items-center bg-surface-000 px-4 pb-6 pt-4 text-ink">
      <div className="flex w-full max-w-3xl items-center gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Voice · {appName}</p>
          {modelLabel && <p className="truncate text-xs text-ink-subtle">{modelLabel}</p>}
        </div>
        {voices.length > 1 && (
          <label className="ml-auto flex min-w-0 items-center gap-2 text-xs text-ink-subtle">
            <span className="hidden sm:inline">Voice</span>
            <select value={voiceName ?? ""} onChange={(e) => chooseVoice(e.target.value)} aria-label="Speaking voice"
              className="max-w-44 truncate rounded-full border border-line bg-surface-100 px-2.5 py-1 text-xs text-ink outline-none">
              {voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </label>
        )}
      </div>

      <div className="flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-8">
        <button ref={orb} type="button" onClick={tapOrb} aria-label={phase === "listening" ? "Done talking" : phase === "speaking" ? "Interrupt" : "Talk"}
          className={`voice-orb relative grid h-44 w-44 place-items-center rounded-full outline-none focus-visible:ring-4 focus-visible:ring-line-strong ${phase === "speaking" ? "voice-orb-speaking" : ""} ${busy ? "voice-orb-busy" : ""} ${phase === "paused" ? "opacity-60" : ""}`}>
          <span className="sr-only">{LABEL[phase]}</span>
        </button>
        <div className="text-center" aria-live="polite">
          <p className="text-lg font-medium">{LABEL[phase]}</p>
          {error ? <p className="mt-1 text-sm text-danger">{error}</p> : HINT[phase] && <p className="mt-1 text-sm text-ink-subtle">{HINT[phase]}</p>}
        </div>
        <div className="w-full space-y-3 text-center">
          {heard && <p className="text-sm text-ink-muted"><span className="text-ink-subtle">You: </span>{heard}</p>}
          {answer && (phase === "thinking" || phase === "speaking") && (
            <p className="mx-auto line-clamp-4 max-w-lg text-[15px] leading-relaxed">{answer.length > 400 ? `…${answer.slice(-400)}` : answer}</p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-4">
        <button type="button" onClick={phase === "paused" ? () => listen() : pause} disabled={phase === "starting"}
          aria-label={phase === "paused" ? "Resume" : "Pause"} title={phase === "paused" ? "Resume" : "Pause"}
          className="grid h-14 w-14 place-items-center rounded-full bg-surface-200 text-ink hover:bg-surface-300 disabled:opacity-50">
          {phase === "paused" ? (
            <svg viewBox="0 0 20 20" width="22" height="22" aria-hidden><rect x="7.25" y="2.75" width="5.5" height="9.5" rx="2.75" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          ) : (
            <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden><path d="M7 4.5v11M13 4.5v11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          )}
        </button>
        <button type="button" onClick={end} aria-label="End voice conversation" title="End"
          className="grid h-14 w-14 place-items-center rounded-full bg-danger text-white hover:opacity-90">
          <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
        </button>
      </div>
      <p className="mt-3 text-center text-xs text-ink-subtle">Your conversation is saved in this chat as text. {service ? `Voice by ${service.service === "elevenlabs" ? "ElevenLabs" : "OpenAI"}.` : "Voices are your browser's own."}</p>
    </div>
  );
}
