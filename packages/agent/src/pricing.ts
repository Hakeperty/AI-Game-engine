import type { Usage } from './types.ts';

/** USD per million tokens. cacheWrite is the 5-minute TTL write price (1.25x input). */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const price = (input: number, output: number, cacheRead = input * 0.1): ModelPrice => ({
  input,
  output,
  cacheRead,
  cacheWrite: input * 1.25,
});

/** Claude prices (Sept 2026). Local models are free. */
export const PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-opus-5': price(5, 25),
  'claude-opus-5-5': price(4, 20, 0.2),
  'claude-sonnet-5': price(2, 10),
  'claude-haiku-4-5': price(1, 5),
  'claude-fable-5-1': price(10, 50, 0.25),
  // Models that can serve a turn after a server-side refusal fallback.
  'claude-fable-5': price(10, 50),
  'claude-opus-4-8': price(5, 25),
  'claude-opus-4-7': price(5, 25),
  'claude-sonnet-4-6': price(3, 15),
};

/** Price for a model id; tolerates date suffixes ('claude-haiku-4-5-20251001') and '[1m]'-style tags. */
export function priceFor(model: string): ModelPrice | undefined {
  const id = model.replace(/\[.*\]$/, '');
  if (PRICES[id]) return PRICES[id];
  const undated = id.replace(/-\d{8}$/, '');
  return PRICES[undated];
}

/** Estimated cost of one usage record in USD (0 for unknown or local models). */
export function estimateCostUsd(model: string, usage: Usage): number {
  const p = priceFor(model);
  if (!p) return 0;
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.cacheWrite) /
    1_000_000
  );
}
