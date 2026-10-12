import { WEB_SEARCH } from "@/config/search";

// Server-only. Web results come back as numbered sources [W1], [W2]… with their text and links, kept apart from
// course files [S#]. They're saved with the question, so any model the student switches to sees the same results.

export type WebResult = { title: string; url: string; content: string; published?: string | null };

export function searchKey(env: Record<string, string | undefined> = process.env): string | null {
  return env.TAVILY_API_KEY?.trim() || null;
}

/**
 * What to search for: the student's message, with the previous question added when this one is a short follow-up
 * ("and in 2025?"). Trimmed to a search-sized length.
 */
export function searchQuery(question: string, previous?: string): string {
  const q = question.replace(/\s+/g, " ").trim();
  const short = q.split(" ").length < 6;
  return (short && previous ? `${previous.replace(/\s+/g, " ").trim()} ${q}` : q).slice(0, 380);
}

export class SearchError extends Error {}

export async function webSearch(query: string, apiKey: string, signal?: AbortSignal): Promise<WebResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      max_results: WEB_SEARCH.maxResults,
      include_raw_content: "text",
      include_answer: false,
    }),
    signal: signal ?? AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!res) throw new SearchError("unreachable");
  if (!res.ok) throw new SearchError(`status_${res.status}`);
  const json = (await res.json().catch(() => null)) as { results?: { title?: string; url?: string; content?: string; raw_content?: string | null; published_date?: string | null }[] } | null;
  return (json?.results ?? [])
    .filter((r) => typeof r.url === "string" && /^https?:\/\//.test(r.url))
    .map((r) => {
      const text = (r.raw_content && r.raw_content.length > (r.content?.length ?? 0) ? r.raw_content : r.content ?? "").replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
      return { title: (r.title ?? r.url!).slice(0, 200), url: r.url!, content: text.slice(0, WEB_SEARCH.maxCharsPerResult), published: r.published_date ?? null };
    });
}

export const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};
