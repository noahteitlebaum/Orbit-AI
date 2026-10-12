// Browser side of the Python sandbox (public/python-worker.mjs). Every run gets a brand-new worker that is
// thrown away afterwards: nothing (variables, timers, memory) carries over between runs, and a run that goes over
// its time limit is simply terminated.

export type RunFile = { name: string; bytes: ArrayBuffer };
export type RunOutput = { name: string; mime: string; url: string; size: number };
export type RunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  error: string | null;
  files: RunOutput[];
  skipped: string[];
  ms: number;
  limit?: "time" | "memory" | "crash";
};

export const RUN_LIMITS = { seconds: 30, setupSeconds: 120, memoryNote: "about 2 GB (the browser's limit)" };

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml", pdf: "application/pdf",
  csv: "text/csv", txt: "text/plain", json: "application/json", html: "text/html", md: "text/markdown",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
export const mimeFor = (name: string) => MIME[name.toLowerCase().split(".").pop() ?? ""] ?? "application/octet-stream";

export function codeSupported(): boolean {
  return typeof window !== "undefined" && typeof Worker !== "undefined" && typeof WebAssembly !== "undefined";
}

export function runPython(code: string, files: RunFile[], signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    const worker = new Worker("/python-worker.mjs", { type: "module" });
    let timer: ReturnType<typeof setTimeout>;
    let finished = false;
    const finish = (r: RunResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(r);
    };
    const stop = (limit: RunResult["limit"], error: string) => finish({ ok: false, stdout: "", stderr: "", error, files: [], skipped: [], ms: 0, limit });

    // Loading Python and packages gets its own (longer) allowance; the 30-second limit starts when the code does.
    timer = setTimeout(() => stop("time", "Setting up Python took too long. Check the internet connection and try again."), RUN_LIMITS.setupSeconds * 1000);
    signal?.addEventListener("abort", () => stop("time", "Stopped by the student."), { once: true });

    worker.onmessage = ({ data }) => {
      if (data.type === "started") {
        clearTimeout(timer);
        timer = setTimeout(() => stop("time", `The code ran longer than ${RUN_LIMITS.seconds} seconds and was stopped. Make it faster (smaller data, fewer loops) and try again.`), RUN_LIMITS.seconds * 1000);
        return;
      }
      const outputs: RunOutput[] = (data.files as RunFile[]).map((f) => {
        const mime = mimeFor(f.name);
        return { name: f.name, mime, size: f.bytes.byteLength, url: URL.createObjectURL(new Blob([f.bytes], { type: mime })) };
      });
      finish({ ok: data.ok, stdout: data.stdout, stderr: data.stderr, error: data.error, files: outputs, skipped: data.skipped ?? [], ms: data.ms });
    };
    // A worker that dies mid-run almost always ran out of memory.
    worker.onerror = (e) => {
      e.preventDefault();
      stop("memory", `The code ran out of memory (limit ${RUN_LIMITS.memoryNote}) or crashed. Use less data at once and try again.`);
    };
    worker.postMessage({ id: 1, code, files });
  });
}

/** What the model gets back: what happened, the printed output, and which files the student can download. */
export function resultForModel(r: RunResult): string {
  const parts = [r.ok ? `Ran successfully in ${(r.ms / 1000).toFixed(1)} s.` : r.limit ? `Stopped: ${r.error}` : "The code raised an error."];
  if (r.stdout.trim()) parts.push(`Printed output:\n${r.stdout.trim()}`);
  if (r.stderr.trim()) parts.push(`Warnings/stderr:\n${r.stderr.trim().slice(-4000)}`);
  if (!r.ok && r.error && !r.limit) parts.push(`Error:\n${r.error}`);
  if (r.files.length) parts.push(`Files the student can now download (shown under your answer; images are displayed): ${r.files.map((f) => `${f.name} (${Math.max(1, Math.round(f.size / 1024))} KB)`).join(", ")}. You can't see images; describe what the chart shows from the numbers.`);
  if (r.skipped.length) parts.push(`Too large or too many to keep: ${r.skipped.join(", ")}.`);
  return parts.join("\n\n");
}
