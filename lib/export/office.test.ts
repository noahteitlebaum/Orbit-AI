import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { docxBlob, inlineRuns, mdBlocks, pptxBlob, slidesFrom, xlsxBlob } from "./office";

const MD = `# Photosynthesis

Plants turn **light** into *chemical* energy [S1].

## Steps

1. Light reactions
2. Calvin cycle
   - uses ATP

| Stage | Where | Yield |
| --- | --- | --- |
| Light | Thylakoid | 12% |
| Calvin | Stroma | 3 |

\`\`\`python
print("hi")
\`\`\`

$$
6CO_2 + 6H_2O \\to C_6H_{12}O_6 + 6O_2
$$
`;

describe("office exports", () => {
  it("parses inline formatting and drops citation markers", () => {
    expect(inlineRuns("A **b** *c* `d` [link](http://x) [S1]")).toEqual([
      { text: "A " }, { text: "b", bold: true }, { text: " " }, { text: "c", italic: true }, { text: " " }, { text: "d", code: true }, { text: " link" },
    ]);
  });
  it("splits Markdown into blocks", () => {
    const b = mdBlocks(MD);
    expect(b.map((x) => x.type)).toEqual(["heading", "para", "heading", "list", "table", "code", "math"]);
    const list = b[3] as Extract<typeof b[number], { type: "list" }>;
    expect(list.items.map((i) => i.depth)).toEqual([0, 0, 1]);
    expect((b[4] as { rows: string[][] }).rows[1]).toEqual(["Light", "Thylakoid", "12%"]);
    expect((b[6] as { text: string }).text).toContain("C_6H_{12}O_6");
  });
  it("makes slides per heading, with tables and code on their own", () => {
    const s = slidesFrom("Bio", mdBlocks(MD));
    expect(s.map((x) => x.title)).toEqual(["Photosynthesis", "Steps", "Steps", "Steps", "Steps (cont.)"]);
    expect(s[1].bullets.map((b) => b.text)).toEqual(["Light reactions", "Calvin cycle", "uses ATP"]);
    expect(s[2].table?.[0]).toEqual(["Stage", "Where", "Yield"]);
    expect(s[3].code).toContain("print");
  });
  it("splits long sections", () => {
    const s = slidesFrom("T", mdBlocks(Array.from({ length: 10 }, (_, i) => `- point ${i}`).join("\n")));
    expect(s.map((x) => x.bullets.length)).toEqual([7, 3]);
    expect(s[1].title).toBe("T (cont.)");
  });
  it("builds real .docx, .xlsx and .pptx files", async () => {
    const docx = await JSZip.loadAsync(await (await docxBlob("Bio", MD)).arrayBuffer());
    const xml = await docx.file("word/document.xml")!.async("string");
    expect(xml).toContain("Calvin cycle");
    expect(xml).toContain("Thylakoid");

    const xlsx = await JSZip.loadAsync(await (await xlsxBlob([[["Stage", "Yield"], ["Light", "12%"], ["Calvin", "3"]]])).arrayBuffer());
    const sheet = await xlsx.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(sheet).toContain("<v>0.12</v>");
    expect(sheet).toContain("<v>3</v>");

    const pptx = await JSZip.loadAsync(await (await pptxBlob("Bio", MD)).arrayBuffer());
    const slides = Object.keys(pptx.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    expect(slides.length).toBe(6); // cover + 5
    expect(await pptx.file("ppt/slides/slide3.xml")!.async("string")).toContain("Light reactions");
  });
});
