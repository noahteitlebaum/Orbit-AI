import { afterEach, describe, expect, it, vi } from "vitest";
import { actionDraft, describePluginCall, isPluginAction, isPluginTool, PLUGINS, pluginOfTool, pluginPrompt, pluginTools } from "./catalog";
import { BUILTIN_SKILLS, parseSkillMd, skillsPrompt } from "./skills";
import { isKnownTool, describeCall } from "@/lib/folder/tools";
import { runPluginTool } from "./run";

afterEach(() => vi.unstubAllGlobals());

describe("catalog", () => {
  it("has unique ids and tool names, read-only except the confirmed actions, and every tool maps back to its plugin", () => {
    expect(new Set(PLUGINS.map((p) => p.id)).size).toBe(PLUGINS.length);
    const names = PLUGINS.flatMap((p) => p.tools.map((t) => t.name as string));
    expect(new Set(names).size).toBe(names.length);
    for (const p of PLUGINS) for (const t of p.tools) {
      // Only Google and Microsoft apps can change things, and every change has a confirm card.
      if (t.write) expect(["gmail", "google-calendar", "google-drive", "outlook", "outlook-calendar", "onedrive"]).toContain(p.id);
      if (t.write && !/_send$|_create_draft$/.test(t.name as string)) expect(actionDraft(t.name, {})).not.toBeNull();
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
    expect(pluginTools(["gmail", "youtube"]).map((t) => t.name)).toEqual(["gmail_search", "gmail_read", "gmail_send", "gmail_create_draft", "gmail_modify", "gmail_trash"]);
    expect(isPluginAction("gmail_send")).toBe(true);
    expect(isPluginAction("gmail_read")).toBe(false);
    expect(describePluginCall("gmail_send", { to: "ta@uwo.ca" })).toBe("Gmail · Email to ta@uwo.ca");
    expect(pluginPrompt(["gmail"])).toContain("read-only except these actions: gmail_send, gmail_create_draft, gmail_modify, gmail_trash.");
    expect(pluginPrompt(["github"])).toContain("The apps are read-only");
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

describe("google drive plugin", () => {
  it("escapes search words for Drive's query language", async () => {
    const { driveQuery } = await import("./run");
    expect(driveQuery("")).toBe("trashed = false");
    expect(driveQuery("prof's notes")).toBe("(name contains 'prof\\'s notes' or fullText contains 'prof\\'s notes') and trashed = false");
  });
  it("searches, then reads a Google Doc by exporting it as text", async () => {
    vi.resetModules();
    vi.doMock("@/lib/connectors/google-drive", () => ({ googleTokenCached: () => "tok", googleToken: async () => "tok" }));
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      if (url.includes("/export?")) return new Response("Lab 3: build an AVL tree.");
      if (url.includes("/files/doc1234567890?")) return new Response(JSON.stringify({ id: "doc1234567890", name: "Lab 3 handout", mimeType: "application/vnd.google-apps.document", webViewLink: "https://docs.google.com/document/d/doc1234567890" }));
      return new Response(JSON.stringify({ files: [{ id: "doc1234567890", name: "Lab 3 handout", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-10-01T00:00:00Z", webViewLink: "https://docs.google.com/document/d/doc1234567890" }, { id: "f", name: "Folder", mimeType: "application/vnd.google-apps.folder" }] }));
    }));
    const { runPluginTool } = await import("./run");
    const { pluginLinks } = await import("./catalog");
    const found = await runPluginTool("google_drive_search", { query: "lab 3" });
    expect(found).toMatchObject({ ok: true });
    if (!found.ok) return;
    expect(found.output).toContain("type: Google Doc");
    expect(found.output).toContain("type: folder"); // folders are listed so files can be moved into them
    expect(pluginLinks("google_drive_search", found.output)[0]).toEqual({ title: "Lab 3 handout", url: "https://docs.google.com/document/d/doc1234567890" });
    const read = await runPluginTool("google_drive_read", { id: "doc1234567890" });
    expect(read).toEqual({ ok: true, output: expect.stringContaining("Lab 3: build an AVL tree.") });
    expect(urls.at(-1)).toContain("mimeType=text%2Fplain");
    vi.doUnmock("@/lib/connectors/google-drive");
  });
});

describe("google drive actions", () => {
  it("renames and creates Docs with the right permissions", async () => {
    vi.resetModules();
    const scopes: string[][] = [];
    vi.doMock("@/lib/connectors/google-drive", () => ({ googleTokenCached: () => null, googleToken: async (s: string[]) => { scopes.push(s); return "tok"; } }));
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (init.method === "PATCH") return new Response(JSON.stringify({ id: "file1234567890", name: JSON.parse(init.body as string).name, webViewLink: "https://drive.google.com/x" }));
      return new Response(JSON.stringify({ id: "new1", name: "Study guide", webViewLink: "https://docs.google.com/document/d/new1" }));
    }));
    const { runPluginTool } = await import("./run");
    const { actionDraft } = await import("./catalog");
    // Actions don't need the read sign-in first: Google asks for the permission when the student confirms.
    expect(await runPluginTool("google_drive_rename", { id: "file1234567890", new_name: "Midterm Finance - Cheat Sheet" })).toEqual({ ok: true, output: expect.stringContaining('Renamed to "Midterm Finance - Cheat Sheet"') });
    expect(calls[0].url).toContain("/files/file1234567890?");
    expect(await runPluginTool("google_drive_create_doc", { title: "Study guide", content: "# Week 1" })).toMatchObject({ ok: true });
    expect(calls[1].url).toContain("uploadType=multipart");
    expect(calls[1].init.body).toContain('"mimeType":"application/vnd.google-apps.document"');
    expect(scopes).toEqual([["https://www.googleapis.com/auth/drive"], ["https://www.googleapis.com/auth/drive.file"]]);
    expect(actionDraft("google_drive_rename", { current_name: "A", new_name: "B" })).toMatchObject({ confirm: "Rename", note: "Now: A", fields: [{ key: "new_name", value: "B" }] });
    expect(actionDraft("gmail_read", {})).toBeNull();
    vi.doUnmock("@/lib/connectors/google-drive");
  });
});

describe("google write helpers", () => {
  it("parses CSV with quotes and builds calendar times", async () => {
    const { parseCsv } = await import("./run");
    expect(parseCsv('Item,Cost\n"Books, used",45\nCoffee,"=SUM(1,2)"\n\n')).toEqual([["Item", "Cost"], ["Books, used", "45"], ["Coffee", "=SUM(1,2)"]]);
    expect(parseCsv('a,"say ""hi"""\r\nb,2')).toEqual([["a", 'say "hi"'], ["b", "2"]]);
    const { eventTimes } = await import("@/lib/connectors/mail-calendar");
    expect(eventTimes("2026-10-20T14:00", "", "America/Toronto")).toEqual({ start: { dateTime: "2026-10-20T14:00:00", timeZone: "America/Toronto" }, end: { dateTime: "2026-10-20T15:00:00", timeZone: "America/Toronto" } });
    expect(eventTimes("2026-10-20T23:30", "2026-10-21T01:00", "UTC").end.dateTime).toBe("2026-10-21T01:00:00");
    expect(eventTimes("2026-10-31", "", "UTC")).toEqual({ start: { date: "2026-10-31" }, end: { date: "2026-11-01" } });
    expect(eventTimes("2026-10-26", "2026-10-30", "UTC").end).toEqual({ date: "2026-10-31" }); // Google's end is exclusive
    expect(() => eventTimes("next tuesday", "", "UTC")).toThrow(/isn't a time/);
  });
  it("runs Gmail, Calendar and Sheets changes with the right permission each", async () => {
    vi.resetModules();
    const scopes: string[] = [];
    vi.doMock("@/lib/connectors/google-drive", () => ({ googleTokenCached: () => null, googleToken: async (s: string[]) => { scopes.push(...s); return "tok"; } }));
    const calls: { url: string; method?: string; body?: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method, body: init.body as string | undefined });
      if (url.endsWith("/labels") && (init.method ?? "GET") === "GET") return new Response(JSON.stringify({ labels: [{ id: "L1", name: "School" }] }));
      if (url.includes("calendar/v3")) return new Response(JSON.stringify({ summary: "Study: finance", htmlLink: "https://calendar.google.com/e" }));
      if (url.includes("sheets.googleapis.com")) return new Response(JSON.stringify({ updates: { updatedRange: "Sheet1!A5:B6" } }));
      return new Response("{}");
    }));
    const { runPluginTool } = await import("./run");
    expect(await runPluginTool("gmail_modify", { ids: "abc123, def456", change: "add_label", label: "school", description: "2 emails" })).toEqual({ ok: true, output: expect.stringContaining("2 emails") });
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ ids: ["abc123", "def456"], addLabelIds: ["L1"], removeLabelIds: [] });
    expect(await runPluginTool("gmail_modify", { ids: "abc123", change: "delete_forever", description: "x" })).toMatchObject({ ok: false, error: expect.stringContaining("Unknown change") });
    expect(await runPluginTool("google_calendar_create_event", { title: "Study: finance", start: "2026-10-20T14:00" })).toMatchObject({ ok: true });
    expect(JSON.parse(calls.at(-1)!.body!)).toMatchObject({ summary: "Study: finance", start: { dateTime: "2026-10-20T14:00:00" } });
    expect(await runPluginTool("google_calendar_delete_event", { id: "evt12345", current_title: "x" })).toMatchObject({ ok: true });
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" });
    expect(await runPluginTool("google_sheets_append_rows", { id: "sheet1234567890", name: "Budget", rows: "Coffee,4.50\nBooks,45" })).toEqual({ ok: true, output: expect.stringContaining("Added 2 rows") });
    expect(calls.at(-1)!.url).toContain("/values/A1:append?insertDataOption=INSERT_ROWS&valueInputOption=USER_ENTERED");
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ values: [["Coffee", "4.50"], ["Books", "45"]] });
    expect(new Set(scopes)).toEqual(new Set(["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/drive"]));
    vi.doUnmock("@/lib/connectors/google-drive");
  });
});

