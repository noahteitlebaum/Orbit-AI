import { afterEach, describe, expect, it, vi } from "vitest";
import { youtubeId, youtubeLinks } from "./youtube";
import { blocksToMarkdown, bundleNotion, pageTitle, richText, type NotionBlock } from "./notion";
import { apaCitation, bundleZotero, connectZotero, readZotero, searchZotero, type ZoteroItem } from "./zotero";
import { bundleEmails, bundleEvents, decodeB64Url, gmailBody, htmlToText } from "./mail-calendar";

afterEach(() => vi.unstubAllGlobals());

describe("youtube", () => {
  it("reads ids from every link shape", () => {
    for (const l of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s", "youtu.be/dQw4w9WgXcQ", "https://m.youtube.com/shorts/dQw4w9WgXcQ", "https://www.youtube.com/embed/dQw4w9WgXcQ", "youtube.com/live/dQw4w9WgXcQ?si=x"])
      expect(youtubeId(l)).toBe("dQw4w9WgXcQ");
    expect(youtubeId("https://youtube.com/watch?v=short")).toBeNull();
    expect(youtubeId("https://evil.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  });
  it("finds links in a message, canonical and deduplicated", () => {
    expect(youtubeLinks("Summarize https://youtu.be/dQw4w9WgXcQ and (https://www.youtube.com/watch?v=dQw4w9WgXcQ)", 3)).toEqual(["https://www.youtube.com/watch?v=dQw4w9WgXcQ"]);
    expect(youtubeLinks("no video here")).toEqual([]);
  });
});

describe("notion", () => {
  const rt = (t: string, a: Record<string, boolean> = {}, href?: string) => ({ plain_text: t, annotations: a, href });
  it("converts rich text", () => {
    expect(richText([rt("bold", { bold: true }), rt(" and "), rt("link", {}, "https://x.y"), { plain_text: "", type: "equation", equation: { expression: "E=mc^2" } }])).toBe("**bold** and [link](https://x.y)$E=mc^2$");
  });
  it("converts blocks, numbering lists and nesting children", () => {
    const b = (type: string, v: object, children?: NotionBlock[]): NotionBlock => ({ id: type, type, [type]: v, children });
    const md = blocksToMarkdown([
      b("heading_1", { rich_text: [rt("Week 3")] }),
      b("numbered_list_item", { rich_text: [rt("first")] }),
      b("numbered_list_item", { rich_text: [rt("second")] }, [b("bulleted_list_item", { rich_text: [rt("detail")] })]),
      b("to_do", { rich_text: [rt("read ch. 4")], checked: true }),
      b("code", { rich_text: [rt("print(1)")], language: "python" }),
      b("table", {}, [b("table_row", { cells: [[rt("a")], [rt("b")]] }), b("table_row", { cells: [[rt("1")], [rt("2")]] })]),
      b("child_page", { title: "Lab notes" }),
    ]);
    expect(md).toContain("# Week 3");
    expect(md).toContain("1. first");
    expect(md).toContain("2. second");
    expect(md).toContain("  - detail");
    expect(md).toContain("- [x] read ch. 4");
    expect(md).toContain("```python\nprint(1)\n```");
    expect(md).toContain("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(md).toContain("**Subpage:** Lab notes");
  });
  it("titles pages and databases, and bundles", () => {
    expect(pageTitle({ id: "1", object: "page", url: "", last_edited_time: "", properties: { Name: { type: "title", title: [rt("Notes", { bold: true })] } } })).toBe("Notes");
    expect(pageTitle({ id: "1", object: "database", url: "", last_edited_time: "", title: [rt("Tasks")] })).toBe("Tasks");
    const md = bundleNotion([{ title: "A", url: "https://notion.so/a", markdown: "hello" }]);
    expect(md).toMatch(/^# Notion: 1 page/);
    expect(md).toContain("Source: https://notion.so/a");
  });
});

describe("zotero", () => {
  const item: ZoteroItem = { key: "AB12CD34", itemType: "journalArticle", title: "Sleep and memory", date: "2019-03-01", publicationTitle: "Nature Reviews", volume: "20", issue: "3", pages: "1-10", DOI: "10.1000/xyz",
    creators: [{ creatorType: "author", firstName: "Ana Maria", lastName: "Lopez" }, { creatorType: "author", firstName: "B.", lastName: "Chen" }, { creatorType: "editor", lastName: "Ed" }] };
  it("formats an APA-style reference", () => {
    expect(apaCitation(item)).toBe("Lopez, A. M., & Chen, B. (2019). Sleep and memory. *Nature Reviews*, 20(3), 1-10. https://doi.org/10.1000/xyz");
  });
  it("bundles abstracts, notes and BibTeX", () => {
    const md = bundleZotero([{ item: { ...item, abstractNote: "We study sleep." }, notes: ["My note"] }], "@article{lopez2019}");
    expect(md).toContain("**Abstract:** We study sleep.");
    expect(md).toContain("**Note:**\n\nMy note");
    expect(md).toContain("```bibtex\n@article{lopez2019}\n```");
  });
  it("checks keys, searches and reads with the key header", async () => {
    const calls: string[] = [];
    vi.stubGlobal("localStorage", { setItem: () => {}, getItem: () => null, removeItem: () => {} });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push(url);
      expect((init.headers as Record<string, string>)["Zotero-API-Key"]).toBe("A".repeat(24));
      if (url.includes("/keys/")) return new Response(JSON.stringify({ userID: 7, username: "noah", access: { user: { library: true } } }));
      if (url.includes("format=bibtex")) return new Response("@article{x}");
      if (url.includes("/children")) return new Response(JSON.stringify([{ key: "N1", data: { note: "<p>Key <b>idea</b></p>" } }]));
      return new Response(JSON.stringify([{ key: "AB12CD34", data: { ...item, key: "AB12CD34" } }]));
    }));
    await expect(connectZotero("short")).rejects.toThrow(/24 letters/);
    const auth = await connectZotero("A".repeat(24));
    expect(auth).toEqual({ key: "A".repeat(24), userId: 7, username: "noah" });
    const found = await searchZotero(auth, "sleep");
    expect(found[0].title).toBe("Sleep and memory");
    expect(calls.at(-1)).toContain("q=sleep");
    const md = await readZotero(auth, found);
    expect(md).toContain("Key idea");
    expect(md).toContain("@article{x}");
  });
  it("explains a rejected key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    await expect(connectZotero("B".repeat(24))).rejects.toThrow(/didn't accept/);
  });
});

describe("mail & calendar", () => {
  it("cleans HTML and decodes Gmail bodies", () => {
    expect(htmlToText("<p>Hi&nbsp;<b>there</b></p><style>x{}</style><br>Bye")).toMatch(/Hi there\s+Bye/);
    const b64 = Buffer.from("Midterm moved to Friday").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(decodeB64Url(b64)).toBe("Midterm moved to Friday");
    expect(gmailBody({ mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64 } }] })).toBe("Midterm moved to Friday");
  });
  it("bundles emails and events", () => {
    const md = bundleEmails("gmail", [{ id: "1", subject: "Midterm", from: "Prof <p@uwo.ca>", to: "me", date: "2026-10-01T12:00:00Z", snippet: "", body: "Room change" }]);
    expect(md).toMatch(/^# Gmail: 1 email/);
    expect(md).toContain("## Midterm");
    const ev = bundleEvents("google", [{ title: "CS 2210 lecture", start: "2026-10-14T13:30:00", end: "2026-10-14T14:30:00", allDay: false, location: "MC 110", notes: "" }], new Date("2026-10-13T00:00:00"));
    expect(ev).toContain("CS 2210 lecture");
    expect(ev).toContain("MC 110");
    const allDay = bundleEvents("google", [{ title: "Reading week", start: "2026-10-26", end: "2026-10-31", allDay: true, location: "", notes: "" }], new Date(2026, 9, 13));
    expect(allDay).toContain("## Mon, Oct 26");
    expect(allDay).toContain("All day, until Fri, Oct 30");
  });
});

describe("gmail sending", () => {
  it("parses recipients and builds a UTF-8 message Gmail accepts", async () => {
    const { parseAddresses, buildRawEmail } = await import("./mail-calendar");
    expect(parseAddresses("ta@uwo.ca, Prof Smith <p.smith@uwo.ca>; ")).toEqual(["ta@uwo.ca", "p.smith@uwo.ca"]);
    expect(() => parseAddresses("not an email")).toThrow(/isn't an email/);
    const raw = buildRawEmail({ to: ["ta@uwo.ca"], cc: [], subject: "Extension — lab 3\nBcc: x@evil.com", body: "Hi,\nCan I get 2 days? 🙏", inReplyTo: "<abc@mail>" });
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const text = new TextDecoder().decode(Uint8Array.from(atob(raw.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
    expect(text).toContain("To: ta@uwo.ca\r\n");
    expect(text).not.toMatch(/^Bcc:/m); // no header injection through the subject
    expect(text).toMatch(/^Subject: =\?UTF-8\?B\?/m);
    expect(text).toContain("In-Reply-To: <abc@mail>");
    const body = text.split("\r\n\r\n")[1].replace(/\r\n/g, "");
    expect(new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0)))).toBe("Hi,\r\nCan I get 2 days? 🙏");
  });
  it("sends with the gmail.send permission and keeps replies in their thread", async () => {
    vi.resetModules();
    const scopes: string[][] = [];
    vi.doMock("./google-drive", () => ({ googleToken: async (s: string[]) => { scopes.push(s); return "g-token"; } }));
    const calls: { url: string; body?: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as string | undefined });
      if (url.endsWith("/messages/send")) return new Response(JSON.stringify({ id: "sent1" }));
      return new Response(JSON.stringify({ id: "m1", threadId: "t1", payload: { headers: [{ name: "Message-ID", value: "<orig@mail>" }, { name: "Subject", value: "Lab 3" }] } }));
    }));
    const m = await import("./mail-calendar");
    const out = await m.sendGmail({ to: "ta@uwo.ca", cc: "", subject: "", body: "Thanks!", replyTo: "m1" });
    expect(out).toEqual({ id: "sent1", to: ["ta@uwo.ca"] });
    expect(scopes).toEqual([[m.GMAIL_SEND_SCOPE.replace("send", "readonly")], [m.GMAIL_SEND_SCOPE]]);
    const sent = JSON.parse(calls[1].body!) as { raw: string; threadId: string };
    expect(sent.threadId).toBe("t1");
    expect(atob(sent.raw.replace(/-/g, "+").replace(/_/g, "/"))).toContain("Subject: Re: Lab 3");
    await expect(m.sendGmail({ to: "", cc: "", subject: "x", body: "y" })).rejects.toThrow(/Who should it go to/);
    vi.doUnmock("./google-drive");
  });
});

