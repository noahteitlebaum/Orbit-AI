import { describe, expect, it } from "vitest";
import { driveDownload } from "./google-drive";
import { sortItems } from "./onedrive";

describe("Google Drive", () => {
  it("converts Google Docs/Sheets/Slides to Office files and downloads others as-is", () => {
    expect(driveDownload({ id: "a b", name: "Lab report", mimeType: "application/vnd.google-apps.document" })).toEqual({
      name: "Lab report.docx",
      url: "https://www.googleapis.com/drive/v3/files/a%20b/export?mimeType=application%2Fvnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect(driveDownload({ id: "s", name: "Data.xlsx", mimeType: "application/vnd.google-apps.spreadsheet" })?.name).toBe("Data.xlsx");
    expect(driveDownload({ id: "p", name: "Lecture 3.pdf", mimeType: "application/pdf" })?.url).toContain("/files/p?alt=media");
    expect(driveDownload({ id: "f", name: "Survey", mimeType: "application/vnd.google-apps.form" })).toBeNull();
  });
});

describe("OneDrive", () => {
  it("lists folders first, then files by name", () => {
    expect(sortItems([{ id: "1", name: "b.pdf" }, { id: "2", name: "Zoo", folder: {} }, { id: "3", name: "a.pdf" }]).map((i) => i.name)).toEqual(["Zoo", "a.pdf", "b.pdf"]);
  });
});
