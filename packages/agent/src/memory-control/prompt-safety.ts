const RESTRICTED_MEMORY_PATTERN =
  /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|authorization:\s*bearer\s+\S+|(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S+)/i;
const PROMPT_OVERRIDE_PATTERN =
  /(?:ignore|disregard|override)\s+(?:(?:all|any)\s+)?(?:(?:previous|prior|system|developer)\s+){1,3}instructions?/i;
const ROLE_TAG_PATTERN = /<\/?(?:system|developer|assistant|tool|prompt)(?:\s|>)/i;

/**
 * Returns one bounded claim that is safe to expose as low-authority memory
 * evidence. Undefined means the source must remain reference-only.
 */
export function sanitizePromptSafeMemoryClaim(
  value: string,
  maxChars = 512,
): string | undefined {
  if (
    RESTRICTED_MEMORY_PATTERN.test(value)
    || PROMPT_OVERRIDE_PATTERN.test(value)
    || ROLE_TAG_PATTERN.test(value)
  ) {
    return undefined;
  }
  const compact = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return compact.length === 0 ? undefined : compact.slice(0, Math.max(1, maxChars));
}
