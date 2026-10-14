import { describe, expect, it } from "vitest";
import { matchChats } from "./search-chats";

describe("matchChats", () => {
  const chats = [
    { id: "1", title: "AVL tree rotations", updatedAt: "2026-10-10" },
    { id: "2", title: "Midterm study plan", updatedAt: "2026-10-12" },
    { id: "3", title: "Résumé feedback", updatedAt: "2026-10-11" },
    { id: "4", title: "", updatedAt: "2026-10-01" },
  ];
  it("matches every word, ignoring case and accents, newest first", () => {
    expect(matchChats(chats, "tree avl").map((c) => c.id)).toEqual(["1"]);
    expect(matchChats(chats, "resume").map((c) => c.id)).toEqual(["3"]);
    expect(matchChats(chats, "").map((c) => c.id)).toEqual(["2", "3", "1", "4"]);
    expect(matchChats(chats, "untitled").map((c) => c.id)).toEqual(["4"]);
  });
});
