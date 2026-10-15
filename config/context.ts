// Input targets include system, material, memories, history and tools. Output is reserved separately.
export const CONTEXT = {
  ordinaryTokens: 8_000,
  expandedTokens: 24_000,
  recentExchanges: 6,
  retrievalTokens: 800,
  memoryTokens: 500,
  materialTokens: 2_000,
  expandedMaterialTokens: 12_000,
  summaryRefreshMessages: 4,
} as const;
