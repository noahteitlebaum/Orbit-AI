// Research plugins that need no sign-in (Wikipedia, arXiv, Semantic Scholar, Crossref). Our server calls them for the
// browser (/api/plugins/public) because not all of them allow browser calls. URLs are built here from fixed hosts —
// the model only supplies search words, titles and DOIs — so this can't be used to fetch arbitrary pages.

export const PUBLIC_TOOLS = ["wikipedia_search", "wikipedia_read", "arxiv_search", "scholar_search", "crossref_lookup", "wolfram_query"] as const;
export type PublicTool = (typeof PUBLIC_TOOLS)[number];
export const isPublicTool = (v: unknown): v is PublicTool => typeof v === "string" && (PUBLIC_TOOLS as readonly string[]).includes(v);

const UA = "OrbitAI/1.0 (student study app; https://orbit-ai.vercel.app)";
const MAX = 40_000;
const str = (v: unknown, n = 300) => (typeof v === "string" ? v.trim().slice(0, n) : typeof v === "number" ? String(v) : "");
const clip = (s: string, n = MAX) => (s.length > n ? `${s.slice(0, n)}\n[cut off]` : s);
const stripTags = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

export class PublicToolError extends Error {}

async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const res = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res) throw new PublicToolError("The service didn't respond. Try again.");
  if (res.status === 429) throw new PublicToolError("The service is busy (too many requests). Try again in a minute.");
  if (res.status === 404) throw new PublicToolError("Not found.");
  if (!res.ok) throw new PublicToolError(`The service returned an error (${res.status}).`);
  return res;
}

const lang = (v: unknown) => (/^[a-z]{2,3}(-[a-z]+)?$/.test(str(v, 10)) ? str(v, 10) : "en");

// ---------------------------------------------------------------- pure parsers (tested)
/** arXiv's Atom feed → entries. Pure. */
export function parseArxiv(xml: string): { id: string; title: string; authors: string[]; published: string; summary: string; pdf: string }[] {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
    const tag = (t: string) => stripTags(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`).exec(e)?.[1] ?? "");
    const id = tag("id");
    return {
      id: id.replace(/^https?:\/\/arxiv\.org\/abs\//, ""),
      title: tag("title"),
      authors: [...e.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => stripTags(m[1])),
      published: tag("published").slice(0, 10),
      summary: tag("summary"),
      pdf: /<link[^>]*title="pdf"[^>]*href="([^"]+)"/.exec(e)?.[1] ?? id.replace("/abs/", "/pdf/"),
    };
  });
}

type CrossrefWork = { DOI: string; title?: string[]; author?: { given?: string; family?: string; name?: string }[]; "container-title"?: string[]; issued?: { "date-parts"?: number[][] }; volume?: string; issue?: string; page?: string; publisher?: string; type?: string; URL?: string };
/** Crossref work → readable lines (the AI formats the citation style the student wants). Pure. */
export function formatCrossref(w: CrossrefWork): string {
  const year = w.issued?.["date-parts"]?.[0]?.[0];
  return [
    `title: ${w.title?.[0] ?? "(untitled)"}`,
    `authors: ${(w.author ?? []).map((a) => a.name ?? [a.family, a.given].filter(Boolean).join(", ")).join("; ") || "(none listed)"}`,
    `year: ${year ?? "n.d."}`,
    w["container-title"]?.[0] ? `in: ${w["container-title"][0]}` : "",
    [w.volume && `volume ${w.volume}`, w.issue && `issue ${w.issue}`, w.page && `pages ${w.page}`].filter(Boolean).join(", "),
    w.publisher ? `publisher: ${w.publisher}` : "",
    w.type ? `type: ${w.type}` : "",
    `doi: https://doi.org/${w.DOI}`,
  ].filter(Boolean).join("\n");
}

export const cleanDoi = (v: string) => v.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "");

/** Plugins that only work once the team sets a server key. */
export function serverPluginsReady(): string[] {
  return process.env.WOLFRAM_APP_ID?.trim() ? ["wolfram"] : [];
}

