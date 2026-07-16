import os from 'node:os';
import path from 'node:path';

import {
  legacyA2APrincipalKey,
  realmA2APrincipalKey,
} from './principal-key.js';
import { A2AFileTaskStore } from './task-store.js';

export interface A2ALegacyTaskOwnerMapping {
  readonly subject: string;
  readonly tenant?: string;
  readonly securityRealm: string;
}

export interface A2ALegacyTaskOwnerMigrationOptions {
  readonly dataDir: string;
  readonly mappings: readonly A2ALegacyTaskOwnerMapping[];
  readonly apply: boolean;
}

export interface A2ALegacyTaskOwnerMigrationResult {
  readonly dataDir: string;
  readonly applied: boolean;
  readonly matchedLegacyTaskCount: number;
  readonly matchedCurrentTaskCount: number;
  readonly unmatchedUnversionedTaskCount: number;
}

function resolveDataDir(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function validateMapping(value: A2ALegacyTaskOwnerMapping, index: number): void {
  if (typeof value.subject !== 'string') {
    throw new Error(`A2A legacy task owner mapping ${index} subject must be a string.`);
  }
  if (value.tenant !== undefined && typeof value.tenant !== 'string') {
    throw new Error(`A2A legacy task owner mapping ${index} tenant must be a string.`);
  }
  if (typeof value.securityRealm !== 'string' || value.securityRealm.trim().length === 0) {
    throw new Error(`A2A legacy task owner mapping ${index} securityRealm must be a non-empty stable string.`);
  }
}

export function migrateA2ALegacyTaskOwners(
  options: A2ALegacyTaskOwnerMigrationOptions,
): A2ALegacyTaskOwnerMigrationResult {
  if (typeof options.dataDir !== 'string' || options.dataDir.trim().length === 0) {
    throw new Error('A2A legacy task owner migration dataDir must be a non-empty path.');
  }
  if (!Array.isArray(options.mappings) || options.mappings.length === 0) {
    throw new Error('A2A legacy task owner migration requires at least one explicit mapping.');
  }
  if (typeof options.apply !== 'boolean') {
    throw new Error('A2A legacy task owner migration apply must be a boolean.');
  }
  const legacyToCurrent = new Map<string, string>();
  const currentKeys = new Set<string>();
  options.mappings.forEach((mapping, index) => {
    validateMapping(mapping, index);
    const legacyKey = legacyA2APrincipalKey(mapping);
    const currentKey = realmA2APrincipalKey(mapping);
    const existing = legacyToCurrent.get(legacyKey);
    if (existing !== undefined && existing !== currentKey) {
      throw new Error('A2A legacy task owner mappings are ambiguous across security realms.');
    }
    legacyToCurrent.set(legacyKey, currentKey);
    currentKeys.add(currentKey);
  });

  const dataDir = resolveDataDir(options.dataDir);
  const store = new A2AFileTaskStore(dataDir);
  try {
    const result = store.migrateUnversionedPrincipalKeys({
      legacyToCurrent,
      currentKeys,
      apply: options.apply,
    });
    return { dataDir, applied: options.apply, ...result };
  } finally {
    store.close();
  }
}
