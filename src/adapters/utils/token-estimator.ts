/**
 * Conservative, streaming token estimator used to drive the live UI counter.
 *
 * Typical LLM tokenizers produce ~1 token per 4 characters of English text. We
 * deliberately use `chars / 5` so the estimate stays below the true count —
 * the real `tokenUsage` (which includes input and cache tokens we never see on
 * the wire) always exceeds this running estimate, letting the UI smoothly
 * count up to the final value without ever reversing.
 *
 * `onProgress` is throttled to only fire when the estimate has grown by at
 * least `MIN_DELTA` tokens, which avoids flooding `onJobUpdate` on very busy
 * streams.
 */

/** Characters per estimated token. Intentionally higher than the real ratio. */
const CHARS_PER_TOKEN = 5;

/** Minimum token delta before emitting a progress update. */
const MIN_DELTA = 5;

export interface TokenEstimator {
  /** Append assistant text. Triggers `onProgress` when the estimate grows enough. */
  addText(text: string): void;
  /** Current conservative token estimate. */
  current(): number;
}

export function createTokenEstimator(onProgress?: (estimatedTokens: number) => void): TokenEstimator {
  let chars = 0;
  let lastEmitted = 0;

  return {
    addText(text: string) {
      if (!text) return;
      chars += text.length;
      const estimate = Math.ceil(chars / CHARS_PER_TOKEN);
      if (estimate - lastEmitted >= MIN_DELTA) {
        lastEmitted = estimate;
        onProgress?.(estimate);
      }
    },
    current() {
      return Math.ceil(chars / CHARS_PER_TOKEN);
    },
  };
}
