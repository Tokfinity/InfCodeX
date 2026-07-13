import path from 'node:path';

import {
  createAgentExecutorPlane,
  type AgentCredentialBroker,
  type AgentTaskSnapshot,
  type ExternalAgentRegistration,
  type McpServerConfig,
} from '@kodax-ai/agent';
import {
  createExtensionRuntime,
  loadMarkdownAgentScope,
  registerConfiguredMcpCapabilityProvider,
  resolveExtensionEntrypoint,
} from '@kodax-ai/coding';
import {
  IntegrationConfigController,
  KODAX_DIR,
  KODAX_EXAMPLE_CONFIG_FILE,
  KODAX_INTEGRATION_EXAMPLE_FILES,
  getConfigTemplate,
  migrateLegacyIntegrationConfig,
  parseExtensionsIntegrationDocument,
  planLegacyIntegrationMigration,
  readExtensionsIntegration,
  readMcpIntegration,
  removeMcpServer,
  upsertMcpServer,
  writeIntegrationDocument,
} from '@kodax-ai/repl';
import type { Command } from 'commander';

import {
  classifyA2AServerChange,
  createConfiguredA2ARuntimeIntegration,
  createA2AServerHotOptions,
  createA2AServerOptionsFromConfig,
  createA2AAgentExecutorFactory,
  discoverA2ARegistration,
  parseA2AIntegrationDocument,
  prepareKodaXA2AServer,
  readA2AIntegration,
  removeA2AOutboundAgent,
  setA2AServerConfig,
  upsertA2AOutboundAgent,
  type A2AAgentCard,
  type A2AIntegrationDocument,
  type A2ANetworkPolicy,
  type A2AOutboundEffect,
  type A2AServerConfig,
} from './a2a/index.js';
import { createKodaXRuntime } from './sdk-runtime.js';
import { doctorSandboxRuntime, setupSandboxRuntime } from './sandbox-runtime.js';

type Output = (value: string) => void;

function stdout(value: string): void {
  process.stdout.write(`${value}\n`);
}

function stderr(value: string): void {
  process.stderr.write(`${value}\n`);
}

function json(value: unknown, output: Output = stdout): void {
  output(JSON.stringify(value, null, 2));
}