// ---------------------------------------------------------------- the tools
export async function runPublicTool(tool: PublicTool, a: Record<string, unknown>): Promise<string> {
  switch (tool) {
    case "wikipedia_search": {
      const q = str(a.query);
      if (!q) throw new PublicToolError("What should I search for?");
      const l = lang(a.lang);
      const j = (await (await get(`https://${l}.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=8&srsearch=${encodeURIComponent(q)}`)).json()) as
        { query?: { search?: { title: string; snippet: string; wordcount: number }[] } };
      const hits = j.query?.search ?? [];
      return hits.length ? hits.map((h) => `title: ${h.title}\n${stripTags(h.snippet)}…`).join("\n\n") : "No Wikipedia articles found.";
    }
    case "wikipedia_read": {
      const title = str(a.title);
      if (!title) throw new PublicToolError("Which article? Give its title.");
      const l = lang(a.lang);
      const j = (await (await get(`https://${l}.wikipedia.org/w/api.php?action=query&prop=extracts|info&inprop=url&explaintext=1&redirects=1&format=json&titles=${encodeURIComponent(title)}`)).json()) as
        { query?: { pages?: Record<string, { title?: string; extract?: string; fullurl?: string; missing?: string }> } };
      const page = Object.values(j.query?.pages ?? {})[0];
      if (!page || page.missing !== undefined || !page.extract) throw new PublicToolError(`No Wikipedia article called "${title}".`);
      return clip(`${page.title}\n${page.fullurl ?? ""}\n(Wikipedia — check important facts against course material or primary sources.)\n\n${page.extract}`);
    }
    case "arxiv_search": {
      const q = str(a.query);
      if (!q) throw new PublicToolError("What should I search for?");
      const n = Math.min(10, Math.max(1, Number(a.max) || 6));
      const xml = await (await get(`https://export.arxiv.org/api/query?search_query=${encodeURIComponent(`all:${q}`)}&start=0&max_results=${n}&sortBy=relevance`)).text();
      const list = parseArxiv(xml);
      return list.length
        ? clip(list.map((p) => `arXiv:${p.id} (${p.published})\ntitle: ${p.title}\nauthors: ${p.authors.slice(0, 8).join(", ")}${p.authors.length > 8 ? " et al." : ""}\npdf: ${p.pdf}\nabstract: ${p.summary}`).join("\n\n"))
        : "No arXiv papers found.";
    }
    case "scholar_search": {
      const q = str(a.query);
      if (!q) throw new PublicToolError("What should I search for?");
      const year = /^\d{4}(-\d{4})?$/.test(str(a.year, 9)) ? `&year=${str(a.year, 9)}` : "";
      const key = process.env.SEMANTIC_SCHOLAR_API_KEY?.trim();
      const j = (await (await get(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=8${year}&fields=title,year,authors,venue,citationCount,abstract,url,externalIds,openAccessPdf,tldr`, key ? { "x-api-key": key } : {})).json()) as
        { data?: { title: string; year?: number; authors?: { name: string }[]; venue?: string; citationCount?: number; abstract?: string | null; url?: string; externalIds?: { DOI?: string }; openAccessPdf?: { url?: string } | null; tldr?: { text?: string } | null }[] };
      const list = j.data ?? [];
      return list.length
        ? clip(list.map((p) => [
            `title: ${p.title}`, `year: ${p.year ?? "n.d."} · cited by ${p.citationCount ?? 0}${p.venue ? ` · ${p.venue}` : ""}`,
            `authors: ${(p.authors ?? []).slice(0, 8).map((x) => x.name).join(", ")}`,
            p.externalIds?.DOI ? `doi: ${p.externalIds.DOI}` : "", p.url ? `link: ${p.url}` : "", p.openAccessPdf?.url ? `free pdf: ${p.openAccessPdf.url}` : "",
            p.tldr?.text ? `tl;dr: ${p.tldr.text}` : "", p.abstract ? `abstract: ${p.abstract.slice(0, 1500)}` : "",
          ].filter(Boolean).join("\n")).join("\n\n"))
        : "No papers found.";
    }
    case "wolfram_query": {
      const appid = process.env.WOLFRAM_APP_ID?.trim();
      if (!appid) throw new PublicToolError("Wolfram|Alpha isn't set up on this server (WOLFRAM_APP_ID).");
      const q = str(a.input, 500);
      if (!q) throw new PublicToolError("What should Wolfram|Alpha compute?");
      const res = await fetch(`https://www.wolframalpha.com/api/v1/llm-api?input=${encodeURIComponent(q)}&appid=${encodeURIComponent(appid)}&maxchars=6000`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
      if (!res) throw new PublicToolError("Wolfram|Alpha didn't respond. Try again.");
      const text = await res.text();
      // 501 = Wolfram couldn't interpret the input; its text suggests rewordings, which helps the model retry.
      if (res.status === 501 || res.status === 400) return `Wolfram|Alpha couldn't interpret that. ${text.slice(0, 1500)}`;
      if (res.status === 403) throw new PublicToolError("Wolfram|Alpha rejected the app id.");
      if (!res.ok) throw new PublicToolError(`Wolfram|Alpha returned an error (${res.status}).`);
      return clip(text, 8000);
    }
    case "crossref_lookup": {
      const mailto = process.env.CROSSREF_MAILTO?.trim();
      const polite = mailto ? `mailto=${encodeURIComponent(mailto)}` : "";
      const doi = cleanDoi(str(a.doi, 200));
      if (doi) {
        if (!/^10\.\d{4,9}\/\S+$/.test(doi)) throw new PublicToolError("That doesn't look like a DOI (they start with 10.).");
        const j = (await (await get(`https://api.crossref.org/works/${doi.split("/").map(encodeURIComponent).join("/")}${polite ? `?${polite}` : ""}`)).json()) as { message: CrossrefWork };
        return formatCrossref(j.message);
      }
      const q = str(a.query);
      if (!q) throw new PublicToolError("Give a DOI or a title to look up.");
      const j = (await (await get(`https://api.crossref.org/works?rows=5&query.bibliographic=${encodeURIComponent(q)}${polite ? `&${polite}` : ""}`)).json()) as { message: { items: CrossrefWork[] } };
      return j.message.items.length ? j.message.items.map(formatCrossref).join("\n\n") : "Nothing found in Crossref.";
    }
  }
}
