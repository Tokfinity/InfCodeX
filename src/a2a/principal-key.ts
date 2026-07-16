import { createHash } from 'node:crypto';

export const A2A_PRINCIPAL_KEY_SCHEME = 'realm-subject-tenant-v1' as const;

export interface A2APrincipalIdentity {
  readonly subject: string;
  readonly tenant?: string;
}

export interface A2ARealmPrincipalIdentity extends A2APrincipalIdentity {
  readonly securityRealm: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function legacyA2APrincipalKey(principal: A2APrincipalIdentity): string {
  return sha256(`${principal.subject}\0${principal.tenant ?? ''}`);
}

export function realmA2APrincipalKey(principal: A2ARealmPrincipalIdentity): string {
  return sha256(JSON.stringify([
    principal.securityRealm,
    principal.subject,
    principal.tenant ?? null,
  ]));
}
