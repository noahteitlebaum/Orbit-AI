"use client";

import { useEffect, useState } from "react";
import { pickVoice, savedCloudVoice, Speaker, speechSetup } from "@/lib/voice/speaker";

// "Listen" under an answer: read it aloud with the same voice as voice conversations (ElevenLabs/OpenAI when set up,
// otherwise the browser's own voices). Only one answer plays at a time.
let playing: { id: string; speaker: Speaker; done: () => void } | null = null;

export function SpeakButton({ id, text, compact = false }: { id: string; text: string; compact?: boolean }) {
  const [supported, setSupported] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(typeof window !== "undefined" && ("speechSynthesis" in window || typeof Audio !== "undefined"));
    return () => {
      if (playing?.id === id) stopPlaying();
    };
  }, [id]);
  if (!supported) return null;

  function stopPlaying() {
    playing?.speaker.stop();
    playing?.done();
    playing = null;
  }

  async function play() {
    stopPlaying();
    const sp = new Speaker();
    const setup = await speechSetup();
    if (setup.service !== "browser") {
      sp.cloud = true;
      sp.cloudVoice = savedCloudVoice(setup);
    }
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("orbit.voice.name");
    } catch {}
    if ("speechSynthesis" in window) sp.voice = pickVoice(window.speechSynthesis.getVoices(), "en", saved);
    const done = () => setSpeaking(false);
    sp.onIdle = () => {
      if (playing?.speaker === sp) playing = null;
      done();
    };
    playing = { id, speaker: sp, done };
    setSpeaking(true);
    sp.say(text);
  }

  const icon = speaking ? (
    <span aria-hidden className="h-2.5 w-2.5 rounded-[2px] bg-current" />
  ) : (
    <svg viewBox="0 0 16 16" width={compact ? 16 : 13} height={compact ? 16 : 13} aria-hidden><path d="M3 6.2h2.2L8.5 3.5v9L5.2 9.8H3zM10.8 5.6a3.3 3.3 0 0 1 0 4.8M12.6 3.8a5.8 5.8 0 0 1 0 8.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
  );
  if (compact)
    return (
      <button type="button" onClick={() => (speaking ? stopPlaying() : play())} aria-pressed={speaking} aria-label={speaking ? "Stop reading" : "Read aloud"} title={speaking ? "Stop" : "Read aloud"}
        className="grid h-8 w-8 place-items-center rounded-lg text-ink-muted transition hover:bg-surface-200 hover:text-ink">
        {icon}
      </button>
    );
  return (
    <button type="button" onClick={() => (speaking ? stopPlaying() : play())} aria-pressed={speaking}
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-ink-muted hover:bg-surface-200 hover:text-ink">
      {icon}
      {speaking ? "Stop" : "Listen"}
    </button>
  );
}
