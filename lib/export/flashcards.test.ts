import { describe, expect, it } from "vitest";
import { extractCards, toFlashcardText } from "./flashcards";

describe("flashcards", () => {
  it("reads Front | Back tables", () => {
    expect(extractCards("| Front | Back |\n|---|---|\n| **Mitosis** | Cell division into 2 identical cells |\n| Meiosis | Division into 4 gametes |"))
      .toEqual([{ front: "Mitosis", back: "Cell division into 2 identical cells" }, { front: "Meiosis", back: "Division into 4 gametes" }]);
  });
  it("reads Q/A pairs and term lists", () => {
    const md = "Q: What is ATP?\nA: The cell's energy currency.\n\nQ: Where is it made?\nA: Mitochondria.\n\n- **Osmosis**: water moving across a membrane\n- Diffusion — particles spreading out";
    expect(extractCards(md)).toEqual([
      { front: "What is ATP?", back: "The cell's energy currency." },
      { front: "Where is it made?", back: "Mitochondria." },
      { front: "Osmosis", back: "water moving across a membrane" },
      { front: "Diffusion", back: "particles spreading out" },
    ]);
  });
  it("ignores ordinary prose and writes tab-separated lines", () => {
    expect(extractCards("Variance measures spread. It is the square of the standard deviation.")).toEqual([]);
    expect(toFlashcardText([{ front: "a\tb", back: "line1\nline2" }])).toBe("a b\tline1 line2\n");
  });
});
