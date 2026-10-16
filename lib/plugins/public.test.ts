import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanDoi, formatCrossref, parseArxiv, runPublicTool } from "./public";

afterEach(() => vi.unstubAllGlobals());

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2101.00001v2</id>
    <published>2021-01-01T00:00:00Z</published>
    <title>Graph Neural
      Networks &amp; You</title>
    <summary>  We study GNNs.  </summary>
    <author><name>Ada Lovelace</name></author>
    <author><name>Alan Turing</name></author>
    <link title="pdf" href="http://arxiv.org/pdf/2101.00001v2" rel="related" type="application/pdf"/>
  </entry>
</feed>`;

describe("parsers", () => {
  it("reads arXiv's Atom feed", () => {
    expect(parseArxiv(ATOM)).toEqual([{ id: "2101.00001v2", title: "Graph Neural Networks & You", authors: ["Ada Lovelace", "Alan Turing"], published: "2021-01-01", summary: "We study GNNs.", pdf: "http://arxiv.org/pdf/2101.00001v2" }]);
  });
  it("formats Crossref works and cleans DOIs", () => {
    expect(cleanDoi("https://doi.org/10.1038/nature14539")).toBe("10.1038/nature14539");
    expect(cleanDoi("doi: 10.1/x")).toBe("10.1/x");
    const out = formatCrossref({ DOI: "10.1038/nature14539", title: ["Deep learning"], author: [{ given: "Yann", family: "LeCun" }, { given: "Yoshua", family: "Bengio" }], "container-title": ["Nature"], issued: { "date-parts": [[2015, 5, 27]] }, volume: "521", issue: "7553", page: "436-444" });
    expect(out).toContain("authors: LeCun, Yann; Bengio, Yoshua");
    expect(out).toContain("year: 2015");
    expect(out).toContain("volume 521, issue 7553, pages 436-444");
    expect(out).toContain("doi: https://doi.org/10.1038/nature14539");
  });
});

describe("tools (mocked services)", () => {
  it("search and read Wikipedia, only on wikipedia.org", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      urls.push(u);
      if (u.includes("list=search")) return Response.json({ query: { search: [{ title: "Citric acid cycle", snippet: 'The <span class="searchmatch">Krebs</span> cycle', wordcount: 5000 }] } });
      return Response.json({ query: { pages: { "1": { title: "Citric acid cycle", fullurl: "https://en.wikipedia.org/wiki/Citric_acid_cycle", extract: "The citric acid cycle is…" } } } });
    }));
    expect(await runPublicTool("wikipedia_search", { query: "krebs", lang: "en" })).toBe("title: Citric acid cycle\nThe Krebs cycle…");
    expect(await runPublicTool("wikipedia_read", { title: "Citric acid cycle", lang: "evil.com/x?" })).toContain("https://en.wikipedia.org/wiki/Citric_acid_cycle");
    expect(urls.every((u) => u.startsWith("https://en.wikipedia.org/w/api.php?"))).toBe(true);
  });
  it("reports a missing article", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ query: { pages: { "-1": { title: "Nope", missing: "" } } } })));
    await expect(runPublicTool("wikipedia_read", { title: "Nope" })).rejects.toThrow(/No Wikipedia article/);
  });
  it("searches arXiv and Semantic Scholar", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => u.includes("arxiv") ? new Response(ATOM)
      : Response.json({ data: [{ title: "Sleep and memory", year: 2019, authors: [{ name: "M. Walker" }], venue: "Neuron", citationCount: 812, abstract: "Sleep helps.", url: "https://s2/x", externalIds: { DOI: "10.1/abc" }, openAccessPdf: { url: "https://pdf" }, tldr: { text: "Sleep consolidates memory." } }] })));
    expect(await runPublicTool("arxiv_search", { query: "gnn" })).toContain("arXiv:2101.00001v2 (2021-01-01)");
    const s2 = await runPublicTool("scholar_search", { query: "sleep memory", year: "2015-2024" });
    expect(s2).toContain("cited by 812");
    expect(s2).toContain("doi: 10.1/abc");
    expect(s2).toContain("tl;dr: Sleep consolidates memory.");
  });
  it("looks up a DOI and rejects non-DOIs", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => { urls.push(u); return Response.json({ message: { DOI: "10.1038/nature14539", title: ["Deep learning"], issued: { "date-parts": [[2015]] } } }); }));
    expect(await runPublicTool("crossref_lookup", { doi: "https://doi.org/10.1038/nature14539" })).toContain("title: Deep learning");
    expect(urls[0]).toBe("https://api.crossref.org/works/10.1038/nature14539");
    await expect(runPublicTool("crossref_lookup", { doi: "../../etc" })).rejects.toThrow(/doesn't look like a DOI/);
    await expect(runPublicTool("crossref_lookup", {})).rejects.toThrow(/DOI or a title/);
  });
  it("explains rate limits", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429 })));
    await expect(runPublicTool("scholar_search", { query: "x" })).rejects.toThrow(/busy/);
  });
});

describe("Wolfram|Alpha", () => {
  afterEach(() => { delete process.env.WOLFRAM_APP_ID; });
  it("needs the server key, then returns Wolfram's text (and its suggestions when it can't parse)", async () => {
    await expect(runPublicTool("wolfram_query", { input: "2+2" })).rejects.toThrow(/isn't set up/);
    process.env.WOLFRAM_APP_ID = "APPID";
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => { urls.push(u); return u.includes("gibberish") ? new Response("Try: 2+2", { status: 501 }) : new Response("Input: integrate x^2\nResult: x^3/3 + constant"); }));
    expect(await runPublicTool("wolfram_query", { input: "integrate x^2" })).toContain("x^3/3");
    expect(urls[0]).toBe("https://www.wolframalpha.com/api/v1/llm-api?input=integrate%20x%5E2&appid=APPID&maxchars=6000");
    expect(await runPublicTool("wolfram_query", { input: "gibberish" })).toContain("couldn't interpret");
  });
});
