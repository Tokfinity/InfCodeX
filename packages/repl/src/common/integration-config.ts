import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import type { McpServerConfig, McpServersConfig } from '@kodax-ai/agent';

export type IntegrationDomain = 'mcp' | 'a2a' | 'extensions';
export type IntegrationConfigSource = 'user' | 'legacy-user' | 'default';

export interface McpIntegrationDocument {
  readonly version: 1;
  readonly servers: McpServersConfig;
}

export interface ExtensionsIntegrationDocument {
  readonly version: 1;
  readonly paths: readonly string[];
}

export interface IntegrationConfigSnapshot<T extends object> {
  readonly domain: IntegrationDomain;
  readonly source: IntegrationConfigSource;
  readonly path: string;
  readonly revision: string;
  readonly document: T;
  readonly loadedAt: string;
}

export interface IntegrationConfigDiagnostic {
  readonly code: 'invalid-config' | 'activation-failed' | 'watcher-degraded';
  readonly message: string;
  readonly time: string;
}

export interface IntegrationConfigStatus {
  readonly domain: IntegrationDomain;
  readonly path: string;
  readonly revision?: string;
  readonly source?: IntegrationConfigSource;
  readonly lastReloadAt?: string;
  readonly diagnostic?: IntegrationConfigDiagnostic;
  readonly watching: boolean;
}

export interface LegacyIntegrationMigrationDomainPlan {
  readonly action: 'create' | 'none';
  readonly entries: number;
  readonly destination: string;
  readonly reason?: string;
}

export interface LegacyIntegrationMigrationPlan {
  readonly mcp: LegacyIntegrationMigrationDomainPlan;
  readonly extensions: LegacyIntegrationMigrationDomainPlan;
  readonly warnings: readonly string[];
}

export interface LegacyIntegrationMigrationResult extends LegacyIntegrationMigrationPlan {
  readonly applied: readonly ('mcp' | 'extensions')[];
  readonly cleanedLegacy: boolean;
}

export type IntegrationDocumentValidator<T extends object> = (value: unknown) => T;
export type IntegrationConfigListener<T extends object> = (
  snapshot: IntegrationConfigSnapshot<T>,
  previous: IntegrationConfigSnapshot<T> | undefined,
) => Promise<void> | void;

type IntegrationReloadResult<T extends object> =
  | { readonly ok: true; readonly snapshot: IntegrationConfigSnapshot<T> }
  | { readonly ok: false; readonly error: string };

const DOMAIN_FILENAMES: Readonly<Record<IntegrationDomain, string>> = {
  mcp: 'mcp.json',
  a2a: 'a2a.json',
  extensions: 'extensions.json',
};

const MCP_SERVER_KEYS = new Set([
  'type',
  'command',
  'args',
  'cwd',
  'env',
  'url',
  'headers',
  'connect',
  'startupTimeoutMs',
  'requestTimeoutMs',
  'auth',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function assertNoUnknownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new Error(`${label} has unknown field "${unknown}".`);
}

function requireVersionOne(value: Readonly<Record<string, unknown>>, label: string): void {
  if (value.version !== 1) throw new Error(`${label} version must be 1.`);
}

function requireStringMap(value: unknown, label: string): Record<string, string> {
  const record = requireRecord(value, label);
  for (const [key, item] of Object.entries(record)) {
    if (key.trim().length === 0 || typeof item !== 'string') {
      throw new Error(`${label} must contain non-empty string keys and string values.`);
    }
  }
  return structuredClone(record as Record<string, string>);
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => (
    typeof item === 'string' && item.trim().length > 0
  ))) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  return value.map((item) => item.trim());
}

function validatePositiveNumber(value: unknown, label: string): void {
  if (value !== undefined && (!Number.isFinite(value) || Number(value) <= 0)) {
    throw new Error(`${label} must be a positive number.`);
  }
}