describe("microsoft actions", () => {
  it("pure helpers: recipients, event times, Excel columns", async () => {
    const m = await import("@/lib/connectors/microsoft-actions");
    expect(m.recipients("ta@uwo.ca; Prof <p@uwo.ca>")).toEqual([{ emailAddress: { address: "ta@uwo.ca" } }, { emailAddress: { address: "p@uwo.ca" } }]);
    expect(() => m.recipients("nope")).toThrow(/isn't an email/);
    expect(m.msEventTimes("2026-10-28T19:00", "", "America/Toronto")).toEqual({ isAllDay: false, start: { dateTime: "2026-10-28T19:00:00", timeZone: "America/Toronto" }, end: { dateTime: "2026-10-28T20:00:00", timeZone: "America/Toronto" } });
    expect(m.msEventTimes("2026-10-31", "", "UTC")).toMatchObject({ isAllDay: true, start: { dateTime: "2026-10-31T00:00:00" }, end: { dateTime: "2026-11-01T00:00:00" } });
    expect([1, 26, 27, 52, 703].map(m.colLetter)).toEqual(["A", "Z", "AA", "AZ", "AAA"]);
  });
  it("sends, replies, organizes and appends with the right Graph calls and permissions", async () => {
    vi.resetModules();
    const scopes: string[] = [];
    vi.doMock("@/lib/connectors/onedrive", () => ({ msToken: async (s: string[]) => { scopes.push(...s); return "ms"; }, msTokenSilent: async () => null, listOneDrive: async () => [], searchOneDrive: async () => [] }));
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body });
      if (url.includes("?$select=categories")) return Response.json({ categories: ["School"] });
      if (url.includes("/worksheets?$select=name")) return Response.json({ value: [{ name: "Hours" }] });
      if (url.includes("usedRange")) return Response.json({ address: "Hours!A1:C12", rowCount: 12 });
      if (url.endsWith("/sendMail") || url.endsWith("/reply")) return new Response(null, { status: 202 });
      return Response.json({ name: "x", webLink: "https://outlook.office.com/e" });
    }));
    const { runPluginTool } = await import("./run");
    expect(await runPluginTool("outlook_send", { to: "ta@uwo.ca", subject: "Lab", body: "Hi" })).toEqual({ ok: true, output: "Sent to ta@uwo.ca." });
    expect(calls.at(-1)).toMatchObject({ method: "POST", body: { message: { subject: "Lab", toRecipients: [{ emailAddress: { address: "ta@uwo.ca" } }] }, saveToSentItems: true } });
    expect(await runPluginTool("outlook_send", { body: "Thanks!", reply_to: "AAMkAGI2" })).toMatchObject({ ok: true });
    expect(calls.at(-1)!.url).toMatch(/\/me\/messages\/AAMkAGI2\/reply$/);
    await runPluginTool("outlook_modify", { ids: "AAMkAGI2", change: "add_category", category: "Finance", description: "1" });
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", body: { categories: ["School", "Finance"] } });
    await runPluginTool("outlook_trash", { ids: "AAMkAGI2", description: "1" });
    expect(calls.at(-1)).toMatchObject({ body: { destinationId: "deleteditems" } });
    expect(await runPluginTool("excel_append_rows", { id: "01ABCDEF", name: "Timesheet", rows: "Oct 17,3.5\nOct 18,2" })).toEqual({ ok: true, output: "Added 2 rows to Hours (A13:B14)." });
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", body: { values: [["Oct 17", "3.5"], ["Oct 18", "2"]] } });
    expect(await runPluginTool("outlook_calendar_create_event", { title: "Finance midterm", start: "2026-10-28T19:00" })).toMatchObject({ ok: true });
    expect(calls.at(-1)).toMatchObject({ method: "POST", body: { subject: "Finance midterm", isAllDay: false } });
    expect(new Set(scopes)).toEqual(new Set(["Mail.Send", "Mail.ReadWrite", "Files.ReadWrite", "Calendars.ReadWrite"]));
    vi.doUnmock("@/lib/connectors/onedrive");
  });
});
