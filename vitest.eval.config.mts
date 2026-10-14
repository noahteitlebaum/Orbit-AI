import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Live response-quality evaluation only (npm run eval:quality). Costs real API credits; never part of npm test.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: { environment: "node", include: ["benchmarks/quality.eval.ts"], env: { EVAL_LIVE: "1" }, testTimeout: 3_600_000 },
});
