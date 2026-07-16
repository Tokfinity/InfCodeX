import { countTokens } from '../../tokenizer.js';

export function neverWorse(raw: string, filtered: string): string {
  return countTokens(filtered) >= countTokens(raw) ? raw : filtered;
}
