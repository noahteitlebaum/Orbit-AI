import { describe, expect, it } from "vitest";
import { speechChunks, spokenText } from "./speech";
import { baseAudioType, billableSeconds, micros } from "./transcribe";

describe("transcription billing", () => {
  it("accepts browser audio types", () => {
    expect(baseAudioType("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(baseAudioType("audio/mp4")).toBe("audio/mp4");
    expect(baseAudioType("video/webm")).toBeNull();
  });
  it("bills what was recorded, never less than the file size implies, capped at 5 minutes", () => {
    expect(billableSeconds(12.2, 40_000)).toBe(13);
    expect(billableSeconds(1, 400_000)).toBe(80); // claimed 1 s, but 400 KB at 32 kbps ≈ 100 s
    expect(billableSeconds(NaN, 100)).toBe(1);
    expect(billableSeconds(9999, 10)).toBe(300);
    expect(micros(60, 0.003)).toBe(3000);
  });
});

describe("reading answers aloud", () => {
  it("drops citations, code and table pipes; says simple math", () => {
    const t = spokenText("## Variance\nIt is $\\sigma^2$ [S1], i.e. $\\frac{a}{b}$.\n```python\nprint(1)\n```\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(t).toContain("Variance");
    expect(t).toContain("sigma squared, i.e. a over b.");
    expect(t).toContain("(code shown on screen)");
    expect(t).not.toMatch(/\[S1\]|\||print/);
  });
  it("splits long text into short pieces", () => {
    const parts = speechChunks("One. Two! " + "word ".repeat(100));
    expect(parts.slice(0, 2)).toEqual(["One.", "Two!"]);
    expect(Math.max(...parts.map((p) => p.length))).toBeLessThanOrEqual(220);
  });
});

import { vadInit, vadStep, VAD } from "./listener";
import { nextSpeakable, pickVoice } from "./speaker";

describe("voice conversation", () => {
  it("detects the start and end of a spoken turn, ignoring background noise", () => {
    let s = vadInit();
    const run = (level: number, ms: number) => {
      const events: string[] = [];
      for (let t = 0; t < ms; t += 50) {
        const r = vadStep(s, level, 50);
        s = r.state;
        if (r.event !== "none") events.push(r.event);
      }
      return events;
    };
    expect(run(0.01, 2000)).toEqual([]); // room noise
    expect(run(0.08, 1000)).toEqual(["start"]); // talking
    expect(run(0.01, 600)).toEqual([]); // short pause mid-sentence
    expect(run(0.08, 300)).toEqual([]);
    expect(run(0.01, VAD.endSilenceMs + 100)[0]).toBe("end"); // the listener stops at the first "end"
  });

  it("gives up when nobody speaks", () => {
    let s = vadInit();
    let ev = "none";
    for (let t = 0; t <= VAD.noSpeechMs; t += 50) ({ state: s, event: ev } = vadStep(s, 0.005, 50) as { state: typeof s; event: string });
    expect(ev).toBe("timeout");
  });

  it("speaks finished sentences while the reply is still streaming", () => {
    expect(nextSpeakable("Variance is spread. It is", 0, false)).toEqual({ piece: "Variance is spread.", to: 19 });
    expect(nextSpeakable("Variance is spread. It is", 19, false)).toEqual({ piece: "", to: 19 });
    expect(nextSpeakable("Variance is spread. It is squared.", 19, true)).toEqual({ piece: " It is squared.", to: 34 });
    expect(nextSpeakable("Done. [[remember: x", 0, false).piece).toBe("Done.");
    expect(nextSpeakable("Pi is 3.14 roughly", 0, false).piece).toBe(""); // "3.14" isn't a sentence end
  });

  it("prefers natural voices in the right language", () => {
    const v = (name: string, lang: string) => ({ name, lang, voiceURI: name }) as SpeechSynthesisVoice;
    const list = [v("Alex", "en-US"), v("Thomas", "fr-FR"), v("Microsoft Aria Online (Natural)", "en-US"), v("Google UK English", "en-GB")];
    expect(pickVoice(list)?.name).toBe("Microsoft Aria Online (Natural)");
    expect(pickVoice(list, "en", "Alex")?.name).toBe("Alex");
  });
});

import { groupChunks } from "./speaker";
describe("cloud speech requests", () => {
  it("groups sentences into requests of up to 300 characters", () => {
    const s = "This is a sentence of about forty chars. ";
    const parts = groupChunks(s.repeat(12).trim());
    expect(parts.length).toBe(2);
    expect(Math.max(...parts.map((p) => p.length))).toBeLessThanOrEqual(300);
  });
});

import { pickFiller, QUICK_FILLERS } from "./fillers";
describe("fillers", () => {
  it("never repeats the last one", () => {
    let last: string | null = null;
    for (let i = 0; i < 50; i++) {
      const f = pickFiller(QUICK_FILLERS, last);
      expect(f).not.toBe(last);
      last = f;
    }
    expect(pickFiller(["Hmm…", "Okay…"], "Hmm…", () => 0.99)).toBe("Okay…");
  });
});
