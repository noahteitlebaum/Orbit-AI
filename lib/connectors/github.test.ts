import { afterEach, describe, expect, it, vi } from "vitest";
import { bundleRepo, fileText, isTextPath, loadRepo, parseRepoUrl, suggestFiles, type RepoInfo } from "./github";
import { exchangeCode, refreshToken } from "./github-oauth";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GitHub links", () => {
  it.each([
    ["https://github.com/uwo-cs/cs2210-a1", { owner: "uwo-cs", repo: "cs2210-a1" }],
    ["github.com/uwo-cs/cs2210-a1.git", { owner: "uwo-cs", repo: "cs2210-a1" }],
    ["git@github.com:uwo-cs/cs2210-a1.git", { owner: "uwo-cs", repo: "cs2210-a1" }],
    ["https://github.com/o/r/tree/dev/src/lib/", { owner: "o", repo: "r", ref: "dev", path: "src/lib" }],
    ["https://github.com/o/r/blob/main/README.md?plain=1", { owner: "o", repo: "r", ref: "main", path: "README.md" }],
    ["o/r", { owner: "o", repo: "r" }],
  ])("%s", (input, out) => expect(parseRepoUrl(input)).toEqual(out));
  it("rejects other links", () => {
    expect(parseRepoUrl("https://gitlab.com/o/r")).toBeNull();
    expect(parseRepoUrl("https://github.com/settings/profile")).toBeNull();
    expect(parseRepoUrl("hello")).toBeNull();
  });
});

const tree = [
  { path: "README.md", size: 2_000, sha: "a" }, { path: "package.json", size: 800, sha: "b" }, { path: "package-lock.json", size: 400_000, sha: "c" },
  { path: "src/main.py", size: 3_000, sha: "d" }, { path: "src/utils/helpers.py", size: 1_500, sha: "e" }, { path: "node_modules/x/index.js", size: 100, sha: "f" },
  { path: "assets/logo.png", size: 9_000, sha: "g" }, { path: "dist/app.min.js", size: 50_000, sha: "h" }, { path: "tests/test_main.py", size: 1_000, sha: "i" },
];

describe("choosing files", () => {
  it("skips dependencies, builds, binaries and lockfiles", () => {
    expect(tree.filter((f) => isTextPath(f.path)).map((f) => f.path)).toEqual(["README.md", "package.json", "src/main.py", "src/utils/helpers.py", "tests/test_main.py"]);
  });
  it("suggests the README, manifests, then shallow source files", () => {
    expect(suggestFiles(tree)).toEqual(["README.md", "package.json", "src/main.py", "tests/test_main.py", "src/utils/helpers.py"]);
    expect(suggestFiles(tree, "src/utils")).toEqual(["src/utils/helpers.py"]);
  });
  it("bundles the tree and files with paths, within the size limit", () => {
    const info = { owner: "o", repo: "r", ref: "main", commit: "abcdef1234567", htmlUrl: "https://github.com/o/r", description: "A1", tree };
    const md = bundleRepo(info, [{ path: "src/main.py", content: "print('hi')\r\n" }, { path: "README.md", content: "Use ```code``` blocks" }]);
    expect(md).toContain("# GitHub: o/r (main @ abcdef1)");
    expect(md).toContain("## File tree\n\n```\nREADME.md\npackage.json\nsrc/main.py");
    expect(md).not.toContain("node_modules");
    expect(md).toContain("## src/main.py\n\n```python\nprint('hi')\n\n```");
    expect(md).toContain("## README.md\n\n````markdown\nUse ```code``` blocks\n````"); // a file containing ``` gets a longer fence
    const big = bundleRepo(info, Array.from({ length: 20 }, (_, i) => ({ path: `f${i}.py`, content: "x".repeat(70_000) })));
    expect(big.length).toBeLessThan(410_000);
    expect(big).toContain("cut off at 60 KB");
    expect(big).toContain("More selected files were left out");
  });
});

