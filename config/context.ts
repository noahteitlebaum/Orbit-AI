// Economic input budget, independent of provider windows. All estimates include system/files/tools.
export const CONTEXT = {
  ordinaryInputTokens: 8_000,
  complexInputTokens: 16_000,
  maximumInputTokens: 24_000,
  toolInputTokens: 10_000, // shared evidence allowance; shrinks automatically for larger prompts
  toolSafetyTokens: 256,
  recentExchanges: 5,
  summaryTokens: 1_500,
  retrievalTokens: 1_200,
  materialTokens: 2_000,
  largeTaskMaterialTokens: 12_000,
  summaryBatchChars: 16_000,
  summaryMaxPasses: 1,
};
export const SEMANTIC_MEMORY = {
  model: "text-embedding-3-small", dimensions: 1536, inputPrice: 0.02,
  indexBatch: 8, sourceChars: 1_800, limit: 4, minSimilarity: 0.35,
};
