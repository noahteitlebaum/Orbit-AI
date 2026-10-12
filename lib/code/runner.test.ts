import { describe, expect, it } from "vitest";
import { mimeFor, resultForModel, type RunResult } from "./runner";
import { codePrompt } from "./tools";

const base: RunResult = { ok: true, stdout: "", stderr: "", error: null, files: [], skipped: [], ms: 1234 };

describe("Python results for the model", () => {
  it("reports output and downloads", () => {
    const text = resultForModel({ ...base, stdout: "mean = 4.2\n", files: [{ name: "plot.png", mime: "image/png", url: "blob:x", size: 20_000 }] });
    expect(text).toContain("Ran successfully in 1.2 s.");
    expect(text).toContain("mean = 4.2");
    expect(text).toContain("plot.png (20 KB)");
  });

  it("reports errors and limits", () => {
    expect(resultForModel({ ...base, ok: false, error: "ZeroDivisionError: division by zero" })).toContain("ZeroDivisionError");
    expect(resultForModel({ ...base, ok: false, error: "The code ran longer than 30 seconds", limit: "time" })).toMatch(/^Stopped: The code ran longer/);
  });

  it("names data files by their /data path", () => {
    expect(codePrompt(["lab 1.csv", "results.xlsx"])).toContain("/data/lab 1.csv, /data/results.xlsx");
    expect(codePrompt([])).toContain("ask them to attach");
    expect(mimeFor("out.XLSX")).toContain("spreadsheetml");
  });
});
