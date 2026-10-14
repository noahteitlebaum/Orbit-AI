// GitHub: bring a repository into a chat so any AI can read and explain the code (integration memo #11).
//  - Public repos: paste the link. No sign-in; the student's own browser calls GitHub (60 API calls/hour per
//    student), and file contents come from raw.githubusercontent.com (doesn't count against that limit).
//  - Private repos: "Sign in with GitHub" (device code, so no secret in the browser). Best set up as a GitHub App
//    with read-only "Contents" + "Metadata" permissions; the token lives in this tab's session storage only.
// The student picks files from the tree; they're bundled into one Markdown file (tree + files, with paths) that
// goes through the normal upload, so it's searchable and citable like any other file.

export const GITHUB_CLIENT_ID = process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID ?? "";
export const GITHUB_APP_SLUG = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG ?? "";
export const githubSignInConfigured = Boolean(GITHUB_CLIENT_ID);

export const GITHUB_LIMITS = { files: 80, fileBytes: 60_000, bundleBytes: 400_000, treeLines: 400 };

export type RepoRef = { owner: string; repo: string; ref?: string; path?: string };
export type TreeEntry = { path: string; size: number; sha: string };
export type RepoInfo = { owner: string; repo: string; ref: string; commit: string; private: boolean; description: string | null; htmlUrl: string; tree: TreeEntry[]; truncated: boolean };

/** "https://github.com/o/r", "github.com/o/r/tree/main/src", "o/r", "git@github.com:o/r.git" → parts. Pure. */
export function parseRepoUrl(input: string): RepoRef | null {
  const s = input.trim().replace(/^git@github\.com:/i, "https://github.com/").replace(/\.git$/i, "").replace(/[?#].*$/, "");
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?\/?$/i.exec(s) ?? /^([\w.-]+)\/([\w.-]+)$/.exec(s);
  if (!m) return null;
  const [, owner, repo, ref, path] = m;
  if (["orgs", "settings", "login", "marketplace", "apps"].includes(owner.toLowerCase())) return null;
  return { owner, repo, ...(ref ? { ref } : {}), ...(path ? { path: path.replace(/\/$/, "") } : {}) };
}

const SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|build|out|target|vendor|\.next|\.venv|venv|__pycache__|\.idea|\.vscode|coverage|\.gradle|bin|obj|Pods|\.dart_tool)(\/|$)/i;
const SKIP_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock|go\.sum|\.DS_Store)$/i;
const BINARY = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|svgz|pdf|zip|gz|tgz|rar|7z|jar|war|class|o|a|so|dll|exe|dylib|wasm|pyc|pkl|pt|onnx|h5|parquet|feather|mp3|mp4|mov|avi|wav|flac|ogg|woff2?|ttf|otf|eot|psd|ai|sketch|fig|bin|dat|db|sqlite)$/i;
const MINIFIED = /\.min\.(js|css)$|\.map$/i;

/** Readable source/text files worth offering (not dependencies, builds, binaries or lockfiles). Pure. */
export function isTextPath(path: string): boolean {
  return !SKIP_DIRS.test(path) && !SKIP_FILES.test(path) && !BINARY.test(path) && !MINIFIED.test(path);
}

const CODE_EXT = /\.(py|ipynb|js|jsx|ts|tsx|mjs|cjs|java|kt|c|h|cpp|hpp|cc|cs|go|rs|rb|php|swift|m|r|R|jl|scala|sql|sh|ps1|lua|dart|hs|ml|ex|exs|vue|svelte|html|css|scss)$/i;
const DOC_FILES = /(^|\/)(readme|contributing|changelog|license)(\.\w+)?$/i;
const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|requirements\.txt|setup\.py|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|Makefile|CMakeLists\.txt|Dockerfile|environment\.ya?ml|tsconfig\.json)$/i;

