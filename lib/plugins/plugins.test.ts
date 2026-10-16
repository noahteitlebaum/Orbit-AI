import { afterEach, describe, expect, it, vi } from "vitest";
import { describePluginCall, isPluginTool, PLUGINS, pluginOfTool, pluginPrompt, pluginTools } from "./catalog";
import { BUILTIN_SKILLS, parseSkillMd, skillsPrompt } from "./skills";
import { isKnownTool, describeCall } from "@/lib/folder/tools";
import { runPluginTool } from "./run";

afterEach(() => vi.unstubAllGlobals());

describe("catalog", () => {
  it("has unique ids and tool names, all read-only, and every tool maps back to its plugin", () => {
    expect(new Set(PLUGINS.map((p) => p.id)).size).toBe(PLUGINS.length);
    const names = PLUGINS.flatMap((p) => p.tools.map((t) => t.name as string));
    expect(new Set(names).size).toBe(names.length);
    for (const p of PLUGINS) for (const t of p.tools) {
      expect(t.write).toBe(false);
      expect(pluginOfTool(t.name)).toBe(p.id);
      expect(t.name).toMatch(/^[a-z_]{3,40}$/); // valid for every provider's tool-name rules
      for (const r of t.parameters.required) expect(t.parameters.properties[r]).toBeDefined();
    }
  });
  it("plugin tools are known to the tool loop and get readable labels", () => {
    expect(isKnownTool("github_read_file")).toBe(true);
    expect(isKnownTool("github_push")).toBe(false);
    expect(isPluginTool("run_python")).toBe(false);
    expect(describeCall("github_read_file", { path: "src/a.py" })).toBe("GitHub · Read src/a.py");
    expect(describePluginCall("gmail_search", { query: "midterm" })).toBe('Gmail · Searched email for "midterm"');
    expect(pluginTools(["gmail", "youtube"]).map((t) => t.name)).toEqual(["gmail_search", "gmail_read"]);
    expect(pluginPrompt(["youtube"])).toBe("");
    expect(pluginPrompt(["notion"])).toContain("notion_search");
  });
});

describe("skills", () => {
  it("builds the prompt from valid skills only", () => {
    expect(skillsPrompt(undefined)).toBe("");
    expect(skillsPrompt([{ name: "", instructions: "x" }, "junk"])).toBe("");
    const out = skillsPrompt([{ name: "My #style\n", description: "Essays", instructions: "Be brief." }]);
    expect(out).toContain("### My  style");
    expect(out).toContain("Use when: Essays\nBe brief.");
    expect(out).toContain("never override safety");
    expect(skillsPrompt(BUILTIN_SKILLS).length).toBeLessThan(20_000);
  });
  it("reads a SKILL.md", () => {
    expect(parseSkillMd("---\nname: APA helper\ndescription: \"When citing\"\n---\nUse APA 7.")).toEqual({ name: "APA helper", description: "When citing", instructions: "Use APA 7." });
    expect(parseSkillMd("# Lab style\nAlways include units.")).toMatchObject({ name: "Lab style" });
    expect(parseSkillMd("no title at all")).toBeNull();
  });
});

