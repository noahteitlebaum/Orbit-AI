import { describe, expect, it } from "vitest";
import { domainOf, searchQuery } from "./web";

describe("web search helpers", () => {
  it("adds the previous question to short follow-ups", () => {
    expect(searchQuery("and in 2025?", "Canada inflation rate")).toBe("Canada inflation rate and in 2025?");
    expect(searchQuery("What is the current Canadian inflation rate this month", "x")).toBe("What is the current Canadian inflation rate this month");
  });
  it("shows the site name", () => {
    expect(domainOf("https://www.statcan.gc.ca/en/start")).toBe("statcan.gc.ca");
  });
});