describe("outlook (Microsoft Graph)", () => {
  it("searches, reads and lists events with read-only scopes", async () => {
    vi.resetModules();
    const scopes: string[][] = [];
    vi.doMock("./onedrive", () => ({ msToken: async (s: string[]) => { scopes.push(s); return "ms-token"; } }));
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      urls.push(url);
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ms-token");
      if (url.includes("calendarView")) return new Response(JSON.stringify({ value: [{ subject: "Lab", start: { dateTime: "2026-10-14T10:00:00" }, end: { dateTime: "2026-10-14T11:00:00" }, isAllDay: false, location: { displayName: "Room 2" } }] }));
      if (url.includes("/me/messages/")) return new Response(JSON.stringify({ id: "x", subject: "Hi", from: { emailAddress: { name: "Prof", address: "p@uwo.ca" } }, toRecipients: [{ emailAddress: { address: "me@uwo.ca" } }], receivedDateTime: "2026-10-01T00:00:00Z", body: { contentType: "html", content: "<p>Exam <b>moved</b></p>" } }));
      return new Response(JSON.stringify({ value: [{ id: "x", subject: "Hi", from: { emailAddress: { name: "Prof", address: "p@uwo.ca" } }, receivedDateTime: "2026-10-01T00:00:00Z", bodyPreview: "Exam" }] }));
    }));
    const m = await import("./mail-calendar");
    const found = await m.searchOutlook('midterm "room"');
    expect(found[0]).toMatchObject({ id: "x", from: "Prof <p@uwo.ca>" });
    expect(decodeURIComponent(urls[0])).toContain('$search="midterm room"');
    const full = await m.readOutlook(["x"]);
    expect(full[0].body).toContain("Exam moved");
    expect(full[0].to).toBe("me@uwo.ca");
    const ev = await m.outlookEvents(new Date("2026-10-13T00:00:00Z"), 7);
    expect(ev[0]).toMatchObject({ title: "Lab", location: "Room 2", allDay: false });
    expect(scopes).toEqual([["Mail.Read"], ["Mail.Read"], ["Calendars.Read"]]);
    vi.doUnmock("./onedrive");
  });
});