function parseMcpServer(name: string, value: unknown): McpServerConfig {
  if (name.trim().length === 0) throw new Error('MCP server names must not be empty.');
  const record = requireRecord(value, `MCP server "${name}"`);
  assertNoUnknownKeys(record, MCP_SERVER_KEYS, `MCP server "${name}"`);
  const type = record.type ?? 'stdio';
  if (!['stdio', 'sse', 'streamable-http', 'http'].includes(String(type))) {
    throw new Error(`MCP server "${name}" has an unsupported transport type.`);
  }
  if (type === 'stdio') {
    if (typeof record.command !== 'string' || record.command.trim().length === 0) {
      throw new Error(`MCP server "${name}" stdio transport requires command.`);
    }
  } else if (typeof record.url !== 'string' || record.url.trim().length === 0) {
    throw new Error(`MCP server "${name}" ${String(type)} transport requires url.`);
  }
  if (record.args !== undefined) requireStringArray(record.args, `MCP server "${name}" args`);
  if (record.cwd !== undefined && typeof record.cwd !== 'string') {
    throw new Error(`MCP server "${name}" cwd must be a string.`);
  }
  if (record.env !== undefined) requireStringMap(record.env, `MCP server "${name}" env`);
  if (record.headers !== undefined) requireStringMap(record.headers, `MCP server "${name}" headers`);
  if (record.connect !== undefined && !['lazy', 'prewarm', 'disabled'].includes(String(record.connect))) {
    throw new Error(`MCP server "${name}" has an unsupported connect mode.`);
  }
  validatePositiveNumber(record.startupTimeoutMs, `MCP server "${name}" startupTimeoutMs`);
  validatePositiveNumber(record.requestTimeoutMs, `MCP server "${name}" requestTimeoutMs`);
  if (record.auth !== undefined) {
    const auth = requireRecord(record.auth, `MCP server "${name}" auth`);
    const authKeys = new Set(['type', 'clientId', 'authorizationUrl', 'tokenUrl', 'scopes', 'redirectPort']);
    assertNoUnknownKeys(auth, authKeys, `MCP server "${name}" auth`);
    if (auth.type !== 'oauth2') throw new Error(`MCP server "${name}" auth type must be oauth2.`);
    for (const key of ['clientId', 'authorizationUrl', 'tokenUrl'] as const) {
      if (auth[key] !== undefined && typeof auth[key] !== 'string') {
        throw new Error(`MCP server "${name}" auth.${key} must be a string.`);
      }
    }
    if (auth.scopes !== undefined) requireStringArray(auth.scopes, `MCP server "${name}" auth.scopes`);
    validatePositiveNumber(auth.redirectPort, `MCP server "${name}" auth.redirectPort`);
  }
  return structuredClone(record as McpServerConfig);
}

export function parseMcpIntegrationDocument(value: unknown): McpIntegrationDocument {
  const record = requireRecord(value, 'MCP integration config');
  assertNoUnknownKeys(record, new Set(['version', 'servers']), 'MCP integration config');
  requireVersionOne(record, 'MCP integration config');
  const rawServers = requireRecord(record.servers, 'MCP integration config servers');
  const servers: McpServersConfig = {};
  for (const [name, server] of Object.entries(rawServers)) {
    servers[name] = parseMcpServer(name, server);
  }
  return { version: 1, servers };
}

export function parseExtensionsIntegrationDocument(value: unknown): ExtensionsIntegrationDocument {
  const record = requireRecord(value, 'Extensions integration config');
  assertNoUnknownKeys(record, new Set(['version', 'paths']), 'Extensions integration config');
  requireVersionOne(record, 'Extensions integration config');
  const paths = requireStringArray(record.paths, 'Extensions integration config paths');
  if (new Set(paths).size !== paths.length) {
    throw new Error('Extensions integration config paths must not contain duplicates.');
  }
  return { version: 1, paths };
}

export function resolveIntegrationConfigPath(
  domain: IntegrationDomain,
  configHome: string,
): string {
  return path.join(path.resolve(configHome), 'integrations', DOMAIN_FILENAMES[domain]);
}

