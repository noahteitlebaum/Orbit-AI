// Python sandbox for Orbit AI: runs the AI's analysis code in the student's own browser (Pyodide, WebAssembly),
// in a worker the page can stop at any time. Loaded by lib/code/runner.ts as a module worker.
//
// Limits:
//  - No network while the student's code runs: fetch/XHR/WebSocket/importScripts are replaced with errors.
//    (Packages are downloaded from the Pyodide CDN / PyPI just before, with the network briefly allowed.)
//  - Time: the page terminates the worker if a run takes too long.
//  - Memory: WebAssembly's own cap; the page recycles the worker after big runs.
//  - Files: inputs in /data, downloads written to /output (size-capped).
//  - The page starts a new worker for every run and throws it away after, so nothing carries over between runs.

const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";
const MAX_OUTPUT_FILES = 20;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_TEXT = 20_000;
// Pure-Python packages that aren't built into Pyodide, installed from PyPI when the code needs them.
const EXTRA = { openpyxl: "openpyxl", seaborn: "seaborn", tabulate: "tabulate" };

// The real network functions are kept here, out of reach of Python (which only sees globalThis).
const net = { fetch: self.fetch, XMLHttpRequest: self.XMLHttpRequest, WebSocket: self.WebSocket, importScripts: self.importScripts };
const blocked = () => {
  throw new Error("No internet access in the Orbit AI Python sandbox.");
};
function allowNetwork() {
  Object.assign(self, net);
}
function blockNetwork() {
  self.fetch = blocked;
  self.XMLHttpRequest = function () { blocked(); };
  self.WebSocket = function () { blocked(); };
  self.importScripts = blocked;
}

let ready = null; // one worker = one run, but keep the pattern simple
async function boot() {
  const { loadPyodide } = await import(`${PYODIDE}pyodide.mjs`);
  const py = await loadPyodide({ indexURL: PYODIDE, env: { MPLBACKEND: "Agg", HOME: "/home/pyodide" } });
  return py;
}

const clip = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n…[output cut off]` : s);

function resetDir(fs, dir) {
  try {
    for (const name of fs.readdir(dir)) if (name !== "." && name !== "..") fs.unlink(`${dir}/${name}`);
  } catch {
    fs.mkdirTree(dir);
  }
}

self.onmessage = async ({ data }) => {
  const { id, code, files = [] } = data;
  try {
    allowNetwork();
    ready ??= boot();
    const py = await ready;
    const fs = py.FS;

    // Inputs and a clean output folder.
    resetDir(fs, "/data");
    resetDir(fs, "/output");
    for (const f of files) fs.writeFile(`/data/${f.name.replace(/[/\\]/g, "_")}`, new Uint8Array(f.bytes));

    // Packages: built-ins found from the imports, plus a few pure-Python extras from PyPI.
    await py.loadPackagesFromImports(code);
    const extras = Object.keys(EXTRA).filter((m) => new RegExp(`\\b(import|from)\\s+${m}\\b`).test(code) || (m === "openpyxl" && /read_excel|to_excel|\.xlsx/.test(code)));
    if (extras.length) {
      await py.loadPackage(["micropip"]);
      const micropip = py.pyimport("micropip");
      await micropip.install(extras.map((m) => EXTRA[m]));
    }

    // From here on: no network.
    blockNetwork();
    let stdout = "";
    let stderr = "";
    py.setStdout({ batched: (s) => (stdout += s + "\n") });
    py.setStderr({ batched: (s) => (stderr += s + "\n") });
    self.postMessage({ id, type: "started" });

    const started = performance.now();
    const globals = py.toPy({});
    let error = null;
    try {
      await py.runPythonAsync(code, { globals, filename: "analysis.py" });
    } catch (e) {
      // Keep the part of the traceback about the student's code (not Pyodide's own frames).
      const lines = String(e?.message ?? e).split("\n");
      const from = lines.findIndex((l) => l.includes('File "analysis.py"'));
      error = (from >= 0 ? ["Traceback (most recent call last):", ...lines.slice(from)] : lines.slice(-12)).join("\n").trim();
    }
    // Charts the code drew but didn't save are saved for the student.
    try {
      await py.runPythonAsync(
        "import sys\n" +
          "if 'matplotlib.pyplot' in sys.modules:\n" +
          "    import matplotlib.pyplot as _plt, os as _os\n" +
          "    for _i, _n in enumerate(_plt.get_fignums()):\n" +
          "        _p = f'/output/figure_{_i + 1}.png'\n" +
          "        if not _os.path.exists(_p):\n" +
          "            _plt.figure(_n).savefig(_p, dpi=150, bbox_inches='tight')\n" +
          "    _plt.close('all')\n",
        { globals },
      );
    } catch {}
    globals.destroy();
    const ms = Math.round(performance.now() - started);

    // Collect outputs, within the size limits.
    const out = [];
    let total = 0;
    const skipped = [];
    for (const name of fs.readdir("/output").filter((n) => n !== "." && n !== "..")) {
      const path = `/output/${name}`;
      if (!fs.isFile(fs.stat(path).mode)) continue;
      const bytes = fs.readFile(path);
      if (out.length >= MAX_OUTPUT_FILES || bytes.length > MAX_FILE_BYTES || total + bytes.length > MAX_TOTAL_BYTES) {
        skipped.push(name);
        continue;
      }
      total += bytes.length;
      out.push({ name, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    }
    const memory = py._module?.HEAP8?.buffer?.byteLength ?? 0;
    self.postMessage({ id, type: "done", ok: !error, stdout: clip(stdout), stderr: clip(stderr), error, files: out, skipped, ms, memory }, out.map((f) => f.bytes));
  } catch (e) {
    self.postMessage({ id, type: "done", ok: false, stdout: "", stderr: "", error: `The Python sandbox couldn't start: ${e?.message ?? e}`, files: [], skipped: [], ms: 0, memory: 0 });
  } finally {
    blockNetwork();
  }
};
