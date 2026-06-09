/**
 * FEATURE_132 — JSON-RPC LSP client (one spawned server, one project root).
 *
 * Push-diagnostics model: after `didOpen`/`didChange`, the server emits
 * `textDocument/publishDiagnostics`; we cache the latest set per file and
 * let callers wait (debounced) for a fresh publish. All five servers KodaX
 * targets (typescript-language-server, pyright, gopls, rust-analyzer, jdtls)
 * push diagnostics, so we deliberately do NOT port opencode's pull-diagnostic
 * machinery (YAGNI — add it only if a future server requires it).
 *
 * Navigation requests (definition/hover/references/symbols) are added in
 * Phase E.
 */

import { type ChildProcessWithoutNullStreams } from 'child_process';
import { readFile } from 'fs/promises';
import { spawnLspProcess } from './spawn.js';
import { pathToFileURL, fileURLToPath } from 'url';
import {
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-languageserver-protocol/node';
import {
  InitializeRequest,
  InitializedNotification,
  DidChangeConfigurationNotification,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  PublishDiagnosticsNotification,
  DefinitionRequest,
  HoverRequest,
  ReferencesRequest,
  DocumentSymbolRequest,
  ShutdownRequest,
  ExitNotification,
  type Diagnostic,
  type InitializeParams,
  type PublishDiagnosticsParams,
  type Position,
  type Location,
  type LocationLink,
  type Hover,
  type DocumentSymbol,
  type SymbolInformation,
} from 'vscode-languageserver-protocol';
import { languageIdForPath } from './language.js';
import { normalizeFsPath } from './paths.js';
import type { LspServerLaunch } from './servers.js';

/** Coalesce a burst of publishes into one settle. */
const DIAGNOSTICS_DEBOUNCE_MS = 150;
/** Navigation requests (definition/hover/…) give up after this long. */
const REQUEST_TIMEOUT_MS = 10_000;
/** Cold monorepo TypeScript servers can take a while to answer `initialize`. */
const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000;

export interface DiagnosticsWaitOptions {
  /** Only a publish with timestamp ≥ this counts as fresh (set before notify). */
  readonly afterMs: number;
  /** Give up waiting after this long and return what we have. */
  readonly timeoutMs: number;
}

export interface LspClient {
  readonly serverId: string;
  readonly root: string;
  /**
   * Send didOpen (first touch) or didChange (subsequent) for a file, and
   * return the timestamp the notification was sent — pass it as
   * `waitForDiagnostics`'s `afterMs` so only a publish triggered by THIS
   * change counts as fresh.
   */
  notifyOpenOrChange(file: string): Promise<number>;
  /** Resolve once a fresh diagnostics publish arrives for the file, or on timeout. */
  waitForDiagnostics(file: string, options: DiagnosticsWaitOptions): Promise<void>;
  /** Latest cached diagnostics for a file (empty when none/unknown). */
  diagnostics(file: string): readonly Diagnostic[];
  /** Resolve the definition site(s) of the symbol at a position. */
  definition(file: string, position: Position): Promise<Location[]>;
  /** Type/signature/doc hover for the symbol at a position (null if none). */
  hover(file: string, position: Position): Promise<Hover | null>;
  /** All references to the symbol at a position (incl. its declaration). */
  references(file: string, position: Position): Promise<Location[]>;
  /** The document's symbol outline. */
  documentSymbols(file: string): Promise<Array<DocumentSymbol | SymbolInformation>>;
  /** Graceful shutdown (await server exit so the OS releases handles). */
  shutdown(): Promise<void>;
  /** Synchronous best-effort kill, for a `process.on('exit')` last resort. */
  killSync(): void;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isLocationLink(value: Location | LocationLink): value is LocationLink {
  return (value as LocationLink).targetUri !== undefined;
}

/** Flatten definition results (Location | Location[] | LocationLink[]) to Location[]. */
function normalizeLocations(
  result: Location | Location[] | LocationLink[] | null | undefined,
): Location[] {
  if (!result) return [];
  const items = Array.isArray(result) ? result : [result];
  return items.map((item) =>
    isLocationLink(item) ? { uri: item.targetUri, range: item.targetSelectionRange } : item,
  );
}

/** Dot-path lookup into the server's initializationOptions for `workspace/configuration`. */
function configurationValue(init: Record<string, unknown> | undefined, section?: string): unknown {
  if (!init) return {};
  if (!section) return init;
  let current: unknown = init;
  for (const part of section.split('.')) {
    if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }
  return current;
}

function buildInitializeParams(root: string, init: Record<string, unknown> | undefined): InitializeParams {
  const uri = pathToFileURL(root).href;
  return {
    processId: process.pid,
    rootUri: uri,
    workspaceFolders: [{ name: 'workspace', uri }],
    capabilities: {
      workspace: {
        configuration: true,
        workspaceFolders: true,
        didChangeConfiguration: { dynamicRegistration: true },
        didChangeWatchedFiles: { dynamicRegistration: true },
      },
      textDocument: {
        synchronization: { dynamicRegistration: true, didSave: true },
        publishDiagnostics: { relatedInformation: true },
        definition: { dynamicRegistration: true, linkSupport: true },
        hover: { dynamicRegistration: true, contentFormat: ['markdown', 'plaintext'] },
        references: { dynamicRegistration: true },
        documentSymbol: { dynamicRegistration: true, hierarchicalDocumentSymbolSupport: true },
      },
      window: { workDoneProgress: true },
    },
    initializationOptions: init,
  };
}

export interface CreateLspClientParams {
  readonly serverId: string;
  readonly root: string;
  readonly launch: LspServerLaunch;
  readonly initializeTimeoutMs?: number;
  readonly debug?: (message: string) => void;
}

/**
 * Spawn a server, run the LSP initialize handshake, and return a client.
 * Rejects (fast) if the process errors / exits early, or if initialize
 * exceeds the timeout — the caller (service) marks the root+server broken.
 */
export async function createLspClient(params: CreateLspClientParams): Promise<LspClient> {
  const { serverId, root, launch, debug } = params;
  const initTimeout = params.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;

  const proc = spawnLspProcess(launch.command, launch.args, {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  }) as ChildProcessWithoutNullStreams;

  proc.stderr.on('data', (chunk: Buffer) => debug?.(`[${serverId}] stderr: ${chunk.toString().trim()}`));

  const connection = createProtocolConnection(
    new StreamMessageReader(proc.stdout),
    new StreamMessageWriter(proc.stdin),
  );

  const pushDiagnostics = new Map<string, Diagnostic[]>();
  const pushListeners = new Set<(file: string, at: number) => void>();

  connection.onNotification(PublishDiagnosticsNotification.type, (published: PublishDiagnosticsParams) => {
    let file: string;
    try {
      file = normalizeFsPath(fileURLToPath(published.uri));
    } catch {
      return;
    }
    pushDiagnostics.set(file, published.diagnostics ?? []);
    const at = Date.now();
    for (const listener of pushListeners) listener(file, at);
  });

  // Answer server→client requests so the handshake doesn't stall.
  connection.onRequest('workspace/configuration', (p: { items?: { section?: string }[] }) =>
    (p.items ?? []).map((item) => configurationValue(launch.initializationOptions, item.section)),
  );
  connection.onRequest('workspace/workspaceFolders', () => [
    { name: 'workspace', uri: pathToFileURL(root).href },
  ]);
  connection.onRequest('window/workDoneProgress/create', () => null);
  connection.onRequest('client/registerCapability', () => null);
  connection.onRequest('client/unregisterCapability', () => null);

  connection.listen();

  // Race initialize against early process death so a missing/broken server
  // fails in milliseconds instead of hanging until the init timeout. `once`
  // (not `on`) so the handlers self-remove and never accumulate across the
  // many startups a session triggers.
  const earlyExit = new Promise<never>((_, reject) => {
    proc.once('error', (error) => reject(new Error(`spawn failed: ${error.message}`)));
    proc.once('exit', (code) => reject(new Error(`server exited early (code ${code ?? 'null'})`)));
  });

  try {
    await Promise.race([
      withTimeout(
        connection.sendRequest(InitializeRequest.type, buildInitializeParams(root, launch.initializationOptions)),
        initTimeout,
        `LSP initialize timed out for ${serverId}`,
      ),
      earlyExit,
    ]);
  } finally {
    // Swallow the late rejection from earlyExit on normal lifetime (e.g.
    // shutdown's proc.kill) so it never surfaces as an unhandledRejection.
    earlyExit.catch(() => undefined);
  }

  connection.sendNotification(InitializedNotification.type, {});
  connection.sendNotification(DidChangeConfigurationNotification.type, {
    settings: launch.initializationOptions ?? {},
  });

  const openVersions = new Map<string, number>();
  // Resolve callbacks of in-flight waitForDiagnostics calls, so shutdown can
  // release them immediately instead of leaving timers + mutation-queue locks
  // hanging for up to `timeoutMs`.
  const activeWaiters = new Set<() => void>();

  async function notifyOpenOrChange(file: string): Promise<number> {
    const key = normalizeFsPath(file);
    const text = await readFile(file, 'utf8');
    const languageId = languageIdForPath(file) ?? 'plaintext';
    const uri = pathToFileURL(file).href;
    const previous = openVersions.get(key);
    if (previous === undefined) {
      openVersions.set(key, 1);
      pushDiagnostics.delete(key);
      const sentAt = Date.now();
      connection.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri, languageId, version: 1, text },
      });
      return sentAt;
    }
    const version = previous + 1;
    openVersions.set(key, version);
    const sentAt = Date.now();
    connection.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
    return sentAt;
  }

  function waitForDiagnostics(file: string, options: DiagnosticsWaitOptions): Promise<void> {
    const key = normalizeFsPath(file);
    return new Promise<void>((resolve) => {
      let settled = false;
      let debounce: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimeout);
        if (debounce) clearTimeout(debounce);
        pushListeners.delete(listener);
        activeWaiters.delete(finish);
        resolve();
      };
      const listener = (publishedFile: string, at: number): void => {
        if (publishedFile !== key || at < options.afterMs) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(finish, DIAGNOSTICS_DEBOUNCE_MS);
      };
      pushListeners.add(listener);
      activeWaiters.add(finish);
      const hardTimeout = setTimeout(finish, options.timeoutMs);
    });
  }

  function diagnostics(file: string): readonly Diagnostic[] {
    return pushDiagnostics.get(normalizeFsPath(file)) ?? [];
  }

  function navTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    return withTimeout(promise, REQUEST_TIMEOUT_MS, `${serverId} ${label} timed out`);
  }

  async function definition(file: string, position: Position): Promise<Location[]> {
    const textDocument = { uri: pathToFileURL(file).href };
    const result = await navTimeout(
      connection.sendRequest(DefinitionRequest.type, { textDocument, position }),
      'definition',
    );
    return normalizeLocations(result);
  }

  async function hover(file: string, position: Position): Promise<Hover | null> {
    const textDocument = { uri: pathToFileURL(file).href };
    return navTimeout(connection.sendRequest(HoverRequest.type, { textDocument, position }), 'hover');
  }

  async function references(file: string, position: Position): Promise<Location[]> {
    const textDocument = { uri: pathToFileURL(file).href };
    const result = await navTimeout(
      connection.sendRequest(ReferencesRequest.type, {
        textDocument,
        position,
        context: { includeDeclaration: true },
      }),
      'references',
    );
    return result ?? [];
  }

  async function documentSymbols(file: string): Promise<Array<DocumentSymbol | SymbolInformation>> {
    const textDocument = { uri: pathToFileURL(file).href };
    const result = await navTimeout(
      connection.sendRequest(DocumentSymbolRequest.type, { textDocument }),
      'documentSymbol',
    );
    return result ?? [];
  }

  function killSync(): void {
    try {
      proc.kill();
    } catch {
      // ignore
    }
  }

  async function shutdown(): Promise<void> {
    // Release any in-flight diagnostics waits first so their callers (holding
    // a write's mutation lock) unblock now rather than at timeout.
    for (const release of [...activeWaiters]) release();
    try {
      await withTimeout(connection.sendRequest(ShutdownRequest.type), 2_000, 'shutdown timeout');
      connection.sendNotification(ExitNotification.type);
    } catch {
      // Best-effort; fall through to dispose + kill.
    }
    try {
      connection.dispose();
    } catch {
      // ignore
    }
    // Await actual process exit so the OS releases its handles (on Windows the
    // server's cwd stays locked until the process is reaped — otherwise a
    // caller deleting that directory hits EBUSY).
    await new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        resolve();
        return;
      }
      const killTimer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // ignore
        }
      }, 1_500);
      proc.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
    });
  }

  return {
    serverId,
    root,
    notifyOpenOrChange,
    waitForDiagnostics,
    diagnostics,
    definition,
    hover,
    references,
    documentSymbols,
    shutdown,
    killSync,
  };
}