function repeat(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseEffect(value: string): A2AOutboundEffect {
  if (!['none', 'read', 'write', 'unknown'].includes(value)) throw new Error('A2A effect must be none, read, write, or unknown.');
  return value as A2AOutboundEffect;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('A2A port must be 1-65535.');
  return port;
}

function privateAllowed(url: URL, explicit: boolean): boolean {
  return explicit || ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
}

function assertLoopbackHostname(hostname: string): void {
  if (!['localhost', '127.0.0.1', '::1'].includes(hostname.toLowerCase())) {
    throw new Error('The built-in A2A listener is loopback-only; use a reverse proxy for remote access.');
  }
}

function networkPolicy(origins: readonly string[], allowPrivateAddresses: boolean): A2ANetworkPolicy {
  return {
    allowedOrigins: [...new Set(origins)],
    allowPrivateAddresses,
    requestTimeoutMs: 15_000,
    maxResponseBytes: 2_097_152,
    maxRedirects: 3,
  };
}

async function discoverConfiguredAgent(
  name: string,
  allowPrivate: boolean,
): Promise<{
  readonly config: A2AIntegrationDocument['agents'][string];
  readonly card: A2AAgentCard;
  readonly registration: ExternalAgentRegistration;
}> {
  const config = readA2AIntegration(KODAX_DIR).document.agents[name];
  if (!config) throw new Error(`Unknown configured A2A Agent: ${name}.`);
  const cardUrl = new URL(config.cardUrl);
  const discovered = await discoverA2ARegistration({
    agentId: `external:${name}`,
    agentCardUrl: config.cardUrl,
    effects: { remote: config.effect },
    ...(config.credentialEnv ? { credentialRef: `env:${config.credentialEnv}` } : {}),
  }, {
    networkPolicy: networkPolicy([cardUrl.origin], privateAllowed(cardUrl, allowPrivate)),
    pollIntervalMs: 500,
  });
  return { config, card: discovered.agentCard, registration: discovered.registration };
}

function environmentCredentialBroker(): AgentCredentialBroker {
  const environmentName = (reference: string): string => {
    if (!reference.startsWith('env:') || reference.length === 4) {
      throw new Error('Configured A2A credentials must use an environment reference.');
    }
    return reference.slice(4);
  };
  return {
    isAvailable(reference) {
      const value = process.env[environmentName(reference)];
      return typeof value === 'string' && value.length > 0;
    },
    async withCredential(reference, use) {
      const value = process.env[environmentName(reference)];
      if (!value) throw new Error('Configured A2A credential is unavailable.');
      return use(value);
    },
  };
}

function registrationInterfaceUrl(registration: ExternalAgentRegistration): URL {
  const value = registration.executorConfig?.interfaceUrl;
  if (typeof value !== 'string') throw new Error('Configured A2A registration has no interface URL.');
  return new URL(value);
}

async function waitForA2ATask(
  getTask: () => Promise<AgentTaskSnapshot>,
): Promise<AgentTaskSnapshot> {
  let task = await getTask();
  while (task.state === 'submitted' || task.state === 'working') {
    await new Promise((resolve) => setTimeout(resolve, 50));
    task = await getTask();
  }
  return task;
}

async function callConfiguredAgent(name: string, prompt: string, allowPrivate: boolean): Promise<AgentTaskSnapshot> {
  const { config, registration } = await discoverConfiguredAgent(name, allowPrivate);
  const cardUrl = new URL(config.cardUrl);
  const plane = await createAgentExecutorPlane({
    factories: [createA2AAgentExecutorFactory((active) => {
      const endpointUrl = registrationInterfaceUrl(active);
      return {
        networkPolicy: networkPolicy(
          [cardUrl.origin, endpointUrl.origin],
          privateAllowed(endpointUrl, allowPrivate),
        ),
        pollIntervalMs: 500,
      };
    })],
    policy: () => ({ allowed: true }),
    credentialBroker: environmentCredentialBroker(),
  });
  try {
    await plane.registrations.upsert(registration);
    const started = await plane.tasks.start({
      agentId: registration.agentId,
      objective: prompt,
      input: prompt,
      context: { actorId: 'kodax-cli' },
      readOnly: config.effect === 'none' || config.effect === 'read',
    });
    return await waitForA2ATask(() => plane.tasks.get(started.taskId));
  } finally {
    await plane.close();
  }
}

function configureConfigCommands(program: Command): void {
  const config = program.command('config').description('Inspect canonical KodaX configuration templates');
  config.command('template [domain]')
    .description('Print the canonical core, mcp, a2a, or extensions template')
    .action((domain = 'core') => {
      if (!['core', 'mcp', 'a2a', 'extensions'].includes(domain)) throw new Error('Unknown template domain.');
      stdout(getConfigTemplate(domain as 'core' | 'mcp' | 'a2a' | 'extensions').trimEnd());
    });
  config.command('paths').description('Print active and example configuration paths').action(() => json({
    home: KODAX_DIR,
    coreExample: KODAX_EXAMPLE_CONFIG_FILE,
    integrationExamples: KODAX_INTEGRATION_EXAMPLE_FILES,
  }));
}

function integrationStatus(): unknown {
  const domains = [
    readMcpIntegration(KODAX_DIR),
    readA2AIntegration(KODAX_DIR),
    readExtensionsIntegration(KODAX_DIR),
  ];
  return domains.map((snapshot) => ({
    domain: snapshot.domain, path: snapshot.path, source: snapshot.source,
    revision: snapshot.revision, loadedAt: snapshot.loadedAt,
  }));
}

function configureIntegrationManagement(program: Command): void {
  const integrations = program.command('integrations').description('Validate, migrate, and inspect split integration config');
  integrations.command('status').action(() => json(integrationStatus()));
  integrations.command('validate').action(() => json({ ok: true, domains: integrationStatus() }));
  integrations.command('reload').description('Validate current disk snapshots; running hosts watch independently').action(() => json({ ok: true, domains: integrationStatus() }));
  integrations.command('migrate')
    .option('--apply', 'Create missing split files')
    .option('--cleanup-legacy', 'Remove migrated legacy fields from config.json')
    .action((options: { apply?: boolean; cleanupLegacy?: boolean }) => {
      if (options.cleanupLegacy && !options.apply) {
        throw new Error('--cleanup-legacy requires --apply.');
      }
      const result = options.apply
        ? migrateLegacyIntegrationConfig({ configHome: KODAX_DIR, cleanupLegacy: options.cleanupLegacy === true })
        : planLegacyIntegrationMigration(KODAX_DIR);
      json(result);
    });
}

function configureMcpCommands(program: Command): void {
  const mcp = program.command('mcp').description('Manage MCP servers in integrations/mcp.json');
  mcp.command('list').action(() => json(readMcpIntegration(KODAX_DIR).document.servers));
  mcp.command('add <name>')
    .option('--command <command>', 'stdio command')
    .option('--arg <value>', 'stdio argument (repeatable)', repeat, [])
    .option('--cwd <dir>', 'stdio working directory')
    .option('--url <url>', 'HTTP/SSE endpoint')
    .option('--transport <type>', 'stdio, sse, http, or streamable-http')
    .option('--connect <mode>', 'lazy, prewarm, or disabled', 'lazy')
    .action((name: string, options: {
      command?: string; arg: string[]; cwd?: string; url?: string; transport?: string; connect: string;
    }) => {
      if (Boolean(options.command) === Boolean(options.url)) throw new Error('Choose exactly one of --command or --url.');
      const server: McpServerConfig = options.command
        ? { type: 'stdio', command: options.command, args: options.arg, ...(options.cwd ? { cwd: path.resolve(options.cwd) } : {}), connect: options.connect as 'lazy' }
        : { type: (options.transport ?? 'streamable-http') as 'streamable-http', url: options.url!, connect: options.connect as 'lazy' };
      json({ name, config: upsertMcpServer(name, server) });
    });
  mcp.command('remove <name>').action((name: string) => json({ name, removed: removeMcpServer(name) }));
}

async function writeExtensions(paths: readonly string[]): Promise<void> {
  const current = readExtensionsIntegration(KODAX_DIR);
  writeIntegrationDocument({
    domain: 'extensions', configHome: KODAX_DIR,
    ...(current.source === 'user' ? { expectedRevision: current.revision } : {}),
    document: { version: 1, paths }, validate: parseExtensionsIntegrationDocument,
  });
}

async function validateExtensions(paths: readonly string[]): Promise<void> {
  const runtime = createExtensionRuntime();
  try { await runtime.loadExtensions([...paths], { continueOnError: false, loadSource: 'config' }); }
  finally { await runtime.dispose(); }
}

async function createA2AServerExtensionRuntime(): Promise<ReturnType<typeof createExtensionRuntime>> {
  const runtime = createExtensionRuntime();
  try {
    await registerConfiguredMcpCapabilityProvider(
      runtime,
      readMcpIntegration(KODAX_DIR).document.servers,
    );
    await runtime.loadExtensions(
      [...readExtensionsIntegration(KODAX_DIR).document.paths],
      { continueOnError: true, loadSource: 'config' },
    );
    runtime.activate();
    return runtime;
  } catch (error: unknown) {
    await runtime.dispose();
    throw error;
  }
}

function configureExtensionCommands(program: Command): void {
  const extensions = program.command('extensions').description('Manage extensions in integrations/extensions.json');
  extensions.command('list').action(() => json(readExtensionsIntegration(KODAX_DIR).document.paths));
  extensions.command('add <extensionPath>').action(async (extensionPath: string) => {
    const resolved = await resolveExtensionEntrypoint(path.resolve(extensionPath));
    await validateExtensions([resolved]);
    const current = readExtensionsIntegration(KODAX_DIR).document.paths;
    if (!current.includes(resolved)) await writeExtensions([...current, resolved]);
    json({ added: resolved });
  });
  extensions.command('remove <extensionPath>').action(async (extensionPath: string) => {
    let resolved = path.resolve(extensionPath);
    try { resolved = await resolveExtensionEntrypoint(resolved); } catch { /* Removing a missing exact path remains valid. */ }
    const current = readExtensionsIntegration(KODAX_DIR).document.paths;
    const next = current.filter((item) => path.resolve(item) !== resolved);
    await writeExtensions(next);
    json({ removed: current.length !== next.length, path: resolved });
  });
  extensions.command('reload').description('Validate the complete candidate set atomically').action(async () => {
    const paths = readExtensionsIntegration(KODAX_DIR).document.paths;
    await validateExtensions(paths);
    json({ ok: true, validated: paths.length });
  });
}

function groupPairs(values: readonly string[], label: string): Record<string, readonly string[]> {
  const result: Record<string, string[]> = {};
  for (const value of values) {
    const separator = value.indexOf(':');
    if (separator < 1 || separator === value.length - 1) throw new Error(`${label} must use name:value.`);
    const name = value.slice(0, separator);
    const item = value.slice(separator + 1);
    result[name] = [...(result[name] ?? []), item];
  }
  return result;
}

function configureA2AExpose(command: Command, version: string): void {
  command.command('expose [agent]')
    .description('Publish the Runtime default Agent or one ~/.kodax/agents Markdown Agent')
    .option('--name <name>', 'Public Agent Card name', 'KodaX Agent')
    .option('--description <text>', 'Public Agent Card description', 'Completes approved general tasks.')
    .option('--token-env <name>', 'Bearer token environment variable', 'KODAX_A2A_TOKEN')
    .option('--principal <id>', 'Authenticated principal id', 'configured-client')
    .option('--workspace-mode <mode>', 'managed or fixed', 'managed')
    .option('--workspace-root <path>', 'Absolute root for fixed mode')
    .option('--workspace-access <mode>', 'none, read, or write')
    .option('--tool <name>', 'Exact narrow Extension Tool (repeatable)', repeat, [])
    .option('--mcp <server:capability>', 'Exact MCP tool admission (repeatable)', repeat, [])
    .option('--skill-script <skill:scripts/path>', 'Exact isolated Skill script (repeatable)', repeat, [])
    .option('--network-origin <origin>', 'Exact script network origin (repeatable)', repeat, [])
    .option('--public-base-url <url>', 'HTTPS public URL when served behind a reverse proxy')
    .option('--data-dir <dir>', 'Durable task store', '~/.kodax/a2a/tasks')
    .action(async (agent: string | undefined, options: {
      name: string; description: string; tokenEnv: string; principal: string;
      workspaceMode: string; workspaceRoot?: string; workspaceAccess?: string;
      tool: string[]; mcp: string[]; skillScript: string[]; networkOrigin: string[];
      publicBaseUrl?: string; dataDir: string;
    }) => {
      if (agent) {
        const scope = await loadMarkdownAgentScope({
          cwd: process.cwd(),
          configHome: KODAX_DIR,
          userOnly: true,
        });
        try {
          const loaded = scope.loaded.some((entry) => (
            entry.name === agent && entry.source === 'markdown:user'
          ));
          if (!loaded) {
            const failure = scope.failed.find((entry) => path.basename(entry.path, '.md') === agent);
            throw new Error(failure?.reason ?? `User Markdown Agent not found: ${agent}`);
          }
        } finally {
          scope.dispose();
        }
      }
      if (!['managed', 'fixed'].includes(options.workspaceMode)) throw new Error('workspace-mode must be managed or fixed.');
      if (options.workspaceMode === 'fixed' && !options.workspaceRoot) throw new Error('--workspace-root is required for fixed mode.');
      const workspace = options.workspaceMode === 'managed'
        ? { mode: 'managed' as const }
        : { mode: 'fixed' as const, root: path.resolve(options.workspaceRoot!) };
      const workspaceAccess = options.workspaceAccess ?? (workspace.mode === 'managed' ? 'write' : 'read');
      if (!['none', 'read', 'write'].includes(workspaceAccess)) throw new Error('workspace-access must be none, read, or write.');
      const skillScripts = groupPairs(options.skillScript, 'skill-script');
      const network = options.networkOrigin.length > 0
        ? { mode: 'allowlist' as const, origins: options.networkOrigin }
        : { mode: 'deny' as const };
      const execution = {
        kind: agent ? 'local-agent' as const : 'runtime-default' as const,
        ...(agent ? { agentRef: { source: 'markdown:user' as const, name: agent } } : {}),
        workspace,
        toolPolicy: {
          workspace: workspaceAccess,
          process: options.skillScript.length > 0 ? 'isolated' : 'deny',
          network,
          tools: options.tool,
          mcp: groupPairs(options.mcp, 'mcp'),
          skillScripts,
          subagents: 'deny',
        },
      };
      const current = readA2AIntegration(KODAX_DIR);
      const parsed = parseA2AIntegrationDocument({
        version: 1, agents: current.document.agents,
        server: {
          execution,
          published: {
            name: options.name, description: options.description, version,
            skills: [{ id: 'general', name: 'General', description: options.description, tags: [] }],
            inputModes: ['text/plain', 'application/json'], outputModes: ['text/plain'],
          },
          ...(options.publicBaseUrl ? { publicBaseUrl: options.publicBaseUrl } : {}),
          authentication: { type: 'bearer-env', tokenEnv: options.tokenEnv, principalId: options.principal },
          dataDir: options.dataDir,
        },
      });
      setA2AServerConfig(KODAX_DIR, parsed.server);
      json({ configured: true, server: parsed.server, token: `env:${options.tokenEnv}` });
    });
}

async function serveA2A(options: {
  readonly hostname: string; readonly port: number; readonly profile: string;
  readonly home?: string; readonly provider?: string; readonly model?: string;
}): Promise<void> {
  assertLoopbackHostname(options.hostname);
  const controller = new IntegrationConfigController<A2AIntegrationDocument>({
    domain: 'a2a', configHome: KODAX_DIR, validate: parseA2AIntegrationDocument,
    read: () => readA2AIntegration(KODAX_DIR),
  });
  const initial = await controller.initialize();
  if (!initial.document.server) throw new Error('A2A server is not configured; run kodax a2a expose first.');
  const extensionRuntime = await createA2AServerExtensionRuntime();
  const outboundIntegration = createConfiguredA2ARuntimeIntegration({ configHome: KODAX_DIR });
  let runtime: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
  const requestedBase = `http://${options.hostname.includes(':') ? `[${options.hostname}]` : options.hostname}:${options.port}`;
  let outboundHandle: Awaited<ReturnType<typeof outboundIntegration.start>> | undefined;
  let server: Awaited<ReturnType<typeof prepareKodaXA2AServer>> | undefined;
  let applied = initial.document.server;
  try {
    runtime = await createKodaXRuntime({
      mode: 'embedded', isolation: 'inline', profile: options.profile,
      ...(options.home ? { homeDir: path.resolve(options.home) } : {}),
      ...(options.provider ? { defaultProvider: options.provider } : {}),
      ...(options.model ? { defaultModel: options.model } : {}),
      externalAgents: outboundIntegration.runtimeOptions,
    });
    outboundHandle = await outboundIntegration.start(runtime);
    const prepared = await prepareKodaXA2AServer(createA2AServerOptionsFromConfig({
      runtime, config: initial.document.server, listenBaseUrl: requestedBase,
    }));
    server = prepared;
    const baseUrl = await prepared.listen({
      hostname: options.hostname,
      port: options.port,
      ...(initial.document.server.publicBaseUrl ? { publicBaseUrl: initial.document.server.publicBaseUrl } : {}),
    });
    controller.subscribe((snapshot) => {
      const next = snapshot.document.server;
      const change = classifyA2AServerChange(applied, next);
      if (change.kind === 'restart-required' || !next) {
        stderr(`[a2a] valid config change pending restart: ${change.fields.join(', ') || 'server'}`);
        return;
      }
      if (change.kind === 'hot') {
        prepared.updateHot(createA2AServerHotOptions({ config: next, listenBaseUrl: baseUrl }));
        applied = next;
        stderr(`[a2a] hot-reloaded: ${change.fields.join(', ')}`);
      }
    });
    controller.startWatching();
    stdout(`A2A server listening on ${baseUrl}`);
    stdout(`Agent Card: ${baseUrl}/.well-known/agent-card.json`);
    await new Promise<void>((resolve) => {
      const stop = (): void => resolve();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } finally {
    controller.close();
    await server?.close();
    outboundHandle?.close();
    await runtime?.close();
    await extensionRuntime.dispose();
  }
}

function configureA2ACommands(program: Command, version: string): void {
  const a2a = program.command('a2a').description('Call third-party A2A Agents or expose KodaX as an A2A Agent');
  a2a.command('list').action(() => json(readA2AIntegration(KODAX_DIR).document));
  a2a.command('add <name> <cardUrl>')
    .option('--credential-env <name>', 'Bearer token environment variable')
    .option('--effect <effect>', 'none, read, write, or unknown', parseEffect, 'unknown')
    .option('--allow-private', 'Allow private-network discovery')
    .option('--no-test', 'Store without fetching the Agent Card')
    .action(async (name: string, cardUrl: string, options: {
      credentialEnv?: string; effect: A2AOutboundEffect; allowPrivate?: boolean; test?: boolean;
    }) => {
      const candidate = { cardUrl, ...(options.credentialEnv ? { credentialEnv: options.credentialEnv } : {}), effect: options.effect };
      if (options.test !== false) {
        const url = new URL(cardUrl);
        await discoverA2ARegistration({ agentId: name, agentCardUrl: cardUrl, effects: { remote: options.effect } }, {
          networkPolicy: networkPolicy([url.origin], privateAllowed(url, options.allowPrivate === true)), pollIntervalMs: 500,
        });
      }
      upsertA2AOutboundAgent(KODAX_DIR, name, candidate);
      json({ added: name, cardUrl, credential: options.credentialEnv ? `env:${options.credentialEnv}` : 'none' });
    });
  a2a.command('remove <name>').action((name: string) => json({ name, removed: removeA2AOutboundAgent(KODAX_DIR, name) }));
  a2a.command('test <name>').option('--allow-private').action(async (name: string, options: { allowPrivate?: boolean }) => {
    const result = await discoverConfiguredAgent(name, options.allowPrivate === true);
    json({ ok: true, name: result.card.name, version: result.card.version, skills: result.card.skills });
  });
  a2a.command('call <name> <prompt>').option('--allow-private').action(async (name: string, prompt: string, options: { allowPrivate?: boolean }) => {
    json(await callConfiguredAgent(name, prompt, options.allowPrivate === true));
  });
  configureA2AExpose(a2a, version);
  a2a.command('serve')
    .option('--host <hostname>', 'Loopback hostname', '127.0.0.1')
    .option('--port <port>', 'Non-zero listener port', parsePort, 8765)
    .option('--profile <name>', 'Runtime profile', 'a2a-server')
    .option('--home <dir>', 'Runtime home directory')
    .option('--provider <name>', 'Default provider')
    .option('--model <name>', 'Default model')
    .action((options: { host: string; port: number; profile: string; home?: string; provider?: string; model?: string }) => (
      serveA2A({ hostname: options.host, port: options.port, profile: options.profile, home: options.home, provider: options.provider, model: options.model })
    ));
}

function configureSandboxCommands(program: Command): void {
  const sandbox = program.command('sandbox').description('Inspect or provision the ASRT Skill-script isolation backend');
  sandbox.command('doctor').action(async () => json(await doctorSandboxRuntime({ refresh: true })));
  sandbox.command('setup').description('Windows: run the explicit one-time UAC provisioning flow').action(async () => json(await setupSandboxRuntime()));
}

export function configureIntegrationCommands(program: Command, options: { readonly version: string }): void {
  configureConfigCommands(program);
  configureIntegrationManagement(program);
  configureMcpCommands(program);
  configureExtensionCommands(program);
  configureA2ACommands(program, options.version);
  configureSandboxCommands(program);
}
