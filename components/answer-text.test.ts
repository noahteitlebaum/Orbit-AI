import { describe, expect, it } from "vitest";
import { citationParts, type Source } from "./answer-text";

const src: Source = { n: 1, fileId: "f", fileName: "lec.pdf", page: 4, label: "lec.pdf, p. 4", excerpt: "…" };

describe("citation chips", () => {
  it("a final answer never shows a marker without a real passage", () => {
    expect(citationParts("A [S1] and B [S3].", [src], true)).toEqual([{ text: "A" }, { text: " " }, { n: 1, source: src }, { text: " and B" }, { text: "." }]);
  });
  it("while streaming, markers stay (their sources arrive at the end)", () => {
    expect(citationParts("A [S3]", [], false)).toEqual([{ text: "A" }, { text: " " }, { n: 3, source: undefined }]);
  });
});
