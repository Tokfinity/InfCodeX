import { createHash } from 'node:crypto';

export interface MemoryContextIdentity {
  /** Explicit owner home for durable runtime state; never persisted in review envelopes. */
  readonly configHome?: string;
  readonly tenantId: string;
  readonly workspaceId?: string;
  readonly userId?: string;
  readonly agentId: string;
  readonly projectId?: string;
  readonly sessionId: string;
}

export interface MemoryApplicability {
  readonly tenantId: string;
  readonly workspaceId?: string;
  readonly userId?: string;
  readonly agentId?: string;
  readonly projectId?: string;
  readonly sessionId?: string;
}

const APPLICABILITY_FIELDS = [
  'tenantId',
  'workspaceId',
  'userId',
  'agentId',
  'projectId',
  'sessionId',
] as const;

export function matchesMemoryApplicability(
  identity: MemoryContextIdentity,
  applicability: MemoryApplicability,
): boolean {
  return APPLICABILITY_FIELDS.every((field) =>
    applicability[field] === undefined || applicability[field] === identity[field]);
}

export function hashMemoryIdentityComponent(kind: string, canonicalId: string): string {
  if (canonicalId.length === 0) {
    throw new Error(`${kind} identity must not be empty`);
  }
  return createHash('sha256').update(`${kind}\0${canonicalId}`).digest('hex');
}

export function memoryApplicabilityFingerprint(applicability: MemoryApplicability): string {
  const canonical = APPLICABILITY_FIELDS
    .filter((field) => applicability[field] !== undefined)
    .map((field) => `${field}=${applicability[field]}`)
    .join('\0');
  return createHash('sha256').update(canonical).digest('hex');
}
