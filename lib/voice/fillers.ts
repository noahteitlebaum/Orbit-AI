// Conversational fillers for voice mode ("Hmm…", "Okay, um…"): played the moment the student stops talking, and
// again if the answer is slow, so there's no dead air while the AI thinks. Audio is made once per voice with the same
// cloud voice as the answers and kept in the browser's cache, so they play instantly (and cost ~nothing after the
// first time). Without cloud voices the browser's own voice says them.

/** Right after the student finishes (short, so the real answer isn't delayed). */
export const QUICK_FILLERS = ["Hmm…", "Okay, um…", "Uh, okay.", "Mm, right…", "Okay, so…", "Hmm, so…", "Ah, okay…", "Um, okay…", "Right, um…", "Oh, okay…"];
/** When the answer is taking a while. */
export const SLOW_FILLERS = ["Um, let me think about that for a sec…", "Uh, give me a second…", "Hmm, okay, let me think…", "So, um, one sec…"];
/** How long to wait (after the quick filler) before saying a slow one. */
export const SLOW_AFTER_MS = 3200;

/** A random filler that isn't the one used last time. Pure (random source injectable), for tests. */
export function pickFiller(list: string[], last: string | null, rand = Math.random): string {
  const options = list.filter((f) => f !== last);
  return options[Math.floor(rand() * options.length)] ?? list[0];
}

const CACHE = "orbit-voice-fillers-v1";
const memory = new Map<string, Blob>();
const keyFor = (voice: string, text: string) => `/__filler/${encodeURIComponent(voice)}/${encodeURIComponent(text)}`;

async function fromCache(key: string): Promise<Blob | null> {
  if (memory.has(key)) return memory.get(key)!;
  try {
    const hit = await (await caches.open(CACHE)).match(key);
    if (hit) {
      const blob = await hit.blob();
      memory.set(key, blob);
      return blob;
    }
  } catch {}
  return null;
}

async function toCache(key: string, blob: Blob) {
  memory.set(key, blob);
  try {
    await (await caches.open(CACHE)).put(key, new Response(blob, { headers: { "Content-Type": blob.type || "audio/mpeg" } }));
  } catch {}
}

/** Make sure every filler has audio for this voice (fetched from /api/speak only the first time). */
const preparing = new Map<string, Promise<void>>();
export function prepareFillers(voice: string): Promise<void> {
  if (!preparing.has(voice)) preparing.set(voice, prepare(voice).finally(() => preparing.delete(voice)));
  return preparing.get(voice)!;
}
async function prepare(voice: string): Promise<void> {
  await Promise.all(
    [...QUICK_FILLERS, ...SLOW_FILLERS].map(async (text) => {
      const key = keyFor(voice, text);
      if (await fromCache(key)) return;
      const res = await fetch("/api/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, voice }) }).catch(() => null);
      if (res?.ok) {
        const blob = await res.blob();
        if (blob.size > 0) await toCache(key, blob);
      }
    }),
  );
}

/** The filler's audio for this voice, if it's ready (otherwise the browser voice says it). */
export function fillerAudio(voice: string | null, text: string): Blob | null {
  return voice ? memory.get(keyFor(voice, text)) ?? null : null;
}
