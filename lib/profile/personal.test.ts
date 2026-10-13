import { describe, expect, it } from "vitest";
import { cleanProfile, emptyProfile, hideRememberMarkers, parseRemember, personalPrompt } from "./personal";

describe("profile", () => {
  it("keeps only known fields within limits", () => {
    const p = cleanProfile({ display_name: "  Noah ", style: "hacker", length: "short", about: "x".repeat(5000), user_id: "someone-else", memory_enabled: "yes" });
    expect(p).toMatchObject({ display_name: "Noah", style: "", length: "short", memory_enabled: false });
    expect(p.about).toHaveLength(1500);
    expect(p).not.toHaveProperty("user_id");
  });

  it("turns preferences into prompt text, and nothing when empty", () => {
    expect(personalPrompt(null, [])).toBe("");
    expect(personalPrompt(emptyProfile(), [])).toBe("");
    const text = personalPrompt({ ...emptyProfile(), display_name: "Noah", level: "2nd year", program: "BSc CS", style: "step_by_step", instructions: "Use SI units." }, []);
    expect(text).toContain("Name: Noah. Program: BSc CS. Level: 2nd year.");
    expect(text).toContain("Explain step by step");
    expect(text).toContain("Use SI units.");
    expect(text).toContain("course instructions");
    expect(text).not.toContain("remember");
  });

  it("uses memories and explains saving only when memory is on", () => {
    const mem = [{ id: "1", content: "Takes STATS 2244", source: "student" as const, created_at: "" }];
    expect(personalPrompt({ ...emptyProfile(), memory_enabled: false }, mem)).toBe("");
    const on = personalPrompt({ ...emptyProfile(), memory_enabled: true }, mem);
    expect(on).toContain("- Takes STATS 2244");
    expect(on).toContain("[[remember:");
  });
});

describe("memory markers", () => {
  it("saves and removes them", () => {
    expect(parseRemember("Got it, I'll remember that.\n[[remember: Prefers SI units]]")).toEqual({ clean: "Got it, I'll remember that.", saved: ["Prefers SI units"] });
  });
  it("hides half-written markers while streaming", () => {
    expect(hideRememberMarkers("Sure.\n[[remem")).toBe("Sure.\n");
    expect(hideRememberMarkers("a [[remember: x]] b")).toBe("a  b");
  });
});
