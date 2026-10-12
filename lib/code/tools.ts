// The Python tool every model can call (run in the student's browser by lib/code/runner.ts).
import type { ToolDef } from "@/lib/folder/tools";

export const CODE_TOOLS: ToolDef[] = [
  {
    // ToolDef's name type lists the folder tools too; the cast keeps one shared shape for all tools.
    name: "run_python" as ToolDef["name"],
    description:
      "Run Python 3 in an isolated sandbox and get back what it prints. Has numpy, pandas, scipy, matplotlib, statsmodels, " +
      "scikit-learn and sympy (openpyxl/seaborn load on import). The student's data files are in /data. Save charts and files " +
      "to /output (e.g. plt.savefig('/output/plot.png'), df.to_csv('/output/results.csv')) to give the student downloads; " +
      "unsaved matplotlib figures are saved automatically. No internet. Each run starts fresh (no variables from earlier runs) " +
      "and is stopped after 30 seconds. Print the numbers you need to answer.",
    parameters: { type: "object", properties: { code: { type: "string", description: "The complete Python program to run." } }, required: ["code"] },
    write: false,
  },
];

export const isCodeTool = (name: unknown) => name === "run_python";

/** Data files are named to the model so its code can open them from /data. */
export const DATA_FILE = /\.(csv|tsv|xlsx|xlsm|json|txt|dat|tab)$/i;

export function codePrompt(dataFiles: string[]): string {
  return [
    "You can run Python with the run_python tool. Use it whenever an answer depends on a calculation, statistics, data analysis, " +
      "a graph, or whether code works: run it rather than doing arithmetic in your head or guessing what code outputs. " +
      "Explaining code is not the same as running it; when the student asks whether code works or what it prints, run it. " +
      "After running, explain the results in plain language and mention any files you saved.",
    dataFiles.length
      ? `The student's data files are available in /data: ${dataFiles.map((n) => `/data/${n.replace(/[/\\]/g, "_")}`).join(", ")}.`
      : "No data files are attached; if the student mentions their data, ask them to attach the CSV or Excel file.",
  ].join("\n");
}
