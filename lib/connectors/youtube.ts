// YouTube videos (integration memo #9): Gemini watches public YouTube videos directly (Gemini API "YouTube URL" input),
// so a link in the question is passed to Gemini as video. Other providers just see the link text. No downloading,
// no transcript scraping. Low media resolution keeps a 10-minute video near 60k tokens.
export const YOUTUBE = {
  maxVideos: 1,
  reserveTokens: 60_000, // reservation per video (~10 min at low resolution, ~100 tokens/second); settled on real usage
};

const ID = /^[A-Za-z0-9_-]{11}$/;

/** The 11-character video id from any YouTube link (watch, youtu.be, shorts, embed, live), or null. Pure. */
export function youtubeId(link: string): string | null {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else {
      const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([^/?#]+)/);
      if (m) id = m[2];
    }
  }
  return id && ID.test(id) ? id : null;
}

/** Canonical watch URLs for the YouTube links in a message (deduplicated, up to `max`). Pure. */
export function youtubeLinks(text: string, max = YOUTUBE.maxVideos): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube(?:-nocookie)?\.com\/[^\s)>\]]+|youtu\.be\/[^\s)>\]]+)/gi)) {
    const id = youtubeId(m[0]);
    const url = id && `https://www.youtube.com/watch?v=${id}`;
    if (url && !out.includes(url)) out.push(url);
    if (out.length >= max) break;
  }
  return out;
}
