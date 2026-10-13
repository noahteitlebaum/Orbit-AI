// xAI schemas have historically differed. Use the aggregate to distinguish them instead of adding blindly.
export function xaiBillableOutput(input: number, completion: number, reasoning: number, total?: number): number {
  if (total === input + completion) return completion; // reasoning already included
  if (total === input + completion + reasoning) return completion + reasoning;
  // Legacy Chat Completions reports visible completion separately; retain this convention without an aggregate.
  return completion + reasoning;
}
