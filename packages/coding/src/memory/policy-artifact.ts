import { MEMORY_POLICY_VERSION } from '@kodax-ai/agent/experimental-memory';
import { MEMORY_RECALL_TOOL_BYTES_SHA256 } from '../tools/memory-recall.js';
import { MEMORY_EVIDENCE_TEMPLATE_SHA256 } from './rendering.js';
import { MEMORY_RULES_SHA256 } from '../prompts/memory-rules.js';

export interface MemoryPolicyArtifact {
  readonly policyVersion: string;
  readonly evidenceTemplateSha256: string;
  readonly deliberateRecallToolSha256: string;
  readonly memoryRulesSha256: string;
}

export const MEMORY_POLICY_ARTIFACT: MemoryPolicyArtifact = Object.freeze({
  policyVersion: MEMORY_POLICY_VERSION,
  evidenceTemplateSha256: MEMORY_EVIDENCE_TEMPLATE_SHA256,
  deliberateRecallToolSha256: MEMORY_RECALL_TOOL_BYTES_SHA256,
  memoryRulesSha256: MEMORY_RULES_SHA256,
});
