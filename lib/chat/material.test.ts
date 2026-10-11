import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { fakeSupabase } from "@/test/fake-supabase";
import { gatherMaterial, MAX_VISUAL_PAGES } from "./material";

// Visual material must either reach the model or be named to it — never silently skipped.
const CHAT = "chat-1";
const file = (over: Record<string, unknown>) => ({
  id: crypto.randomUUID(), user_id: "u", name: "slides.pdf", kind: "document", status: "ready", char_count: 100, page_count: 40,
  project_id: null, conversation_id: CHAT, storage_path: "u/slides.pdf", mime: "application/pdf", visual_pages: [], image_count: 0, ...over,
});

async function makePdf(pages: number) {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  return new Uint8Array(await doc.save());
}

async function gather(files: Record<string, unknown>[], opts: { pdfInput?: boolean; question?: string; projectId?: string | null } = {}) {
  const fake = fakeSupabase({ files });
  fake.storage["u/slides.pdf"] = { bytes: await makePdf(40), type: "application/pdf" };
  fake.storage["u/cell.png"] = { bytes: new Uint8Array([1, 2]), type: "image/png" };
  return gatherMaterial(fake.client as unknown as SupabaseClient, {
    conversationId: CHAT, projectId: opts.projectId ?? null, question: opts.question ?? "explain this", newAttachmentIds: [],
    pdfInput: opts.pdfInput ?? true,
  });
}

describe("visual material", () => {
  it("sends visual pages of an attachment as a PDF of just those pages, with citations", async () => {
    const m = await gather([file({ visual_pages: [3, 7] })]);
    expect(m.documents).toHaveLength(1);
    expect(m.documents[0].name).toBe("slides.pdf (pages 3, 7)");
    const { PDFDocument } = await import("pdf-lib");
    expect((await PDFDocument.load(Buffer.from(m.documents[0].data, "base64"))).getPageCount()).toBe(2);
    expect(m.sources.map((s) => s.label)).toEqual(["slides.pdf, p. 3", "slides.pdf, p. 7"]);
    expect(m.block).toContain('page 2 of the attached PDF "slides.pdf (pages 3, 7)"');
    expect(m.visualTokens).toBeGreaterThan(0);
  });

  it("caps pages per question and names the ones left out", async () => {
    const all = Array.from({ length: 12 }, (_, i) => i + 1);
    const m = await gather([file({ status: "needs_ocr", char_count: 0, visual_pages: all })]);
    expect(m.sources).toHaveLength(MAX_VISUAL_PAGES);
    expect(m.notes.join(" ")).toMatch(/pages 9, 10, 11 and 12 .*weren't included/);
  });

  it("apps that can't read PDFs are told which pages they can't see", async () => {
    const m = await gather([file({ visual_pages: [5] })], { pdfInput: false });
    expect(m.documents).toEqual([]);
    expect(m.notes.join(" ")).toContain("slides.pdf: page 5 is a scanned page or diagram this app can't see");
  });

  it("names pictures inside Word files", async () => {
    const m = await gather([file({ name: "lab.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", image_count: 3 })]);
    expect(m.notes.join(" ")).toContain("lab.docx contains 3 pictures");
  });

  it("sends course images whose name matches the question, and names the rest", async () => {
    const imgs = [
      file({ name: "cell-diagram.png", kind: "image", mime: "image/png", storage_path: "u/cell.png", conversation_id: null, project_id: "course" }),
      file({ name: "timeline.png", kind: "image", mime: "image/png", storage_path: "u/x.png", conversation_id: null, project_id: "course" }),
    ];
    const m = await gather(imgs, { question: "label the cell diagram", projectId: "course" });
    expect(m.images).toEqual([{ mime: "image/png", data: Buffer.from([1, 2]).toString("base64") }]);
    expect(m.notes.join(" ")).toContain("Course images attached to this question: cell-diagram.png");
    expect(m.notes.join(" ")).toContain("1 image that wasn't shown: timeline.png");
  });
});

describe("finding the right course passages", () => {
  it("matches files the question names, numbers included", async () => {
    const { namedFiles, mentionedPages, nameTokens } = await import("./material");
    const files = [{ name: "Lecture3_Sampling.pdf" }, { name: "Lecture 4 - Regression.pptx" }, { name: "Assignment2 spec.docx" }, { name: "syllabus.pdf" }];
    expect(nameTokens("Lecture3_Sampling")).toEqual(["lecture", "3", "sampling"]);
    expect(namedFiles("summarize lecture 3", files).map((f) => f.name)).toEqual(["Lecture3_Sampling.pdf"]);
    expect(namedFiles("what's due in assignment 2?", files).map((f) => f.name)).toEqual(["Assignment2 spec.docx"]);
    expect(namedFiles("when is the midterm? check the syllabus", files).map((f) => f.name)).toEqual(["syllabus.pdf"]);
    expect(namedFiles("explain variance", files)).toEqual([]);
    expect(mentionedPages("see page 12 and slides 3-5")).toEqual([12, 3, 4, 5]);
  });

  async function courseFake() {
    const course = "course-1";
    const lec = file({ id: "f-lec", name: "Lecture3_Sampling.pdf", conversation_id: null, project_id: course, char_count: 90_000, page_count: 30 });
    const fake = fakeSupabase({
      files: [lec, file({ id: "f-syl", name: "syllabus.pdf", conversation_id: null, project_id: course, char_count: 90_000, page_count: 4 })],
      file_chunks: [
        { id: "a", file_id: "f-lec", page: 1, chunk_index: 0, content: "Lecture 3 overview" },
        { id: "b", file_id: "f-lec", page: 12, chunk_index: 11, content: "Cluster sampling groups" },
        { id: "c", file_id: "f-syl", page: 2, chunk_index: 1, content: "Midterm on October 30" },
      ],
    });
    const run = (question: string, previousQuestion?: string) =>
      gatherMaterial(fake.client as unknown as SupabaseClient, { conversationId: CHAT, projectId: course, question, previousQuestion, newAttachmentIds: [], pdfInput: true });
    return run;
  }

  it("always tells the model which files the course has", async () => {
    const m = await (await courseFake())("hello");
    expect(m.notes.join(" ")).toContain("Files in this course: Lecture3_Sampling.pdf (30 pages), syllabus.pdf (4 pages)");
  });

  it("a named file with no keyword match still sends its opening; a named page sends that page", async () => {
    const run = await courseFake();
    expect((await run("summarize lecture 3")).sources.map((s) => s.label)).toEqual(["Lecture3_Sampling.pdf, p. 1"]);
    expect((await run("what is on page 12 of lecture 3?")).sources.map((s) => s.label)).toContain("Lecture3_Sampling.pdf, p. 12");
  });

  it("a follow-up with no keywords searches with the previous question", async () => {
    const run = await courseFake();
    expect((await run("and when is that?", "is there a midterm?")).sources.map((s) => s.label)).toEqual(["syllabus.pdf, p. 2"]);
  });
});