function coreConfigPath(configHome: string): string {
  return path.join(path.resolve(configHome), 'config.json');
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function readJsonFile(file: string): { readonly raw: string; readonly value: unknown } {
  const raw = readFileSync(file, 'utf8');
  try {
    return { raw, value: JSON.parse(raw) as unknown };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON: ${reason}`);
  }
}

function snapshot<T extends object>(input: {
  readonly domain: IntegrationDomain;
  readonly source: IntegrationConfigSource;
  readonly path: string;
  readonly raw: string;
  readonly document: T;
}): IntegrationConfigSnapshot<T> {
  return {
    domain: input.domain,
    source: input.source,
    path: input.path,
    revision: hashText(input.raw),
    document: structuredClone(input.document),
    loadedAt: new Date().toISOString(),
  };
}

function readCoreConfig(configHome: string): Record<string, unknown> {
  const file = coreConfigPath(configHome);
  if (!existsSync(file)) return {};
  return requireRecord(readJsonFile(file).value, 'Core config');
}

export function readMcpIntegration(
  configHome: string,
): IntegrationConfigSnapshot<McpIntegrationDocument> {
  const file = resolveIntegrationConfigPath('mcp', configHome);
  if (existsSync(file)) {
    const parsed = readJsonFile(file);
    return snapshot({
      domain: 'mcp',
      source: 'user',
      path: file,
      raw: parsed.raw,
      document: parseMcpIntegrationDocument(parsed.value),
    });
  }
  const legacy = readCoreConfig(configHome).mcpServers;
  const document = parseMcpIntegrationDocument({
    version: 1,
    servers: isRecord(legacy) ? legacy : {},
  });
  return snapshot({
    domain: 'mcp',
    source: legacy === undefined ? 'default' : 'legacy-user',
    path: file,
    raw: JSON.stringify(document),
    document,
  });
}

export function readExtensionsIntegration(
  configHome: string,
): IntegrationConfigSnapshot<ExtensionsIntegrationDocument> {
  const file = resolveIntegrationConfigPath('extensions', configHome);
  if (existsSync(file)) {
    const parsed = readJsonFile(file);
    return snapshot({
      domain: 'extensions',
      source: 'user',
      path: file,
      raw: parsed.raw,
      document: parseExtensionsIntegrationDocument(parsed.value),
    });
  }
  const legacy = readCoreConfig(configHome).extensions;
  const document = parseExtensionsIntegrationDocument({
    version: 1,
    paths: Array.isArray(legacy) ? legacy : [],
  });
  return snapshot({
    domain: 'extensions',
    source: legacy === undefined ? 'default' : 'legacy-user',
    path: file,
    raw: JSON.stringify(document),
    document,
  });
}

function likelySecretWarnings(servers: unknown): readonly string[] {
  if (!isRecord(servers)) return [];
  const warnings: string[] = [];
  const secretName = /(token|secret|password|api[_-]?key|authorization)/i;
  for (const [serverName, rawServer] of Object.entries(servers)) {
    if (!isRecord(rawServer)) continue;
    for (const field of ['env', 'headers'] as const) {
      const values = rawServer[field];
      if (!isRecord(values)) continue;
      for (const [name, value] of Object.entries(values)) {
        if (secretName.test(name) && typeof value === 'string' && !value.startsWith('${env:')) {
          warnings.push(`MCP server "${serverName}" ${field}.${name} may contain a literal secret.`);
        }
      }
    }
  }
  return warnings;
}

export function planLegacyIntegrationMigration(
  configHome: string,
): LegacyIntegrationMigrationPlan {
  const core = readCoreConfig(configHome);
  const mcpDestination = resolveIntegrationConfigPath('mcp', configHome);
  const extensionDestination = resolveIntegrationConfigPath('extensions', configHome);
  const legacyServers = core.mcpServers;
  const legacyExtensions = core.extensions;
  const mcpEntries = isRecord(legacyServers) ? Object.keys(legacyServers).length : 0;
  const extensionEntries = Array.isArray(legacyExtensions) ? legacyExtensions.length : 0;
  const domainPlan = (
    destination: string,
    entries: number,
    present: boolean,
  ): LegacyIntegrationMigrationDomainPlan => existsSync(destination)
    ? { action: 'none', entries, destination, reason: 'destination-exists' }
    : present
      ? { action: 'create', entries, destination }
      : { action: 'none', entries: 0, destination, reason: 'legacy-absent' };
  return {
    mcp: domainPlan(mcpDestination, mcpEntries, legacyServers !== undefined),
    extensions: domainPlan(extensionDestination, extensionEntries, legacyExtensions !== undefined),
    warnings: likelySecretWarnings(legacyServers),
  };
}

function writeCoreConfigAtomically(configHome: string, config: Record<string, unknown>): void {
  const file = coreConfigPath(configHome);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, file);
  } catch (error: unknown) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw new Error('Failed to atomically clean legacy integration fields.', { cause: error });
  }
}

export function migrateLegacyIntegrationConfig(input: {
  readonly configHome: string;
  readonly cleanupLegacy?: boolean;
}): LegacyIntegrationMigrationResult {
  const plan = planLegacyIntegrationMigration(input.configHome);
  const core = readCoreConfig(input.configHome);
  const applied: ('mcp' | 'extensions')[] = [];
  if (plan.mcp.action === 'create') {
    writeIntegrationDocument({
      domain: 'mcp',
      configHome: input.configHome,
      document: { version: 1, servers: isRecord(core.mcpServers) ? core.mcpServers : {} },
      validate: parseMcpIntegrationDocument,
    });
    applied.push('mcp');
  }
  if (plan.extensions.action === 'create') {
    writeIntegrationDocument({
      domain: 'extensions',
      configHome: input.configHome,
      document: { version: 1, paths: Array.isArray(core.extensions) ? core.extensions : [] },
      validate: parseExtensionsIntegrationDocument,
    });
    applied.push('extensions');
  }
  let cleanedLegacy = false;
  if (input.cleanupLegacy && existsSync(coreConfigPath(input.configHome))) {
    const next = { ...core };
    if (existsSync(plan.mcp.destination)) delete next.mcpServers;
    if (existsSync(plan.extensions.destination)) delete next.extensions;
    if (!isDeepStrictEqualForConfig(core, next)) {
      writeCoreConfigAtomically(input.configHome, next);
      cleanedLegacy = true;
    }
  }
  return { ...plan, applied, cleanedLegacy };
}

function isDeepStrictEqualForConfig(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function currentUserRevision(file: string): string | undefined {
  return existsSync(file) ? hashText(readFileSync(file, 'utf8')) : undefined;
}

function acquireWriteLock(file: string): { readonly fd: number; readonly path: string } {
  const lockPath = `${file}.lock`;
  try {
    return { fd: openSync(lockPath, 'wx', 0o600), path: lockPath };
  } catch (error: unknown) {
    throw new Error(`Integration configuration is busy: ${path.basename(file)}`, { cause: error });
  }
}

export function writeIntegrationDocument<T extends object>(input: {
  readonly domain: IntegrationDomain;
  readonly configHome: string;
  readonly document: T;
  readonly validate: IntegrationDocumentValidator<T>;
  readonly expectedRevision?: string;
}): IntegrationConfigSnapshot<T> {
  const file = resolveIntegrationConfigPath(input.domain, input.configHome);
  const document = input.validate(input.document);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = acquireWriteLock(file);
  try {
    const actualRevision = currentUserRevision(file);
    if (input.expectedRevision !== undefined && actualRevision !== input.expectedRevision) {
      throw new Error(
        `Integration configuration revision changed (expected ${input.expectedRevision}, actual ${actualRevision ?? 'missing'}).`,
      );
    }
    const raw = `${JSON.stringify(document, null, 2)}\n`;
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    const temporaryFd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(temporaryFd, raw, 'utf8');
      fsyncSync(temporaryFd);
    } finally {
      closeSync(temporaryFd);
    }
    try {
      renameSync(temporary, file);
    } catch (error: unknown) {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw new Error(`Failed to atomically replace ${path.basename(file)}.`, { cause: error });
    }
    return snapshot({
      domain: input.domain,
      source: 'user',
      path: file,
      raw,
      document,
    });
  } finally {
    closeSync(lock.fd);
    if (existsSync(lock.path)) unlinkSync(lock.path);
  }
}

function metadataSignature(file: string): string {
  if (!existsSync(file)) return 'missing';
  const stats = statSync(file);
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
}

function safeDiagnostic(
  code: IntegrationConfigDiagnostic['code'],
  message: string,
): IntegrationConfigDiagnostic {
  return {
    code,
    message,
    time: new Date().toISOString(),
  };
}

export class IntegrationConfigController<T extends object> {
  readonly #domain: IntegrationDomain;
  readonly #path: string;
  readonly #read: () => IntegrationConfigSnapshot<T>;
  readonly #validate: IntegrationDocumentValidator<T>;
  #active: IntegrationConfigSnapshot<T> | undefined;
  #diagnostic: IntegrationConfigDiagnostic | undefined;
  #observedMetadata = '';
  #watcher: FSWatcher | undefined;
  #watchTimer: ReturnType<typeof setTimeout> | undefined;
  #fallbackTimer: ReturnType<typeof setInterval> | undefined;
  #reloadTail: Promise<void> = Promise.resolve();
  readonly #listeners = new Set<IntegrationConfigListener<T>>();

  constructor(options: {
    readonly domain: IntegrationDomain;
    readonly configHome: string;
    readonly validate: IntegrationDocumentValidator<T>;
    readonly read: () => IntegrationConfigSnapshot<T>;
  }) {
    this.#domain = options.domain;
    this.#path = resolveIntegrationConfigPath(options.domain, options.configHome);
    this.#validate = options.validate;
    this.#read = options.read;
  }

  async initialize(): Promise<IntegrationConfigSnapshot<T>> {
    const result = await this.reload();
    if (!result.ok || !this.#active) {
      throw new Error(result.ok ? 'Integration configuration did not produce a snapshot.' : result.error);
    }
    return structuredClone(this.#active);
  }

  snapshot(): IntegrationConfigSnapshot<T> | undefined {
    return this.#active ? structuredClone(this.#active) : undefined;
  }

  status(): IntegrationConfigStatus {
    return {
      domain: this.#domain,
      path: this.#path,
      ...(this.#active
        ? {
            revision: this.#active.revision,
            source: this.#active.source,
            lastReloadAt: this.#active.loadedAt,
          }
        : {}),
      ...(this.#diagnostic ? { diagnostic: this.#diagnostic } : {}),
      watching: this.#watcher !== undefined,
    };
  }

  subscribe(listener: IntegrationConfigListener<T>): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  reload(): Promise<IntegrationReloadResult<T>> {
    const pending = this.#reloadTail.then(() => this.#reloadNow());
    this.#reloadTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async #reloadNow(): Promise<IntegrationReloadResult<T>> {
    this.#observedMetadata = metadataSignature(this.#path);
    let candidate: IntegrationConfigSnapshot<T>;
    try {
      candidate = this.#read();
      this.#validate(candidate.document);
    } catch {
      this.#diagnostic = safeDiagnostic(
        'invalid-config',
        'Integration configuration is invalid; check the file against its versioned schema.',
      );
      return { ok: false, error: this.#diagnostic.message };
    }
    const previous = this.#active ? structuredClone(this.#active) : undefined;
    try {
      for (const listener of this.#listeners) await listener(structuredClone(candidate), previous);
    } catch {
      this.#diagnostic = safeDiagnostic(
        'activation-failed',
        'Integration configuration could not be activated; the previous configuration remains active.',
      );
      return { ok: false, error: this.#diagnostic.message };
    }
    this.#active = candidate;
    this.#diagnostic = undefined;
    return { ok: true, snapshot: structuredClone(candidate) };
  }

  async ensureCurrent(): Promise<IntegrationReloadResult<T>> {
    if (metadataSignature(this.#path) === this.#observedMetadata && this.#active) {
      return { ok: true, snapshot: structuredClone(this.#active) };
    }
    return this.reload();
  }

  startWatching(debounceMs = 100, fallbackMs = 2_000): void {
    if (this.#watcher || this.#fallbackTimer) return;
    mkdirSync(path.dirname(this.#path), { recursive: true, mode: 0o700 });
    try {
      this.#watcher = watch(path.dirname(this.#path), (_event, filename) => {
        if (filename !== null && filename.toString() !== path.basename(this.#path)) return;
        if (this.#watchTimer) clearTimeout(this.#watchTimer);
        this.#watchTimer = setTimeout(() => {
          this.#watchTimer = undefined;
          void this.reload();
        }, debounceMs);
        this.#watchTimer.unref?.();
      });
      // A configuration watcher follows its host lifecycle; it must not keep a
      // CLI or daemon process alive after the owning runtime has stopped.
      this.#watcher.unref();
      this.#watcher.on('error', () => {
        this.#diagnostic = safeDiagnostic(
          'watcher-degraded',
          'Integration watcher is degraded; metadata polling remains active.',
        );
      });
    } catch {
      this.#diagnostic = safeDiagnostic(
        'watcher-degraded',
        'Integration watcher is degraded; metadata polling remains active.',
      );
    }
    this.#fallbackTimer = setInterval(() => { void this.ensureCurrent(); }, fallbackMs);
    this.#fallbackTimer.unref?.();
  }

  close(): void {
    if (this.#watchTimer) clearTimeout(this.#watchTimer);
    this.#watchTimer = undefined;
    if (this.#fallbackTimer) clearInterval(this.#fallbackTimer);
    this.#fallbackTimer = undefined;
    this.#watcher?.close();
    this.#watcher = undefined;
    this.#listeners.clear();
  }
}
