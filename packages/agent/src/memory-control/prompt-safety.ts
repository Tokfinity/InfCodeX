const DIRECT_RESTRICTED_MEMORY_PATTERN =
  /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|authorization:\s*bearer\b|\b(?:api[_\s-]?key|password|secret|token)\b\s*(?:[:=]|->|=>))/i;
const SENTENCE_CREDENTIAL_PATTERN =
  /\b(?:api[_\s-]?key|password|secret|token)\b\s+(?:(?:actually|currently|now|presently|really)\s+)?(?:is|was|equals?)\s+(.+)/i;
const QUALIFIED_SENTENCE_CREDENTIAL_PATTERN =
  /\b(?:api[_\s-]?key|password|secret|token)\b\s+(?:(?:used|stored|configured|set|issued|deployed|assigned|shared|provided|required)\b(?:\s+(?:by|for|in|on|at|with|from|to)\b)?|(?:for|in|on|at)\b)(?:\s+[\p{L}\p{N}._-]+){0,3}\s+(?:is|was|equals?)\s+(.+)/iu;
const SAFE_CREDENTIAL_STATES = new Set([
  'active',
  'disabled',
  'empty',
  'expired',
  'invalid',
  'masked',
  'missing',
  'redacted',
  'revoked',
  'rotated',
  'rotated today',
  'rotated yesterday',
  'the configured environment value',
  'the expected environment value',
  'the stored environment value',
  'not available',
  'not configured',
  'not present',
  'not set',
  'unavailable',
  'unknown',
  'unset',
  'valid',
]);
const PROMPT_OVERRIDE_PATTERN =
  /\b(?:ignore|disregard|override)\s+(?:(?:all|any|the|these|those)\s+)?(?:(?:previous|prior|earlier|above|system|developer)\s+){0,3}(?:instructions?|prompts?|rules?|directives?|guidelines?)\b/i;
const PROMPT_RESET_PATTERN =
  /\bforget\s+(?:(?:all|any|the)\s+)?(?:above\b|everything\s+(?:above|before)\b|(?:(?:previous|prior|earlier|system|developer)\s+){0,3}(?:instructions?|prompts?|rules?|directives?|guidelines?)\b)/i;
const ROLE_MODE_PATTERN =
  /\byou\s+are\s+now\s+(?:in\s+)?(?:system|developer|assistant|tool)\s+mode\b/i;
const ROLE_TAG_PATTERN = /<\/?(?:system|developer|assistant|tool|prompt)(?=[\s/>])/i;
const DETECTION_ARROW_PATTERN = /(?:->|=>|[→⇒➔➜➝⟶⟹↦])/g;
const DETECTION_DELIMITER_PATTERN = /["'`*_~“”‘’«»‹›()[\]{}]+/g;
const HTML_TAG_PATTERN = /<\/?[^<>]*>/g;

function compactMemoryClaim(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\p{Cf}/gu, '')
    .replace(HTML_TAG_PATTERN, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function memoryClaimStructuralView(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(DETECTION_ARROW_PATTERN, ' = ');
}

function memoryClaimForDetection(value: string, separator: '' | ' '): string {
  return compactMemoryClaim(
    memoryClaimStructuralView(value)
      .replace(HTML_TAG_PATTERN, separator)
      .replace(DETECTION_DELIMITER_PATTERN, separator),
  );
}

function memoryClaimDetectionViews(value: string): readonly [string, string] {
  return [
    memoryClaimForDetection(value, ' '),
    memoryClaimForDetection(value, ''),
  ];
}

function containsSentenceCredential(value: string): boolean {
  const match = SENTENCE_CREDENTIAL_PATTERN.exec(value)
    ?? QUALIFIED_SENTENCE_CREDENTIAL_PATTERN.exec(value);
  const candidate = match?.[1]
    ?.replace(/^["'`]+|[.!?'"`]+$/g, '')
    .trim();
  if (candidate === undefined || candidate.length === 0) return false;
  if (SAFE_CREDENTIAL_STATES.has(candidate.toLowerCase())) return false;
  return true;
}

export function isRestrictedMemoryContent(value: string): boolean {
  return DIRECT_RESTRICTED_MEMORY_PATTERN.test(memoryClaimStructuralView(value))
    || memoryClaimDetectionViews(value).some((detection) =>
    DIRECT_RESTRICTED_MEMORY_PATTERN.test(detection)
    || containsSentenceCredential(detection),
  );
}

function containsUnsafeMemoryClaim(value: string): boolean {
  return isRestrictedMemoryContent(value)
    || ROLE_TAG_PATTERN.test(memoryClaimStructuralView(value))
    || memoryClaimDetectionViews(value).some((detection) =>
      PROMPT_OVERRIDE_PATTERN.test(detection)
      || PROMPT_RESET_PATTERN.test(detection)
      || ROLE_MODE_PATTERN.test(detection),
    );
}

/**
 * Returns one bounded claim that is safe to expose as low-authority memory
 * evidence. Undefined means the source must remain reference-only.
 */
export function sanitizePromptSafeMemoryClaim(
  value: string,
  maxChars = 512,
): string | undefined {
  const compact = compactMemoryClaim(value);
  if (compact.length === 0) return undefined;
  const bounded = compact.slice(0, Math.max(1, maxChars));
  return containsUnsafeMemoryClaim(value)
    || containsUnsafeMemoryClaim(compact)
    || containsUnsafeMemoryClaim(bounded)
    ? undefined
    : bounded;
}
