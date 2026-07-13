import type { McpProviderOptions } from '@kodax-ai/agent';
import {
  replaceConfiguredMcpCapabilityProvider,
  type KodaXExtensionRuntime,
} from '@kodax-ai/coding';
import {
  IntegrationConfigController,
  KODAX_DIR,
  parseExtensionsIntegrationDocument,
  parseMcpIntegrationDocument,
  readExtensionsIntegration,
  readMcpIntegration,
  type ExtensionsIntegrationDocument,
  type IntegrationConfigStatus,
  type McpIntegrationDocument,
} from '@kodax-ai/repl';

export interface IntegrationHotReloadHandle {
  readonly statuses: () => readonly IntegrationConfigStatus[];
  close(): void;
}

export async function startIntegrationHotReload(input: {
  readonly runtime: KodaXExtensionRuntime;
  readonly mcpOptions?: McpProviderOptions;
  readonly onEvent?: (message: string) => void;
}): Promise<IntegrationHotReloadHandle> {
  const mcp = new IntegrationConfigController<McpIntegrationDocument>({
    domain: 'mcp', configHome: KODAX_DIR, validate: parseMcpIntegrationDocument,
    read: () => readMcpIntegration(KODAX_DIR),
  });
  const extensions = new IntegrationConfigController<ExtensionsIntegrationDocument>({
    domain: 'extensions', configHome: KODAX_DIR, validate: parseExtensionsIntegrationDocument,
    read: () => readExtensionsIntegration(KODAX_DIR),
  });
  await Promise.all([mcp.initialize(), extensions.initialize()]);
  mcp.subscribe(async (snapshot, previous) => {
    if (snapshot.revision === previous?.revision) return;
    await replaceConfiguredMcpCapabilityProvider(input.runtime, snapshot.document.servers, input.mcpOptions);
    input.onEvent?.(`MCP configuration hot-reloaded (${Object.keys(snapshot.document.servers).length} servers).`);
  });
  extensions.subscribe(async (snapshot, previous) => {
    if (snapshot.revision === previous?.revision) return;
    const result = await input.runtime.reconcileExtensions(
      snapshot.document.paths,
      { loadSource: 'config' },
    );
    input.onEvent?.(
      `Extension configuration hot-reloaded (${result.applied} applied, ${result.retained} retained, ${result.removed} removed).`,
    );
  });
  mcp.startWatching();
  extensions.startWatching();
  let lastDiagnostic = '';
  const diagnosticTimer = setInterval(() => {
    for (const status of [mcp.status(), extensions.status()]) {
      const diagnostic = status.diagnostic;
      if (diagnostic && diagnostic.time !== lastDiagnostic) {
        lastDiagnostic = diagnostic.time;
        input.onEvent?.(`${status.domain}: ${diagnostic.message}`);
      }
    }
  }, 500);
  diagnosticTimer.unref?.();
  return {
    statuses: () => [mcp.status(), extensions.status()],
    close() {
      clearInterval(diagnosticTimer);
      mcp.close();
      extensions.close();
    },
  };
}