describe("GitHub API", () => {
  it("loads a public repo's tree at the default branch, then reads files from the raw host", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith("/repos/o/r")) return Response.json({ default_branch: "main", private: false, description: null, html_url: "https://github.com/o/r", owner: { login: "o" }, name: "r" });
      if (url.includes("/commits/main")) return Response.json({ sha: "c0ffee", commit: { tree: { sha: "t1" } } });
      if (url.includes("/git/trees/t1?recursive=1")) return Response.json({ truncated: false, tree: [{ path: "src", type: "tree", sha: "x" }, { path: "src/a.py", type: "blob", size: 10, sha: "y" }] });
      if (url === "https://raw.githubusercontent.com/o/r/c0ffee/src/a.py") return new Response("print(1)");
      return new Response("nope", { status: 404 });
    }));
    const info = await loadRepo({ owner: "o", repo: "r" }, null);
    expect(info).toMatchObject({ ref: "main", commit: "c0ffee", tree: [{ path: "src/a.py", size: 10 }] });
    expect(await fileText(info, "src/a.py", null)).toBe("print(1)");
    expect(calls.every((u) => !u.includes("Authorization"))).toBe(true);
  });

  it("explains rate limits and missing private repos", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403, headers: { "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600) } })));
    await expect(loadRepo({ owner: "o", repo: "r" }, null)).rejects.toThrow(/hourly limit.*about 10 min/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    await expect(loadRepo({ owner: "o", repo: "r" }, null)).rejects.toThrow(/If it's private, connect GitHub/);
  });

  it("reads private files through the API with the student's token", async () => {
    const f = vi.fn(async () => new Response("secret code"));
    vi.stubGlobal("fetch", f);
    const info = { owner: "o", repo: "r", ref: "main", commit: "c1", private: true } as RepoInfo;
    expect(await fileText(info, "a b.py", "tok")).toBe("secret code");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/o/r/contents/a%20b.py?ref=c1");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });
});

describe("web sign-in (server exchange)", () => {
  it("swaps the code for a token with the client secret, and refreshes", async () => {
    vi.stubEnv("NEXT_PUBLIC_GITHUB_CLIENT_ID", "Iv1.abc");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "shh");
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return Response.json(String(init.body).includes("refresh_token=") ? { access_token: "ghu_new", refresh_token: "ghr_2", expires_in: 28800 } : { access_token: "ghu_x", refresh_token: "ghr_1", expires_in: 28800 });
    }));
    const t = await exchangeCode("abc123", "https://orbit.app/auth/github");
    expect(t).toMatchObject({ token: "ghu_x", refreshToken: "ghr_1" });
    expect(t.expiresAt).toBeGreaterThan(Date.now());
    expect(bodies[0]).toContain("client_secret=shh");
    expect(bodies[0]).toContain("redirect_uri=https%3A%2F%2Forbit.app%2Fauth%2Fgithub");
    expect((await refreshToken("ghr_1")).token).toBe("ghu_new");
    expect(bodies[1]).toContain("grant_type=refresh_token");
  });
  it("reports GitHub's error", async () => {
    vi.stubEnv("NEXT_PUBLIC_GITHUB_CLIENT_ID", "Iv1.abc");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "shh");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "bad_verification_code" })));
    await expect(exchangeCode("x1234", "https://o/auth/github")).rejects.toThrow("bad_verification_code");
  });
});

describe("GitHub sign-in renewal", () => {
  it("renews an expired token once, even when several calls need it at the same time", async () => {
    vi.resetModules();
    const store = new Map<string, string>();
    const mem = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    vi.stubGlobal("localStorage", mem);
    vi.stubGlobal("sessionStorage", mem);
    const gh = await import("./github");
    gh.setGithubAuth({ token: "ghu_old", refreshToken: "ghr_1", expiresAt: Date.now() - 1000, login: "noah", avatar: "" });
    let refreshes = 0;
    const auths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === "/api/github/oauth") {
        refreshes++;
        await new Promise((r) => setTimeout(r, 20));
        return Response.json({ token: "ghu_new", refreshToken: "ghr_2", expiresAt: Date.now() + 8 * 3600_000 });
      }
      auths.push((init.headers as Record<string, string>).Authorization);
      return Response.json([]);
    }));
    await Promise.all([gh.myRepos("ghu_old"), gh.myRepos("ghu_old"), gh.myRepos("ghu_old")]);
    expect(refreshes).toBe(1);
    expect(auths).toEqual(["Bearer ghu_new", "Bearer ghu_new", "Bearer ghu_new"]);
    expect(gh.githubAuth()).toMatchObject({ token: "ghu_new", refreshToken: "ghr_2", login: "noah" });
  });
});
