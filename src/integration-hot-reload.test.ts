import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let configHome = "";
let previousKodaXHome: string | undefined;
let coding: typeof import("@kodax-ai/coding");
let repl: typeof import("@kodax-ai/repl");
let createIntegrationEventBridge: typeof import("./integration-hot-reload.js").createIntegrationEventBridge;
let startIntegrationHotReload: typeof import("./integration-hot-reload.js").startIntegrationHotReload;

beforeAll(async () => {
  previousKodaXHome = process.env.KODAX_HOME;
  configHome = path.join(
    mkdtempSync(path.join(os.tmpdir(), "kodax-hot-reload-")),
    ".kodax",
  );
  process.env.KODAX_HOME = configHome;
  vi.resetModules();
  const [codingModule, replModule, hotReloadModule] = await Promise.all([
    import("@kodax-ai/coding"),
    import("@kodax-ai/repl"),
    import("./integration-hot-reload.js"),
  ]);
  coding = codingModule;
  repl = replModule;
  createIntegrationEventBridge = hotReloadModule.createIntegrationEventBridge;
  startIntegrationHotReload = hotReloadModule.startIntegrationHotReload;
});

afterAll(() => {
  if (previousKodaXHome === undefined) delete process.env.KODAX_HOME;
  else process.env.KODAX_HOME = previousKodaXHome;
  rmSync(path.dirname(configHome), { recursive: true, force: true });
});

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for integration hot reload.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("integration hot reload", () => {
  it("routes live events to transient UI notices while preserving the terminal fallback", () => {
    const logs: string[] = [];
    const notices: Array<{ text: string; tone: "success" | "warning" }> = [];
    const bridge = createIntegrationEventBridge((message) =>
      logs.push(message),
    );

    bridge.onEvent("MCP configuration hot-reloaded (2 servers).");
    expect(logs).toEqual([
      "[integrations] MCP configuration hot-reloaded (2 servers).",
    ]);

    const unsubscribe = bridge.subscribe((notice) => notices.push(notice));
    bridge.onEvent("MCP configuration hot-reloaded (3 servers).");
    bridge.onEvent("mcp: Invalid JSON.");

    expect(notices).toEqual([
      {
        text: "[integrations] MCP configuration hot-reloaded (3 servers).",
        tone: "success",
      },
      {
        text: "[integrations] mcp: Invalid JSON.",
        tone: "warning",
      },
    ]);
    expect(logs).toHaveLength(1);

    unsubscribe();
    bridge.onEvent(
      "Extension configuration hot-reloaded (1 applied, 0 retained, 0 removed).",
    );
    expect(logs.at(-1)).toContain("Extension configuration hot-reloaded");
  });

  it("updates live MCP and Extension surfaces while retaining the last valid snapshot", async () => {
    const integrationDir = path.join(configHome, "integrations");
    mkdirSync(integrationDir, { recursive: true });
    writeFileSync(path.join(integrationDir, "mcp.json"), "{ broken", "utf8");
    writeFileSync(
      path.join(integrationDir, "extensions.json"),
      JSON.stringify({ version: 1, paths: [] }),
      "utf8",
    );
    const runtime = coding.createExtensionRuntime().activate();
    const events: string[] = [];
    const hotReload = await startIntegrationHotReload({
      runtime,
      onEvent: (message) => events.push(message),
    });
    try {
      expect(hotReload.statuses()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            domain: "mcp",
            source: "user",
            diagnostic: expect.objectContaining({ code: "invalid-config" }),
          }),
          expect.objectContaining({
            domain: "extensions",
            source: "user",
          }),
        ]),
      );
      expect(
        hotReload.statuses().find((status) => status.domain === "extensions")
          ?.diagnostic,
      ).toBeUndefined();
      expect(events).toContainEqual(expect.stringMatching(/mcp:.*invalid/i));

      repl.writeIntegrationDocument({
        domain: "mcp",
        configHome,
        document: {
          version: 1,
          servers: {
            local: {
              type: "stdio",
              command: "node",
              args: ["server.mjs"],
              connect: "lazy",
            },
          },
        },
        validate: repl.parseMcpIntegrationDocument,
      });
      await waitUntil(() => runtime.hasCapabilityProvider("mcp"));
      expect(events).toContainEqual(
        expect.stringContaining("MCP configuration hot-reloaded"),
      );

      const extensionPath = path.join(
        path.dirname(configHome),
        "hot-extension.mjs",
      );
      writeFileSync(
        extensionPath,
        `export default function(api) {
        api.registerTool({
          name: 'hot_reload_echo',
          description: 'Hot reload test',
          input_schema: { type: 'object', properties: {} },
          handler: async () => 'ok'
        });
      }`,
        "utf8",
      );
      repl.writeIntegrationDocument({
        domain: "extensions",
        configHome,
        document: { version: 1, paths: [extensionPath] },
        validate: repl.parseExtensionsIntegrationDocument,
      });
      await waitUntil(
        () => runtime.getDiagnostics().loadedExtensions.length === 1,
      );
      expect(events).toContainEqual(
        expect.stringContaining("Extension configuration hot-reloaded"),
      );

      writeFileSync(
        repl.resolveIntegrationConfigPath("extensions", configHome),
        JSON.stringify({ version: 1, paths: [42] }),
        "utf8",
      );
      await waitUntil(() =>
        hotReload
          .statuses()
          .some(
            (status) =>
              status.domain === "extensions" &&
              status.diagnostic?.code === "invalid-config",
          ),
      );
      expect(runtime.getDiagnostics().loadedExtensions).toHaveLength(1);
    } finally {
      hotReload.close();
      await runtime.dispose();
    }
  });

  it("recovers a legacy core MCP declaration after the customer repairs config.json", async () => {
    rmSync(path.join(configHome, "integrations"), {
      recursive: true,
      force: true,
    });
    mkdirSync(configHome, { recursive: true });
    writeFileSync(
      path.join(configHome, "config.json"),
      JSON.stringify({ mcpServers: { legacy: { command: 42 } } }),
      "utf8",
    );
    const runtime = coding.createExtensionRuntime().activate();
    const hotReload = await startIntegrationHotReload({ runtime, configHome });
    try {
      expect(hotReload.statuses()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            domain: "mcp",
            path: path.join(configHome, "config.json"),
            source: "legacy-user",
            diagnostic: expect.objectContaining({ code: "invalid-config" }),
          }),
        ]),
      );

      writeFileSync(
        path.join(configHome, "config.json"),
        JSON.stringify({
          mcpServers: {
            repaired: {
              type: "stdio",
              command: "node",
              args: ["server.mjs"],
              connect: "lazy",
            },
          },
        }),
        "utf8",
      );
      await waitUntil(() => runtime.hasCapabilityProvider("mcp"));
      expect(
        hotReload.statuses().find((status) => status.domain === "mcp"),
      ).toMatchObject({
        path: path.join(configHome, "config.json"),
        source: "legacy-user",
      });
      expect(
        hotReload.statuses().find((status) => status.domain === "mcp")
          ?.diagnostic,
      ).toBeUndefined();
    } finally {
      hotReload.close();
      await runtime.dispose();
    }
  });
});
