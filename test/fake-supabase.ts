// Tiny in-memory stand-in for the Supabase query builder, enough for route tests. Not RLS-aware:
// it holds one user's rows, which is what RLS would expose.
type Row = Record<string, unknown>;

export function fakeSupabase(tables: Record<string, Row[]> = {}) {
  let seq = 0;
  const db: Record<string, Row[]> = { conversations: [], messages: [], projects: [], files: [], file_chunks: [], ...tables };
  const storage: Record<string, { bytes: Uint8Array; type: string }> = {};
  const uuid = () => crypto.randomUUID();

  class Q {
    private filters: ((r: Row) => boolean)[] = [];
    private op: "select" | "insert" | "update" | "delete" = "select";
    private payload: Row | Row[] | null = null;
    private orderBy: string | null = null;
    private returning = false;
    constructor(private table: string) {}
    select() { if (this.op !== "select") this.returning = true; return this; }
    insert(p: Row | Row[]) { this.op = "insert"; this.payload = p; return this; }
    // upsert with ignoreDuplicates: rows matching an existing row on the onConflict columns are skipped
    upsert(p: Row | Row[], o: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
      const cols = (o.onConflict ?? "id").split(",");
      const t = (db[this.table] ??= []);
      const rows = (Array.isArray(p) ? p : [p]).filter((r) => !t.some((x) => cols.every((c) => x[c] === r[c] && r[c] != null)));
      this.op = "insert"; this.payload = rows; return this;
    }
    update(p: Row) { this.op = "update"; this.payload = p; return this; }
    delete() { this.op = "delete"; return this; }
    eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
    gt(c: string, v: number) { this.filters.push((r) => (r[c] as number) > v); return this; }
    in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
    is(c: string, v: null) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
    or(expr: string) {
      // supports "a.eq.x,b.eq.y" and "a.is.null"
      const parts = expr.split(",").map((p) => p.split("."));
      this.filters.push((r) => parts.some(([c, op, v]) => (op === "is" ? (r[c] ?? null) === null : String(r[c]) === v)));
      return this;
    }
    order(c: string) { this.orderBy = c; return this; }
    limit() { return this; }
    private run(): Row[] {
      const t = (db[this.table] ??= []);
      if (this.op === "insert") {
        const defaults: Row = this.table === "messages" ? { status: "complete", kind: "text", attachment_ids: [] } : this.table === "conversations" ? { mode: "chat", course_only: false, summary: null, summary_upto: null, project_id: null } : {};
        const rows = (Array.isArray(this.payload) ? this.payload : [this.payload!]).map((r) => ({
          id: uuid(), seq: ++seq, ...defaults, ...r,
        }));
        t.push(...rows);
        return rows;
      }
      const hit = t.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === "update") hit.forEach((r) => Object.assign(r, this.payload));
      if (this.op === "delete") db[this.table] = t.filter((r) => !hit.includes(r));
      if (this.orderBy) hit.sort((a, b) => (a[this.orderBy!] as number) - (b[this.orderBy!] as number));
      return hit;
    }
    async single() { const r = this.run(); return { data: r[0] ?? null, error: r[0] ? null : { message: "none" } }; }
    async maybeSingle() { return { data: this.run()[0] ?? null, error: null }; }
    then(ok?: (v: { data: Row[]; error: null }) => unknown, bad?: (e: unknown) => unknown) {
      return Promise.resolve({ data: this.run(), error: null as null }).then(ok, bad);
    }
  }
  const client = {
    from: (t: string) => new Q(t),
    // search_chunks stand-in: rows whose content shares any word with the query
    rpc: async (_fn: string, a: { p_query: string; p_file_ids: string[]; p_limit: number }) => {
      const words = a.p_query.toLowerCase().match(/[a-z]{4,}/g) ?? [];
      const hits = db.file_chunks.filter((c) => a.p_file_ids.includes(c.file_id as string) && words.some((w) => (c.content as string).toLowerCase().includes(w)));
      return { data: hits.slice(0, a.p_limit), error: null };
    },
    storage: {
      from: () => ({
        download: async (path: string) => (storage[path] ? { data: new Blob([storage[path].bytes as BlobPart], { type: storage[path].type }), error: null } : { data: null, error: { message: "missing" } }),
        remove: async (paths: string[]) => { paths.forEach((p) => delete storage[p]); return { data: null, error: null }; },
        createSignedUrls: async () => ({ data: [], error: null }),
      }),
    },
  };
  return { client, db, storage };
}
