// Web search (one search per question when the student turns on "Search the web"). Provider: Tavily
// (docs.tavily.com). Prices checked Oct 12 2026: 1 credit per basic search, $0.008 per credit pay-as-you-go
// (1,000 free credits/month on Tavily's side; students are still charged so budgets stay predictable).
export const WEB_SEARCH = {
  provider: "tavily" as const,
  label: "Web search",
  pricePerSearch: 0.008, // US$
  maxResults: 5,
  maxCharsPerResult: 2_500, // page text kept per result (cost and context)
};
