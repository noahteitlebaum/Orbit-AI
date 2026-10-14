import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, prepareMarkdown } from "./markdown";
import type { Source } from "./answer-text";

const src: Source[] = [{ n: 1, fileId: "f", fileName: "notes.pdf", page: 3, label: "notes.pdf, p. 3", excerpt: "x" }, { n: 2, kind: "web", fileId: "", fileName: "", page: null, label: "Wiki", excerpt: "y", url: "https://en.wikipedia.org/wiki/AVL_tree" }];

describe("prepareMarkdown", () => {
  it("turns citations into links, drops unknown ones when final, and leaves code alone", () => {
    const out = prepareMarkdown("Balanced [S1] and web [W2] but not [S9]. `a[S1]`\n```\nx[S1]\n```", src, true);
    expect(out).toContain(" [S1](cite:S1)");
    expect(out).toContain(" [W2](cite:W2)");
    expect(out).not.toContain("S9");
    expect(out).toContain("`a[S1]`");
    expect(out).toContain("x[S1]\n```");
  });
  it("keeps unknown citations while streaming and converts \\( \\) maths", () => {
    const out = prepareMarkdown("a [S9] and \\(x^2\\) and \\[y\\]", undefined, false);
    expect(out).toContain("[S9](cite:S9)");
    expect(out).toContain("$x^2$");
    expect(out).toContain("$$\ny\n$$");
  });
  it("hides quiz markers", () => {
    expect(prepareMarkdown("Right!\n[[quiz: right | trees]]", undefined, true).trim()).toBe("Right!");
  });
});

describe("Markdown", () => {
  it("renders headings, lists, tables, code with a header, maths and citation chips", () => {
    const html = renderToStaticMarkup(<Markdown sources={src} text={"## Title\n\n- **one** [S1]\n- two [W2]\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```python\nprint(1)\n```\n\n$E=mc^2$\n\n[link](https://uwo.ca)"} />);
    expect(html).toContain("<h2>Title</h2>");
    expect(html).toContain("<strong>one</strong>");
    expect(html).toMatch(/<sup[^>]*class="md-cite"[^>]*>1<\/sup>/);
    expect(html).toContain('href="https://en.wikipedia.org/wiki/AVL_tree"');
    expect(html).toContain('<div class="md-table"><table>');
    expect(html).toContain("md-code-head");
    expect(html).toContain(">python<");
    expect(html).toContain("hljs");
    expect(html).toContain('class="katex"');
    expect(html).toContain('target="_blank"');
  });
  it("never renders raw HTML from a reply", () => {
    const html = renderToStaticMarkup(<Markdown text={'<img src=x onerror="alert(1)"> <script>alert(1)</script>'} />);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
  });
});
