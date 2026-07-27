import { createHash } from 'node:crypto';
import {
  MEMORY_EVIDENCE_CLAIM_MAX_CHARS,
  MEMORY_EVIDENCE_OVERRIDE,
  MEMORY_EVIDENCE_PREFIX,
  MEMORY_EVIDENCE_REF_LIMIT,
  MEMORY_EVIDENCE_REF_MAX_CHARS,
  MEMORY_EVIDENCE_TOKEN_RESERVE,
  MEMORY_POLICY_VERSION,
  renderMemoryEvidenceEnvelope,
} from '@kodax-ai/agent/experimental-memory';

export {
  MEMORY_EVIDENCE_OVERRIDE,
  MEMORY_EVIDENCE_PREFIX,
  MEMORY_EVIDENCE_TOKEN_RESERVE,
  renderMemoryEvidenceEnvelope,
};

const MEMORY_EVIDENCE_TEMPLATE = [
  MEMORY_EVIDENCE_PREFIX,
  'Claim: {{claim}}',
  'Ref: {{refs?}}',
  MEMORY_EVIDENCE_OVERRIDE,
  `Policy: ${MEMORY_POLICY_VERSION}; claimMaxChars=${MEMORY_EVIDENCE_CLAIM_MAX_CHARS}; `
    + `refMaxChars=${MEMORY_EVIDENCE_REF_MAX_CHARS}; refLimit=${MEMORY_EVIDENCE_REF_LIMIT}; `
    + `maxTokens=${MEMORY_EVIDENCE_TOKEN_RESERVE}; promptSafe=true`,
].join('\n');

export const MEMORY_EVIDENCE_TEMPLATE_SHA256 = `sha256:${createHash('sha256')
  .update(MEMORY_EVIDENCE_TEMPLATE)
  .digest('hex')}`;