describe("running plugin tools in the browser", () => {
  it("reads a public GitHub repo without sign-in", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      if (url.endsWith("/repos/octo/demo")) return Response.json({ default_branch: "main", private: false, description: "Demo", html_url: "https://github.com/octo/demo", owner: { login: "octo" }, name: "demo" });
      if (url.includes("/commits/main")) return Response.json({ sha: "abc1234def", commit: { tree: { sha: "t" } } });
      if (url.includes("/git/trees/")) return Response.json({ truncated: false, tree: [{ path: "README.md", type: "blob", size: 10, sha: "1" }, { path: "src/a.py", type: "blob", size: 20, sha: "2" }, { path: "node_modules/x.js", type: "blob", size: 1, sha: "3" }] });
      if (url.startsWith("https://raw.githubusercontent.com/octo/demo/")) return new Response(url.endsWith("README.md") ? "# Demo readme" : "print(1)");
      return new Response("", { status: 404 });
    }));
    const o = await runPluginTool("github_repo_overview", { repo: "https://github.com/octo/demo" });
    expect(o.ok && o.output).toContain("src/a.py");
    expect(o.ok && o.output).not.toContain("node_modules");
    expect(o.ok && o.output).toContain("# Demo readme");
    const f = await runPluginTool("github_read_file", { repo: "octo/demo", path: "src/a.py" });
    expect(f).toEqual({ ok: true, output: "octo/demo/src/a.py:\n\nprint(1)" });
    expect(urls.at(-1)).toBe("https://raw.githubusercontent.com/octo/demo/HEAD/src/a.py");
  });
  it("asks for sign-in where the app needs it", async () => {
    expect(await runPluginTool("gmail_search", { query: "x" })).toMatchObject({ ok: false, connect: "gmail" });
    expect(await runPluginTool("zotero_search", {})).toMatchObject({ ok: false, connect: "zotero" });
    expect(await runPluginTool("notion_search", {})).toMatchObject({ ok: false, connect: "notion" });
    expect(await runPluginTool("github_my_repos", {})).toMatchObject({ ok: false, connect: "github" });
  });
  it("explains bad input and unknown tools instead of throwing", async () => {
    expect(await runPluginTool("github_read_file", { repo: "not a repo", path: "x" })).toMatchObject({ ok: false, error: expect.stringContaining("owner/name") });
    expect(await runPluginTool("github_push", {})).toMatchObject({ ok: false });
  });
  it("reports GitHub's rate limit plainly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403, headers: { "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600) } })));
    const r = await runPluginTool("github_search_repos", { query: "avl" });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("hourly limit") });
  });
});

import { pluginLinks } from "./catalog";
describe("source links from plugin results", () => {
  it("finds links for files, articles, papers and DOIs", () => {
    expect(pluginLinks("github_read_file", "octo/demo/src/a.py:\n\nprint(1)")).toEqual([{ title: "octo/demo/src/a.py", url: "https://github.com/octo/demo/blob/HEAD/src/a.py" }]);
    expect(pluginLinks("github_read_file", "octo/demo/src/a.py @ dev:\n\nx")[0].url).toBe("https://github.com/octo/demo/blob/dev/src/a.py");
    expect(pluginLinks("wikipedia_read", "Citric acid cycle\nhttps://en.wikipedia.org/wiki/Citric_acid_cycle\n(Wikipedia…)\n\ntext")).toEqual([{ title: "Citric acid cycle", url: "https://en.wikipedia.org/wiki/Citric_acid_cycle" }]);
    expect(pluginLinks("arxiv_search", "arXiv:2101.00001v2 (2021-01-01)\ntitle: GNNs\nauthors: A\n\narXiv:2102.1 (2021)\ntitle: B")).toEqual([
      { title: "GNNs", url: "https://arxiv.org/abs/2101.00001v2" }, { title: "B", url: "https://arxiv.org/abs/2102.1" }]);
    expect(pluginLinks("scholar_search", "title: Sleep\nyear: 2019\ndoi: 10.1/abc\nlink: https://www.semanticscholar.org/paper/x")[0]).toEqual({ title: "Sleep", url: "https://www.semanticscholar.org/paper/x" });
    expect(pluginLinks("crossref_lookup", "title: Deep learning\nauthors: LeCun\ndoi: https://doi.org/10.1038/nature14539")[0].url).toBe("https://doi.org/10.1038/nature14539");
    expect(pluginLinks("gmail_read", "From: x\nSubject: y")).toEqual([]);
  });
  it("never returns non-https or script links", () => {
    expect(pluginLinks("scholar_search", "title: x\nlink: javascript:alert(1)")).toEqual([]);
    expect(pluginLinks("wikipedia_read", "T\nhttp://insecure.example\n")).toEqual([]);
  });
});