/** Files pre-selected for the student: README, manifests, then the shallowest source files, within the limits. Pure. */
export function suggestFiles(tree: TreeEntry[], under?: string): string[] {
  const scope = tree.filter((f) => isTextPath(f.path) && (!under || f.path === under || f.path.startsWith(`${under}/`)) && f.size <= GITHUB_LIMITS.fileBytes * 2);
  const depth = (p: string) => p.split("/").length;
  const rank = (f: TreeEntry) => (DOC_FILES.test(f.path) && depth(f.path) === 1 ? 0 : MANIFEST.test(f.path) && depth(f.path) <= 2 ? 1 : CODE_EXT.test(f.path) ? 2 + depth(f.path) : 50);
  const ordered = [...scope].filter((f) => rank(f) < 50).sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
  const picked: string[] = [];
  let bytes = 0;
  for (const f of ordered) {
    const size = Math.min(f.size, GITHUB_LIMITS.fileBytes);
    if (picked.length >= 25 || bytes + size > GITHUB_LIMITS.bundleBytes / 2) break;
    picked.push(f.path);
    bytes += size;
  }
  return picked;
}

const LANG: Record<string, string> = { py: "python", js: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx", java: "java", c: "c", h: "c", cpp: "cpp", cs: "csharp", go: "go", rs: "rust", rb: "ruby", php: "php", swift: "swift", kt: "kotlin", r: "r", sql: "sql", sh: "bash", html: "html", css: "css", json: "json", yml: "yaml", yaml: "yaml", md: "markdown", toml: "toml" };

/** One Markdown file: header, the file tree, then each chosen file with its path. Pure. */
export function bundleRepo(info: Pick<RepoInfo, "owner" | "repo" | "ref" | "commit" | "htmlUrl" | "description" | "tree">, files: { path: string; content: string }[]): string {
  const textTree = info.tree.filter((f) => isTextPath(f.path)).map((f) => f.path);
  const shownTree = textTree.slice(0, GITHUB_LIMITS.treeLines);
  const parts = [
    `# GitHub: ${info.owner}/${info.repo} (${info.ref} @ ${info.commit.slice(0, 7)})`,
    `${info.htmlUrl}${info.description ? `\n\n${info.description}` : ""}`,
    `Imported into Orbit on ${new Date().toISOString().slice(0, 10)}. ${files.length} of ${textTree.length} text files included; ask the student to add others if needed.`,
    `## File tree\n\n\`\`\`\n${shownTree.join("\n")}${textTree.length > shownTree.length ? `\n… ${textTree.length - shownTree.length} more` : ""}\n\`\`\``,
  ];
  let bytes = parts.join("\n\n").length;
  for (const f of files) {
    const ext = f.path.split(".").pop()?.toLowerCase() ?? "";
    let body = f.content.replace(/\r\n/g, "\n");
    let note = "";
    if (body.length > GITHUB_LIMITS.fileBytes) {
      body = body.slice(0, GITHUB_LIMITS.fileBytes);
      note = `\n\n_(cut off at ${Math.round(GITHUB_LIMITS.fileBytes / 1000)} KB)_`;
    }
    const fence = body.includes("```") ? "````" : "```";
    const block = `## ${f.path}\n\n${fence}${LANG[ext] ?? ""}\n${body}\n${fence}${note}`;
    if (bytes + block.length > GITHUB_LIMITS.bundleBytes) {
      parts.push(`_(More selected files were left out to keep this import under ${GITHUB_LIMITS.bundleBytes / 1000} KB.)_`);
      break;
    }
    parts.push(block);
    bytes += block.length;
  }
  return parts.join("\n\n") + "\n";
}

// ---------------------------------------------------------------- browser calls
const TOKEN_KEY = "orbit.github.token";
export function githubToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setGithubToken(t: string | null) {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {}
}

export class GitHubError extends Error {}

async function gh<T>(path: string, token: string | null): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  }).catch(() => null);
  if (!res) throw new GitHubError("Couldn't reach GitHub. Check your connection.");
  if (res.status === 404) throw new GitHubError(token ? "Repository not found, or Orbit isn't allowed to read it (install the Orbit GitHub app on it)." : "Repository not found. If it's private, sign in with GitHub first.");
  if (res.status === 401) {
    setGithubToken(null);
    throw new GitHubError("Your GitHub sign-in expired. Sign in again.");
  }
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
    const mins = reset ? Math.max(1, Math.ceil((reset - Date.now()) / 60_000)) : null;
    throw new GitHubError(`GitHub's hourly limit was reached${mins ? ` (try again in about ${mins} min)` : ""}. Signing in with GitHub raises the limit.`);
  }
  if (!res.ok) throw new GitHubError("GitHub returned an error. Try again.");
  return (await res.json()) as T;
}