describe("notion (server relay)", () => {
  it("exchanges the code, searches and reads a page with nested blocks", async () => {
    const { exchangeCode, searchPages, pageMarkdown } = await import("./notion");
    process.env.NOTION_CLIENT_ID = "cid";
    process.env.NOTION_CLIENT_SECRET = "sec";
    const seen: { url: string; auth: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).Authorization;
      seen.push({ url, auth });
      if (url.endsWith("/oauth/token")) return new Response(JSON.stringify({ access_token: "ntn_x", workspace_name: "Noah" }));
      if (url.endsWith("/search")) return new Response(JSON.stringify({ results: [{ id: "p1", object: "page", url: "https://notion.so/p1", last_edited_time: "2026-10-01", icon: { emoji: "📘" }, properties: { title: { type: "title", title: [{ plain_text: "Notes" }] } } }] }));
      if (url.includes("/pages/")) return new Response(JSON.stringify({ id: "p1", object: "page", url: "https://notion.so/p1", last_edited_time: "", properties: { title: { type: "title", title: [{ plain_text: "Notes" }] } } }));
      if (url.includes("/blocks/p1/children")) return new Response(JSON.stringify({ has_more: false, next_cursor: null, results: [{ id: "t1", type: "toggle", has_children: true, toggle: { rich_text: [{ plain_text: "Q1" }] } }] }));
      if (url.includes("/blocks/t1/children")) return new Response(JSON.stringify({ has_more: false, next_cursor: null, results: [{ id: "x", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Answer" }] } }] }));
      return new Response("{}", { status: 404 });
    }));
    expect(await exchangeCode("code", "https://orbit.app/auth/notion")).toEqual({ token: "ntn_x", workspace: "Noah" });
    expect(seen[0].auth).toBe(`Basic ${Buffer.from("cid:sec").toString("base64")}`);
    expect((await searchPages("ntn_x", "notes"))[0]).toMatchObject({ id: "p1", title: "Notes", icon: "📘", kind: "page" });
    const page = await pageMarkdown("ntn_x", "p1", "page");
    expect(page.markdown).toBe("- Q1\n\n  Answer");
    expect(seen.slice(1).every((s) => s.auth === "Bearer ntn_x")).toBe(true);
  });
});
