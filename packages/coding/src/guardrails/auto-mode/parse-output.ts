/**
 * Parse the auto-mode classifier's output — FEATURE_092 Phase 2b.3 (v0.7.33).
 *
 * Expected format:
 *   <block>yes|no</block><reason>one short sentence</reason>
 *
 * Robustness:
 *   - case-insensitive yes/no
 *   - whitespace inside / around tags tolerated
 *   - allow reason is optional; a blocking decision without a reason is a
 *     contract failure so the caller can retry instead of inventing a reason
 *   - if block tag missing or value is neither yes/no → unparseable (caller
 *     fail-closes to block, per design doc)
 *   - reasons longer than 500 chars are truncated (defense against
 *     pathological model outputs)
 *   - first <block> tag wins (defense against prompt-injection echoing
 *     the format with a different value later)
 */

export type ClassifierDecision =
  | { readonly kind: 'block'; readonly reason: string }
  | { readonly kind: 'allow'; readonly reason: string }
  | { readonly kind: 'unparseable'; readonly raw: string };

const BLOCK_RE = /<block>\s*([^<]+?)\s*<\/block>/i;
const REASON_RE = /<reason>\s*([\s\S]*?)\s*<\/reason>/i;
const MAX_REASON_LEN = 500;

export function parseClassifierOutput(raw: string): ClassifierDecision {
  const blockMatch = raw.match(BLOCK_RE);
  if (!blockMatch) {
    return { kind: 'unparseable', raw };
  }
  const verdict = blockMatch[1]!.toLowerCase();
  if (verdict !== 'yes' && verdict !== 'no') {
    return { kind: 'unparseable', raw };
  }

  const reasonMatch = raw.match(REASON_RE);
  let reason = reasonMatch ? reasonMatch[1]!.trim() : '';
  if (reason.length > MAX_REASON_LEN) {
    reason = reason.slice(0, MAX_REASON_LEN - 1) + '…';
  }

  if (verdict === 'yes') {
    return reason
      ? { kind: 'block', reason }
      : { kind: 'unparseable', raw };
  }
  return { kind: 'allow', reason };
}