/** Repo details and its full file tree at a branch/tag/commit. */
export async function loadRepo(ref: RepoRef, token = githubToken()): Promise<RepoInfo> {
  const meta = await gh<{ default_branch: string; private: boolean; description: string | null; html_url: string; owner: { login: string }; name: string }>(`/repos/${ref.owner}/${ref.repo}`, token);
  const branch = ref.ref ?? meta.default_branch;
  const commit = await gh<{ sha: string; commit: { tree: { sha: string } } }>(`/repos/${ref.owner}/${ref.repo}/commits/${encodeURIComponent(branch)}`, token);
  const tree = await gh<{ tree: { path: string; type: string; size?: number; sha: string }[]; truncated: boolean }>(`/repos/${ref.owner}/${ref.repo}/git/trees/${commit.commit.tree.sha}?recursive=1`, token);
  return {
    owner: meta.owner.login, repo: meta.name, ref: branch, commit: commit.sha, private: meta.private, description: meta.description, htmlUrl: meta.html_url,
    tree: tree.tree.filter((t) => t.type === "blob").map((t) => ({ path: t.path, size: t.size ?? 0, sha: t.sha })), truncated: tree.truncated,
  };
}

/** One file's text at the loaded commit (raw host for public repos; the API for private ones). */
export async function fileText(info: RepoInfo, path: string, token = githubToken()): Promise<string> {
  const enc = path.split("/").map(encodeURIComponent).join("/");
  const res = info.private || token
    ? await fetch(`https://api.github.com/repos/${info.owner}/${info.repo}/contents/${enc}?ref=${info.commit}`, {
        headers: { Accept: "application/vnd.github.raw+json", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      }).catch(() => null)
    : await fetch(`https://raw.githubusercontent.com/${info.owner}/${info.repo}/${info.commit}/${enc}`).catch(() => null);
  if (!res?.ok) throw new GitHubError(`Couldn't download ${path} from GitHub.`);
  const text = await res.text();
  if (/\u0000/.test(text.slice(0, 2000))) throw new GitHubError(`${path} isn't a text file.`);
  return text;
}

export type MyRepo = { fullName: string; private: boolean; pushedAt: string; description: string | null };
export async function myRepos(token: string): Promise<MyRepo[]> {
  const list = await gh<{ full_name: string; private: boolean; pushed_at: string; description: string | null }[]>("/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member", token);
  return list.map((r) => ({ fullName: r.full_name, private: r.private, pushedAt: r.pushed_at, description: r.description }));
}

/** Device sign-in, through our server (GitHub's sign-in endpoints don't allow browser calls). */
export async function startDeviceSignIn(): Promise<{ deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresIn: number }> {
  const res = await fetch("/api/github/device", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start" }) }).catch(() => null);
  if (!res?.ok) throw new GitHubError(res?.status === 503 ? "GitHub sign-in isn't set up yet." : "Couldn't start GitHub sign-in.");
  return res.json();
}
export async function pollDeviceSignIn(deviceCode: string): Promise<{ token?: string; wait?: number; error?: string }> {
  const res = await fetch("/api/github/device", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "poll", deviceCode }) }).catch(() => null);
  if (!res?.ok) return { error: "Couldn't reach GitHub." };
  return res.json();
}
