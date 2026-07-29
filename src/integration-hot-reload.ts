import type { McpProviderOptions } from "@kodax-ai/agent";
import path from "node:path";
import {
  replaceConfiguredMcpCapabilityProvider,
  type KodaXExtensionRuntime,
} from "@kodax-ai/coding";
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
} from "@kodax-ai/repl";

export interface IntegrationHotReloadHandle {
  readonly statuses: () => readonly IntegrationConfigStatus[];
  close(): void;
}

export interface IntegrationTransientNotice {
  readonly text: string;
  readonly tone: "success" | "warning";
}

export function createIntegrationEventBridge(log: (message: string) => void): {
  readonly onEvent: (message: string) => void;
  readonly subscribe: (
    listener: (notice: IntegrationTransientNotice) => void,
  ) => () => void;
} {
  let listener: ((notice: IntegrationTransientNotice) => void) | undefined;
  return {
    onEvent(message) {
      const text = `[integrations] ${message}`;
      if (!listener) {
        log(text);
        return;
      }
      listener({
        text,
        tone: message.includes("hot-reloaded") ? "success" : "warning",
      });
    },
    subscribe(nextListener) {
      listener = nextListener;
      return () => {
        if (listener === nextListener) listener = undefined;
      };
    },
  };
}

export async function startIntegrationHotReload(input: {
  readonly runtime: KodaXExtensionRuntime;
  readonly configHome?: string;
  readonly mcpOptions?: McpProviderOptions;
  readonly onEvent?: (message: string) => void;
}): Promise<IntegrationHotReloadHandle> {
  const configHome = input.configHome ?? KODAX_DIR;
  const mcp = new IntegrationConfigController<McpIntegrationDocument>({
    domain: "mcp",
    configHome,
    validate: parseMcpIntegrationDocument,
    read: () => readMcpIntegration(configHome),
    fallbackPath: path.join(configHome, "config.json"),
    coldStartDefault: { version: 1, servers: {} },
  });
  const extensions =
    new IntegrationConfigController<ExtensionsIntegrationDocument>({
      domain: "extensions",
      configHome,
      validate: parseExtensionsIntegrationDocument,
      read: () => readExtensionsIntegration(configHome),
      fallbackPath: path.join(configHome, "config.json"),
      coldStartDefault: { version: 1, paths: [] },
    });
  await Promise.all([mcp.initialize(), extensions.initialize()]);
  for (const status of [mcp.status(), extensions.status()]) {
    if (status.diagnostic)
      input.onEvent?.(`${status.domain}: ${status.diagnostic.message}`);
  }
  mcp.subscribe(async (snapshot, previous) => {
    if (snapshot.revision === previous?.revision) return;
    await replaceConfiguredMcpCapabilityProvider(
      input.runtime,
      snapshot.document.servers,
      input.mcpOptions,
    );
    input.onEvent?.(
      `MCP configuration hot-reloaded (${Object.keys(snapshot.document.servers).length} servers).`,
    );
  });
  extensions.subscribe(async (snapshot, previous) => {
    if (snapshot.revision === previous?.revision) return;
    const result = await input.runtime.reconcileExtensions(
      snapshot.document.paths,
      { loadSource: "config" },
    );
    input.onEvent?.(
      `Extension configuration hot-reloaded (${result.applied} applied, ${result.retained} retained, ${result.removed} removed).`,
    );
  });
  mcp.startWatching();
  extensions.startWatching();
  let lastDiagnostic = "";
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
