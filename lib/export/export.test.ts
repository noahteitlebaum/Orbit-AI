import { describe, expect, it } from "vitest";
import type { Source } from "@/components/answer-text";
import { answerMarkdown, chatMarkdown, fileSlug, markdownTables, normalizeMath, toCsv, toPlainText } from "./export";

const src: Source[] = [
  { n: 1, fileId: "f", fileName: "lec3.pdf", page: 4, label: "lec3.pdf, p. 4", excerpt: "x" },
  { n: 1, fileId: "", fileName: "", page: null, label: "Khan Academy: Variance", excerpt: "y", kind: "web", url: "https://khanacademy.org/v" },
];

describe("answer export", () => {
  it("keeps equations and real references, drops quiz markers and made-up citations", () => {
    const md = answerMarkdown({ role: "assistant", content: "Variance is \\(\\sigma^2\\) [S1] and see [S9] [W1].\n[[quiz: right | variance]]\n\\[ s^2 = \\frac{1}{n-1}\\sum (x_i-\\bar x)^2 \\]", sources: src });
    expect(md).toContain("Variance is $\\sigma^2$ [S1] and see [W1].");
    expect(md).toContain("$$s^2 = \\frac{1}{n-1}\\sum (x_i-\\bar x)^2$$");
    expect(md).not.toContain("quiz");
    expect(md).toContain("- [S1] lec3.pdf, p. 4");
    expect(md).toContain("- [W1] Khan Academy: Variance — <https://khanacademy.org/v>");
  });

  it("leaves code alone", () => {
    expect(normalizeMath("```\nprint('\\(x\\)')\n```")).toBe("```\nprint('\\(x\\)')\n```");
  });

  it("includes Python code and output", () => {
    const md = answerMarkdown({ role: "assistant", content: "Mean is 4.", runs: [{ code: "print(4)", stdout: "4", files: ["plot.png"] }] });
    expect(md).toContain("```python\nprint(4)\n```");
    expect(md).toContain("Files made: plot.png");
  });

  it("exports a whole chat", () => {
    const md = chatMarkdown("Stats review", [
      { role: "user", content: "what is variance", attachments: ["lec3.pdf"] },
      { role: "assistant", content: "Spread [S1].", sources: src.slice(0, 1), author: "Claude Sonnet" },
    ], new Date("2026-10-12"));
    expect(md).toMatch(/^# Stats review\n\n_Exported 2026-10-12_\n\n## You\n\nwhat is variance\n\n_Attached: lec3.pdf_\n\n## Claude Sonnet\n\nSpread \[S1\]\./);
  });
});

describe("plain text", () => {
  it("removes Markdown but keeps math and links", () => {
    expect(toPlainText("## Key idea\n**Bold** and _it_ with $x^2$\n- [docs](https://a.b)\n```python\nx = 1\n```")).toBe("Key idea\nBold and it with $x^2$\n• docs (https://a.b)\nx = 1\n");
  });
});

describe("tables to CSV", () => {
  it("finds tables and writes safe CSV", () => {
    const t = markdownTables("Intro\n\n| Term | Value |\n|---|---:|\n| **mean** | 4.2 |\n| a, b | =SUM(A1) |\n| neg | -3.5 |\n\nAfter");
    expect(t).toEqual([[["Term", "Value"], ["mean", "4.2"], ["a, b", "=SUM(A1)"], ["neg", "-3.5"]]]);
    expect(toCsv(t[0])).toBe('﻿Term,Value\r\nmean,4.2\r\n"a, b",\'=SUM(A1)\r\nneg,-3.5\r\n');
  });

  it("ignores tables inside code", () => {
    expect(markdownTables("```\n| a | b |\n|---|---|\n```")).toEqual([]);
  });

  it("names files", () => {
    expect(fileSlug("What is variance? (Ch. 3)")).toBe("what-is-variance-ch-3");
    expect(fileSlug("!!!")).toBe("orbit-answer");
  });
});
