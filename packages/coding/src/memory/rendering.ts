import { createHash } from 'node:crypto';
import {
  MEMORY_EVIDENCE_OVERRIDE,
  MEMORY_EVIDENCE_PREFIX,
  MEMORY_EVIDENCE_TOKEN_RESERVE,
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
].join('\n');

export const MEMORY_EVIDENCE_TEMPLATE_SHA256 = `sha256:${createHash('sha256')
  .update(MEMORY_EVIDENCE_TEMPLATE)
  .digest('hex')}`;
