import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chunkPages, detectMime, docxImageCount, extractDocument, referenceLabel } from "./extract";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url)));

describe("extractDocument", () => {
  it("PDF: keeps page numbers", async () => {
    const r = await extractDocument(fixture("lecture.pdf"), "application/pdf");
    expect(r.status).toBe("ready");
    expect(r.pageCount).toBe(2);
    expect(r.chunks.find((c) => c.content.includes("Stratified"))?.page).toBe(1);
    expect(r.chunks.find((c) => c.content.includes("Cluster"))?.page).toBe(2);
  });

  it("PDF with no text (scanned) is flagged, not silently accepted", async () => {
    const r = await extractDocument(fixture("scanned.pdf"), "application/pdf");
    expect(r.status).toBe("needs_ocr");
  });

  it("DOCX: extracts text as numbered parts", async () => {
    const r = await extractDocument(fixture("assignment.docx"), detectMime("assignment.docx", ""));
    expect(r.chunks[0].content).toContain("95 percent");
    expect(r.chunks[0].page).toBeNull();
  });

  it("TXT", async () => {
    const r = await extractDocument(new TextEncoder().encode("hello\n\n\n\nworld"), "text/plain");
    expect(r.chunks[0].content).toBe("hello\n\nworld");
  });
});

describe("chunking + labels", () => {
  it("splits long pages without crossing pages", () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence ${i} about sampling and variance.`).join(" ");
    const chunks = chunkPages([{ page: 1, text: long }, { page: 2, text: "short" }]);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.content.length <= 1400 * 1.3)).toBe(true);
    expect(chunks.at(-1)).toMatchObject({ page: 2, content: "short" });
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });

  it("labels", () => {
    expect(referenceLabel("lec.pdf", 4, 9)).toBe("lec.pdf, p. 4");
    expect(referenceLabel("a.docx", null, 1)).toBe("a.docx, part 2");
  });
});

describe("visual content isn't silently missed", () => {
  const text = "Sampling distributions describe how a statistic varies from sample to sample. ".repeat(3);
  // 1x1 PNG, scaled up when drawn
  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));

  async function makePdf() {
    const { PDFDocument, StandardFonts } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const img = await doc.embedPng(png);
    const page = (draw?: (p: ReturnType<typeof doc.addPage>) => void) => {
      const p = doc.addPage([600, 800]);
      p.drawText(text.slice(0, 90), { x: 20, y: 760, size: 10, font });
      p.drawText(text.slice(90, 180), { x: 20, y: 745, size: 10, font });
      draw?.(p);
    };
    page(); // 1: text only
    page((p) => p.drawImage(img, { x: 50, y: 200, width: 400, height: 300 })); // 2: a diagram picture
    page((p) => p.drawImage(img, { x: 550, y: 770, width: 30, height: 20 })); // 3: a small logo
    page((p) => { for (let i = 0; i < 80; i++) p.drawRectangle({ x: 20 + (i % 10) * 50, y: 100 + Math.floor(i / 10) * 40, width: 30 + i % 7, height: 20 }); }); // 4: a chart
    doc.addPage([600, 800]); // 5: blank / scanned-looking
    return doc.save();
  }

  it("flags PDF pages with pictures, charts or no text — not logos", async () => {
    const r = await extractDocument(await makePdf(), "application/pdf");
    expect(r.status).toBe("ready");
    expect(r.visualPages).toEqual([2, 4, 5]);
  });

  it("a scanned PDF is all visual pages", async () => {
    const r = await extractDocument(fixture("scanned.pdf"), "application/pdf");
    expect(r.visualPages).toEqual([1]);
  });

  it("counts pictures inside Word files", async () => {
    const r = await extractDocument(fixture("assignment.docx"), detectMime("assignment.docx", ""));
    expect(r.imageCount).toBe(0);
    expect(docxImageCount(zipWith(["word/document.xml", "word/media/image1.png", "word/media/image2.jpeg"]))).toBe(2);
  });
});

// A zip with empty entries (central directory is all docxImageCount reads).
function zipWith(names: string[]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const n of names) {
    const name = Buffer.from(n);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    parts.push(local, name);
    central.push(c, name);
    offset += local.length + name.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, end]));
}

describe("every common student file", () => {
  it("reading a PDF leaves the uploaded bytes intact (they're saved afterwards)", async () => {
    const bytes = fixture("lecture.pdf");
    const before = bytes.length;
    await extractDocument(bytes, "application/pdf");
    expect(bytes.length).toBe(before);
  });

  it("Excel: every sheet, as rows, with formula results and dates", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Grades");
    ws.addRow(["Name", "Mark", "Due"]);
    ws.addRow(["Ada", 91, new Date("2026-10-19T00:00:00Z")]);
    ws.getCell("B3").value = { formula: "B2*2", result: 182 };
    wb.addWorksheet("Notes").addRow(["Curve applied"]);
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
    const r = await extractDocument(bytes, detectMime("grades.xlsx", ""));
    const all = r.chunks.map((c) => c.content).join("\n");
    expect(r.pageCount).toBe(2);
    expect(all).toContain("Sheet: Grades\nRow 1: Name | Mark | Due\nRow 2: Ada | 91 | 2026-10-19");
    expect(all).toContain("Row 3:  | 182");
    expect(all).toContain("Sheet: Notes\nRow 1: Curve applied");
  });

  it("CSV with quotes and commas", async () => {
    const r = await extractDocument(new TextEncoder().encode('name,quote\nAda,"Hello, ""world"""\n'), detectMime("data.csv", ""));
    expect(r.chunks[0].content).toContain('Row 2: Ada | Hello, "world"');
  });

  it("PowerPoint: text and speaker notes per slide, slides with pictures flagged", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    const slide = (body: string) => `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
    zip.file("ppt/slides/slide1.xml", slide("<a:p><a:r><a:t>Sampling methods</a:t></a:r></a:p>"));
    zip.file("ppt/slides/slide2.xml", slide('<a:p><a:r><a:t>Cluster sampling</a:t></a:r></a:p><p:pic><p:blipFill/></p:pic>'));
    zip.file("ppt/slides/slide10.xml", slide("<a:p><a:r><a:t>Summary</a:t></a:r></a:p>"));
    zip.file("ppt/notesSlides/notesSlide1.xml", slide("<a:p><a:r><a:t>Mention the exam</a:t></a:r></a:p>"));
    const bytes = new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
    const r = await extractDocument(bytes, detectMime("week2.pptx", ""));
    expect(r.pageCount).toBe(3);
    expect(r.chunks.map((c) => [c.page, c.content])).toEqual([
      [1, "Sampling methods\n\nSpeaker notes: Mention the exam"],
      [2, "Cluster sampling"],
      [10, "Summary"],
    ]);
    expect(r.visualPages).toEqual([2]);
    expect(referenceLabel("week2.pptx", 10, 2)).toBe("week2.pptx, slide 10");
  });

  it("notebooks, code and any other text file", async () => {
    const nb = { cells: [{ cell_type: "markdown", source: ["# Lab 3"] }, { cell_type: "code", source: "x = 1\nprint(x)" }] };
    const r = await extractDocument(new TextEncoder().encode(JSON.stringify(nb)), detectMime("lab3.ipynb", ""));
    expect(r.chunks[0].content).toBe("[Cell 1]\n# Lab 3\n\n[Cell 2, code]\nx = 1\nprint(x)");
    expect(detectMime("main.py", "")).toBe("text/plain");
    expect(detectMime("thesis.tex", "application/x-tex")).toBe("text/plain");
    const unknown = await extractDocument(new TextEncoder().encode("plain notes in an odd format"), "application/octet-stream");
    expect(unknown.chunks[0].content).toBe("plain notes in an odd format");
    await expect(extractDocument(new Uint8Array([0, 1, 2, 3]), "application/octet-stream")).rejects.toThrow("unsupported_type");
  });
});
