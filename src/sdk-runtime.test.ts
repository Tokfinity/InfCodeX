import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import nodeFs from "node:fs";
import { promises as nodeFsPromises, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as net from "node:net";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetActiveRootQueueRoutesForTests,
  _resetMessageQueueForTests,
  actorQueueId,
  applySessionCompaction,
  createSessionLineage,
  createAgent,
  enqueueWithArtifacts,
  getSessionMessagesFromLineage,
  getSessionMessageEntryId,
  getMessageQueue,
  persistCompactedSessionHistory,
  resolveActiveRootQueueRoute,
  Runner,
  SkillRegistry,
} from "@kodax-ai/agent";
import type {
  AgentActorSnapshot,
  AgentExecutorFactory,
  AgentTaskState,
  ExternalAgentRegistration,
  GuardrailContext,
  ManagedRunClassification,
  RunnableTool,
  RunnerLlmResult,
  RunnerToolCall,
  WorkflowEvent,
  WorkflowProcessEvent,
} from "@kodax-ai/agent";
import type {
  AutoModeToolGuardrail,
  KodaXMessage,
  KodaXOptions,
  KodaXResult,
  KodaXShellSandbox,
  RunningSession,
} from "@kodax-ai/coding";
import { resolveProviderModelDescriptors } from "@kodax-ai/coding";
import { FileSessionStorage, SessionReadError } from "@kodax-ai/repl";
import type { AutoModeBootstrapDeps } from "@kodax-ai/repl";
import type {
  KodaXRuntime,
  RuntimeDaemonClientTransport,
  RuntimeEvent,
  RuntimeInput,
  RuntimeRunInputDeliveredEventPayload,
  RuntimeStartRunInput,
} from "./sdk-runtime.js";
import type { RuntimeDaemonEndpoint } from "./runtime-daemon/transport.js";
import {
  createRuntimePermissionMatcher,
  runtimePermissionHostPlatform,
} from "./runtime-permission-scope.js";
import { derivePromptCacheAffinityKey } from "../packages/coding/src/agent-runtime/prompt-cache-affinity.js";
import { toolSkill } from "../packages/coding/src/tools/skill.js";

const codingMock = vi.hoisted(() => ({
  runManagedTask: vi.fn(),
  startKodaX: vi.fn(),
}));

const mutableNodeFs = createRequire(import.meta.url)("node:fs") as {
  appendFileSync: typeof nodeFs.appendFileSync;
  linkSync: typeof nodeFs.linkSync;
  openSync: typeof nodeFs.openSync;
  readFileSync: typeof nodeFs.readFileSync;
  readdirSync: typeof nodeFs.readdirSync;
  renameSync: typeof nodeFs.renameSync;
  rmSync: typeof nodeFs.rmSync;
  statSync: typeof nodeFs.statSync;
  truncateSync: typeof nodeFs.truncateSync;
  writeFileSync: typeof nodeFs.writeFileSync;
};

const replMock = vi.hoisted(() => ({
  bootstrapAutoMode: vi.fn(),
  beforeLoadSession: null as null | ((call: number) => Promise<void>),
  loadSessionCalls: 0,
}));

function runtimeAutoGuardrail(options: KodaXOptions): AutoModeToolGuardrail {
  const guardrail = options.guardrails?.find(
    (candidate) => candidate.kind === "tool" && candidate.name === "auto-mode",
  );
  if (!guardrail || guardrail.kind !== "tool") {
    throw new Error("expected Runtime-owned auto-mode tool guardrail");
  }
  const autoModeGuardrail = guardrail as AutoModeToolGuardrail;
  if (!autoModeGuardrail.beforeTool) {
    throw new Error("expected Runtime-owned auto-mode tool guardrail");
  }
  return autoModeGuardrail;
}

async function authorizeRuntimeAutoCall(
  options: KodaXOptions,
  call: RunnerToolCall,
): Promise<void> {
  const guardrail = runtimeAutoGuardrail(options);
  const context: GuardrailContext = {
    agent: createAgent({
      name: "runtime-auto-test",
      instructions: "Test guardrail ordering.",
    }),
    messages: [],
  };
  const verdict = await guardrail.beforeTool?.(call, context);
  if (verdict?.action !== "allow") {
    throw new Error(
      `expected auto-mode allow, received ${verdict?.action ?? "no verdict"}`,
    );
  }
}

vi.mock("@kodax-ai/coding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kodax-ai/coding")>();
  return {
    ...actual,
    runManagedTask: codingMock.runManagedTask,
    startKodaX: codingMock.startKodaX,
  };
});

vi.mock("@kodax-ai/repl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kodax-ai/repl")>();
  return {
    ...actual,
    bootstrapAutoMode: replMock.bootstrapAutoMode,
    createSessionManager: (
      ...args: Parameters<typeof actual.createSessionManager>
    ) => {
      const manager = actual.createSessionManager(...args);
      return {
        ...manager,
        async loadSession(sessionId: string) {
          const call = replMock.loadSessionCalls + 1;
          replMock.loadSessionCalls = call;
          await replMock.beforeLoadSession?.(call);
          return manager.loadSession(sessionId);
        },
      };
    },
  };
});

describe("createKodaXRuntime", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kodax-runtime-"));
    codingMock.runManagedTask.mockReset();
    codingMock.startKodaX.mockReset();
    replMock.bootstrapAutoMode.mockReset();
    replMock.beforeLoadSession = null;
    replMock.loadSessionCalls = 0;
  });

  afterEach(async () => {
    _resetMessageQueueForTests();
    _resetActiveRootQueueRoutesForTests();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("hosts an embedded Runtime in a disposable Worker without changing the service API", async () => {
    const { createKodaXRuntime } = await import("./sdk-runtime.js");
    const runtime = await createKodaXRuntime({
      mode: "embedded",
      isolation: "worker",
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "worker-sessions"),
    });

    expect(runtime.identity).toMatchObject({
      mode: "embedded",
      isolation: "worker",
      workerThreadId: expect.any(Number),
    });
    expect(runtime.capabilities.skillLearningLoop).toEqual({
      version: 1,
      activation: "project_scoped_canary",
      immutableDecisions: true,
      recordGatedDiscovery: true,
      exactUseAttribution: true,
      rollback: true,
    });
    expect(runtime.capabilities.sandboxRuntime).toMatchObject({
      version: 1,
      genericCommandExecution: true,
      ordinaryCallsTriggerSetup: false,
      unavailableBehavior: "structured-no-execution",
      permissionFallback: "normal-permission-policy",
    });
    expect(runtime.capabilities.runtimeAutoModeGuardrail).toMatchObject({
      version: 4,
      fallbackPersistsEngine: false,
    });
    expect(runtime.capabilities.runtimeEventCoalescing).toEqual({
      version: 1,
    });
    expect(runtime.capabilities.managedRunDurability).toMatchObject({
      version: 1,
      initialInputBeforeExecution: true,
      completedTurnBeforeEvent: true,
      deliveredInputBeforeEvent: true,
      persistenceFailure: "fail_closed",
    });
    const session = await runtime.sessions.create({ title: "Worker Session" });
    await expect(runtime.sessions.list()).resolves.toEqual([
      expect.objectContaining({ id: session.id, title: "Worker Session" }),
    ]);

    await runtime.close();
    await expect(runtime.status.snapshot()).rejects.toThrow(
      /Worker transport is closed/i,
    );
  }, 60_000);

  it("cancels a Worker-owned Agent waiter at the remote dispatcher", async () => {
    const postMessage = vi.spyOn(Worker.prototype, "postMessage");
    const { createKodaXRuntime } = await import("./sdk-runtime.js");
    const runtime = await createKodaXRuntime({
      mode: "embedded",
      isolation: "worker",
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "worker-cancel-sessions"),
    });
    try {
      const session = await runtime.sessions.create({
        sessionId: "worker-cancel-session",
      });
      const controller = new AbortController();
      const waiting = runtime.agents.wait(session.id, 999_999, 30_000, {
        signal: controller.signal,
      });
      controller.abort();

      await expect(waiting).rejects.toMatchObject({ code: "read_cancelled" });
      const frames = postMessage.mock.calls.map(([frame]) => frame).filter(
        (frame): frame is {
          readonly id: string;
          readonly method: string;
          readonly params?: Readonly<Record<string, unknown>>;
        } => typeof frame === "object" && frame !== null && "method" in frame,
      );
      const waitFrame = frames.find((frame) => frame.method === "agents.wait");
      expect(waitFrame).toBeDefined();
      expect(frames).toContainEqual(expect.objectContaining({
        method: "request.cancel",
        params: { requestId: waitFrame?.id },
      }));
    } finally {
      postMessage.mockRestore();
      await runtime.close();
    }
  }, 60_000);

  it("loads configured A2A inside the Worker owner for listing and dispatch", async () => {
    let baseUrl = "";
    const methods: string[] = [];
    const server = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/card") {
        response.end(
          JSON.stringify({
            name: "Worker A2A Agent",
            description: "A configured Agent owned by the Runtime Worker.",
            version: "1.0.0",
            supportedInterfaces: [
              {
                url: `${baseUrl}/rpc`,
                protocolBinding: "JSONRPC",
                protocolVersion: "1.0",
              },
            ],
            capabilities: { streaming: false },
            defaultInputModes: ["text/plain"],
            defaultOutputModes: ["text/plain"],
            skills: [
              {
                id: "general",
                name: "General",
                description: "General tasks",
                tags: [],
              },
            ],
          }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        readonly id: string;
        readonly method: string;
      };
      methods.push(payload.method);
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            message: {
              messageId: "worker-result",
              role: "ROLE_AGENT",
              parts: [
                {
                  text: "worker A2A completed",
                  mediaType: "text/plain",
                },
              ],
            },
          },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected Worker A2A test server address.");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    const configDir = path.join(tempRoot, ".kodax", "integrations");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "a2a.json"),
      `${JSON.stringify({
        version: 2,
        agents: {
          "worker-a2a": {
            cardUrl: `${baseUrl}/card`,
            enabled: true,
            effect: "read",
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );

    let runtime: KodaXRuntime | undefined;
    try {
      const { createKodaXRuntime } = await import("./sdk-runtime.js");
      runtime = await createKodaXRuntime({
        mode: "embedded",
        isolation: "worker",
        homeDir: tempRoot,
        sessionsDir: path.join(tempRoot, "worker-a2a-sessions"),
        worker: { configuredA2A: true },
        requirements: { externalAgents: true },
      });
      await expect(
        runtime.agents.listDispatchable({ actorId: "worker-a2a-test" }),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            descriptor: expect.objectContaining({
              agentId: "external:worker-a2a",
            }),
          }),
        ]),
      );

      const session = await runtime.sessions.create({
        sessionId: "worker-a2a-session",
        title: "Worker A2A dispatch",
      });
      const started = await runtime.agents.spawn(session.id, {
        taskName: "worker-a2a",
        kind: "external",
        objective: "Complete through the Worker-owned A2A plane.",
        metadata: { agentId: "external:worker-a2a" },
      });
      const deadline = Date.now() + 5_000;
      let completed = await runtime.agents.output(
        session.id,
        "/root/worker-a2a",
        started.turnId,
      );
      while (completed.state === "accepted" || completed.state === "running") {
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for ${started.turnId}.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        completed = await runtime.agents.output(
          session.id,
          "/root/worker-a2a",
          started.turnId,
        );
      }
      expect(completed).toMatchObject({
        state: "completed",
        output: "worker A2A completed",
      });
      expect(methods).toContain("SendMessage");
    } finally {
      await runtime?.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 60_000);

  it("fails closed when a connected Runtime lacks a required capability", async () => {
    const { createKodaXRuntime } = await import("./sdk-runtime.js");
    const transport: RuntimeDaemonClientTransport = {
      async request(method) {
        if (method !== "initialize") return null;
        return {
          identity: {
            runtimeId: "daemon-no-hard-dispose",
            mode: "embedded",
            profile: "default",
            startedAt: "2026-07-10T00:00:00.000Z",
            version: "0.7.66",
          },
          capabilities: { hardDispose: false },
        };
      },
      subscribe() {
        return { close() {} };
      },
    };

    await expect(
      createKodaXRuntime({
        mode: "daemon",
        daemonTransport: transport,
        requirements: { hardDispose: true },
      }),
    ).rejects.toThrow(/does not support.*hardDispose/i);
  });

  it("fails closed when inline embedded Runtime cannot satisfy hard disposal", async () => {
    const { createKodaXRuntime } = await import("./sdk-runtime.js");

    await expect(
      createKodaXRuntime({
        mode: "embedded",
        requirements: { hardDispose: true },
      }),
    ).rejects.toThrow(/does not support.*hardDispose/i);
  });

  it("fails closed when a daemon lacks the required safe management contract", async () => {
    const { connectKodaXRuntime } = await import("./sdk-runtime.js");
    const transport: RuntimeDaemonClientTransport = {
      async request(method) {
        if (method !== "initialize") return null;
        return {
          identity: {
            runtimeId: "daemon-without-management",
            mode: "daemon",
            profile: "default",
            startedAt: "2026-07-15T00:00:00.000Z",
            version: "0.7.69",
          },
          capabilities: {},
        };
      },
      subscribe() {
        return { close() {} };
      },
    };

    await expect(
      connectKodaXRuntime({
        transport,
        requirements: { daemonManagement: 1 },
      }),
    ).rejects.toThrow(/does not support.*daemonManagement/i);
  });

  it("fails closed when a daemon lacks resilient integration configuration", async () => {
    const { connectKodaXRuntime } = await import("./sdk-runtime.js");
    const transport: RuntimeDaemonClientTransport = {
      async request(method) {
        if (method !== "initialize") return null;
        return {
          identity: {
            runtimeId: "daemon-without-integration-resilience",
            mode: "daemon",
            profile: "default",
            startedAt: "2026-07-28T00:00:00.000Z",
            version: "0.7.77",
          },
          capabilities: {},
        };
      },
      subscribe() {
        return { close() {} };
      },
    };

    await expect(
      connectKodaXRuntime({
        transport,
        requirements: { integrationConfigResilience: 1 },
      }),
    ).rejects.toThrow(/does not support.*integrationConfigResilience/i);
  });

  it("fails closed when a daemon lacks managed Run durability", async () => {
    const { connectKodaXRuntime } = await import("./sdk-runtime.js");
    const transport: RuntimeDaemonClientTransport = {
      async request(method) {
        if (method !== "initialize") return null;
        return {
          identity: {
            runtimeId: "daemon-without-managed-run-durability",
            mode: "daemon",
            profile: "default",
            startedAt: "2026-08-04T00:00:00.000Z",
            version: "0.7.80",
          },
          capabilities: {},
        };
      },
      subscribe() {
        return { close() {} };
      },
    };

    await expect(
      connectKodaXRuntime({
        transport,
        requirements: { managedRunDurability: 1 },
      }),
    ).rejects.toThrow(/does not support.*managedRunDurability/i);
  });

  it("fails closed when a daemon lacks authoritative shutdown verification", async () => {
    const { connectKodaXRuntime } = await import("./sdk-runtime.js");
    const transport: RuntimeDaemonClientTransport = {
      async request(method) {
        if (method !== "initialize") return null;
        return {
          identity: {
            runtimeId: "daemon-without-shutdown-verification",
            mode: "daemon",
            profile: "default",
            startedAt: "2026-08-06T00:00:00.000Z",
            version: "0.7.82",
          },
          capabilities: {},
        };
      },
      subscribe() {
        return { close() {} };
      },
    };

    await expect(
      connectKodaXRuntime({
        transport,
        requirements: { daemonShutdownVerification: 1 },
      }),
    ).rejects.toThrow(/does not support.*daemonShutdownVerification/i);
  });

  it("fails closed when an older daemon lacks fenced external Agent administration", async () => {
    const { connectKodaXRuntime } = await import("./sdk-runtime.js");
    const transport: RuntimeDaemonClientTransport = {
      async request(method) {
        if (method !== "initialize") return null;
        return {
          identity: {
            runtimeId: "daemon-with-legacy-external-agents",
            mode: "daemon",
            profile: "default",
            startedAt: "2026-07-15T00:00:00.000Z",
            version: "0.7.70",
          },
          capabilities: { externalAgents: true },
        };
      },
      subscribe() {
        return { close() {} };
      },
    };

    await expect(
      connectKodaXRuntime({
        transport,
        requirements: { externalAgentAdmin: 1 },
      }),
    ).rejects.toThrow(/does not support.*externalAgentAdmin/i);
  });

  it("fails closed when an older daemon lacks the versioned Actor control plane", async () => {
    const { connectKodaXRuntime } = await import("./sdk-runtime.js");
    const transport: RuntimeDaemonClientTransport = {
      async request(method) {
        if (method !== "initialize") return null;
        return {
          identity: {
            runtimeId: "daemon-without-actor-control-plane",
            mode: "daemon",
            profile: "default",
            startedAt: "2026-07-18T00:00:00.000Z",
            version: "0.7.71",
          },
          capabilities: {},
        };
      },
      subscribe() {
        return { close() {} };
      },
    };

    await expect(
      connectKodaXRuntime({
        transport,
        requirements: { actorControlPlane: 1 },
      }),
    ).rejects.toThrow(/does not support.*actorControlPlane/i);
  });

  it("fails closed when an attach-only daemon lacks Runtime-owned Auto guardrails", async () => {
    const { connectKodaXRuntime } = await import("./sdk-runtime.js");
    const transport: RuntimeDaemonClientTransport = {
      async request(method) {
        if (method !== "initialize") return null;
        return {
          identity: {
            runtimeId: "daemon-with-legacy-permission-chain",
            mode: "daemon",
            profile: "default",
            startedAt: "2026-07-18T00:00:00.000Z",
            version: "0.7.72",
          },
          capabilities: { sharedSessionSettings: { version: 1 } },
        };
      },
      subscribe() {
        return { close() {} };
      },
    };

    await expect(
      connectKodaXRuntime({
        transport,
        requirements: { runtimeAutoModeGuardrail: 1 },
      }),
    ).rejects.toThrow(/does not support.*runtimeAutoModeGuardrail/i);
  });

  it("fails closed when an attach-only daemon lacks Runtime event coalescing", async () => {
    const { connectKodaXRuntime } = await import("./sdk-runtime.js");
    const transport: RuntimeDaemonClientTransport = {
      async request(method) {
        if (method !== "initialize") return null;
        return {
          identity: {
            runtimeId: "daemon-without-event-coalescing",
            mode: "daemon",
            profile: "default",
            startedAt: "2026-07-18T00:00:00.000Z",
            version: "0.7.78",
          },
          capabilities: {
            runtimeAutoModeGuardrail: {
              version: 4,
              owner: "session-runtime",
            },
          },
        };
      },
      subscribe() {
        return { close() {} };
      },
    };

    await expect(
      connectKodaXRuntime({
        transport,
        requirements: { runtimeEventCoalescing: 1 },
      }),
    ).rejects.toThrow(/does not support.*runtimeEventCoalescing/i);
  });

  it("accepts a newer Runtime Auto guardrail capability for an older minimum requirement", async () => {
    const { connectKodaXRuntime } = await import("./sdk-runtime.js");
    const transport: RuntimeDaemonClientTransport = {
      async request(method) {
        if (method !== "initialize") return null;
        return {
          identity: {
            runtimeId: "daemon-with-auto-guardrail-v2",
            mode: "daemon",
            profile: "default",
            startedAt: "2026-07-20T00:00:00.000Z",
            version: "0.7.73",
          },
          capabilities: {
            runtimeAutoModeGuardrail: { version: 2, owner: "session-runtime" },
          },
        };
      },
      subscribe() {
        return { close() {} };
      },
    };

    const runtime = await connectKodaXRuntime({
      transport,
      requirements: { runtimeAutoModeGuardrail: 1 },
    });
    expect(runtime.identity.runtimeId).toBe("daemon-with-auto-guardrail-v2");
    await runtime.close();
  });

  it("rejects Runtime Auto guardrail v1 when the caller requires v2 semantics", async () => {
    const { connectKodaXRuntime } = await import("./sdk-runtime.js");
    const transport: RuntimeDaemonClientTransport = {
      async request(method) {
        if (method !== "initialize") return null;
        return {
          identity: {
            runtimeId: "daemon-with-auto-guardrail-v1",
            mode: "daemon",
            profile: "default",
            startedAt: "2026-07-19T00:00:00.000Z",
            version: "0.7.72",
          },
          capabilities: {
            runtimeAutoModeGuardrail: { version: 1, owner: "session-runtime" },
          },
        };
      },
      subscribe() {
        return { close() {} };
      },
    };

    await expect(
      connectKodaXRuntime({
        transport,
        requirements: { runtimeAutoModeGuardrail: 2 },
      }),
    ).rejects.toThrow(/does not support.*runtimeAutoModeGuardrail/i);
  });

  it("rejects Worker-only options unless Worker isolation is selected", async () => {
    const { createKodaXRuntime } = await import("./sdk-runtime.js");

    await expect(
      createKodaXRuntime({
        mode: "embedded",
        worker: { shutdownTimeoutMs: 100 },
      }),
    ).rejects.toThrow(/worker options require.*isolation.*worker/i);
  });

  it("rejects an explicit embedded isolation mode for daemon ownership", async () => {
    const { createKodaXRuntime } = await import("./sdk-runtime.js");
    const transport: RuntimeDaemonClientTransport = {
      async request() {
        return {
          identity: {
            runtimeId: "unused-daemon-runtime",
            mode: "daemon",
            profile: "default",
            startedAt: "2026-07-10T00:00:00.000Z",
            version: "0.7.66",
          },
          capabilities: { hardDispose: false },
        };
      },
      subscribe() {
        return { close() {} };
      },
    };

    await expect(
      createKodaXRuntime({
        mode: "daemon",
        isolation: "inline",
        daemonTransport: transport,
      }),
    ).rejects.toThrow(/daemon mode.*isolation/i);
  });

  it("exports daemon protocol schema artifacts from the runtime SDK entrypoint", async () => {
    const runtimeSdk = await import("@kodax-ai/kodax/runtime");

    expect(runtimeSdk.RUNTIME_DAEMON_METHODS).toContain("provider.custom.list");
    expect(runtimeSdk.RUNTIME_DAEMON_PROTOCOL_SCHEMA.methods).toMatchObject({
      "provider.custom.list": expect.any(Object),
      "mcp.server.validate": expect.any(Object),
      "extension.list": expect.any(Object),
    });
    expect(
      JSON.parse(runtimeSdk.RUNTIME_DAEMON_PROTOCOL_SCHEMA_JSON),
    ).toMatchObject({
      protocol: runtimeSdk.KODAX_DAEMON_PROTOCOL,
      version: runtimeSdk.KODAX_DAEMON_PROTOCOL_VERSION,
    });
  });

  it("creates a daemon-mode runtime client through the daemon transport", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const calls: Array<{ readonly method: string; readonly params: unknown }> =
      [];
    const transport: RuntimeDaemonClientTransport = {
      async request(method, params) {
        calls.push({ method, params });
        if (method === "initialize") {
          return {
            identity: {
              runtimeId: "daemon-runtime",
              mode: "embedded",
              profile: "default",
              startedAt: "2026-07-09T00:00:00.000Z",
              version: "0.7.66",
            },
          };
        }
        if (method === "session.create") {
          return { id: "daemon-session", title: "Daemon Session" };
        }
        return {};
      },
      subscribe() {
        return { close() {} };
      },
    };

    const runtime = await createKodaXRuntime({
      mode: "daemon",
      daemonTransport: transport,
      daemonToken: "token-sdk",
      clientInfo: { name: "sdk-test", version: "0.7.66" },
      capabilities: { permissionPrompts: true, contextDiagnostics: true },
    });
    const session = await runtime.sessions.create({ title: "Daemon Session" });

    expect(runtime.identity).toMatchObject({
      runtimeId: "daemon-runtime",
      mode: "daemon",
    });
    expect(session).toEqual({ id: "daemon-session", title: "Daemon Session" });
    expect(calls.map((call) => call.method)).toEqual([
      "initialize",
      "session.create",
    ]);
    expect(calls[0]?.params).toMatchObject({
      profile: "default",
      token: "token-sdk",
      clientInfo: { name: "sdk-test", version: "0.7.66" },
      capabilities: { permissionPrompts: true, contextDiagnostics: true },
    });
  });

  it("creates a daemon-mode runtime client through a local endpoint", async () => {
    const { createRuntimeDaemonSuccessResponse } =
      await import("./runtime-daemon/protocol.js");
    const { createRuntimeDaemonSocketServer } =
      await import("./runtime-daemon/transport.js");
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const endpoint = makeDaemonEndpoint(tempRoot);
    const server = await createRuntimeDaemonSocketServer({
      endpoint,
      createDispatcher: () => ({
        async handle(request) {
          if (request.method === "initialize") {
            return createRuntimeDaemonSuccessResponse(request.id, {
              identity: {
                runtimeId: "endpoint-daemon-runtime",
                mode: "daemon",
                profile: "default",
                startedAt: "2026-07-09T00:00:00.000Z",
                version: "0.7.66",
              },
            });
          }
          if (request.method === "session.create") {
            return createRuntimeDaemonSuccessResponse(request.id, {
              id: "endpoint-daemon-session",
              title: "Endpoint Daemon Session",
            });
          }
          return createRuntimeDaemonSuccessResponse(request.id, {});
        },
        close() {},
      }),
    });
    let runtime: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
    try {
      runtime = await createKodaXRuntime({
        mode: "daemon",
        daemonEndpoint: endpoint,
      });
      const session = await runtime.sessions.create({
        title: "Endpoint Daemon Session",
      });

      expect(runtime.identity).toMatchObject({
        runtimeId: "endpoint-daemon-runtime",
        mode: "daemon",
      });
      expect(session).toEqual({
        id: "endpoint-daemon-session",
        title: "Endpoint Daemon Session",
      });
    } finally {
      await runtime?.close();
      await server.close();
    }
  });

  it("connects daemon-mode SDK clients through the default home/profile endpoint", async () => {
    const { createRuntimeDaemonSuccessResponse } =
      await import("./runtime-daemon/protocol.js");
    const { createRuntimeDaemonSocketServer, defaultRuntimeDaemonEndpoint } =
      await import("./runtime-daemon/transport.js");
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const profile = `sdk-default-${randomUUID()}`;
    const endpoint = defaultRuntimeDaemonEndpoint(profile, tempRoot);
    const requests: Array<{
      readonly method: string;
      readonly params: unknown;
    }> = [];
    const server = await createRuntimeDaemonSocketServer({
      endpoint,
      createDispatcher: () => ({
        async handle(request) {
          requests.push({ method: request.method, params: request.params });
          if (request.method === "initialize") {
            return createRuntimeDaemonSuccessResponse(request.id, {
              identity: {
                runtimeId: "default-endpoint-daemon",
                mode: "daemon",
                profile,
                startedAt: "2026-07-09T00:00:00.000Z",
                version: "0.7.66",
              },
            });
          }
          if (request.method === "session.create") {
            return createRuntimeDaemonSuccessResponse(request.id, {
              id: "default-endpoint-session",
              title: "Default Endpoint Session",
            });
          }
          return createRuntimeDaemonSuccessResponse(request.id, {});
        },
        close() {},
      }),
    });
    let runtime: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
    try {
      runtime = await createKodaXRuntime({
        mode: "daemon",
        homeDir: tempRoot,
        profile,
        autoStartDaemon: false,
      });
      const session = await runtime.sessions.create({
        title: "Default Endpoint Session",
      });

      expect(runtime.identity).toMatchObject({
        runtimeId: "default-endpoint-daemon",
        mode: "daemon",
        profile,
      });
      expect(session.id).toBe("default-endpoint-session");
      expect(requests[0]).toMatchObject({
        method: "initialize",
        params: {
          profile,
          endpoint: endpoint.path,
        },
      });
    } finally {
      await runtime?.close();
      await server.close();
    }
  });

  it("rejects daemon endpoints that report a different profile", async () => {
    const { connectKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const transport: RuntimeDaemonClientTransport = {
      async request(method) {
        expect(method).toBe("initialize");
        return {
          identity: {
            runtimeId: "wrong-profile-runtime",
            mode: "daemon",
            profile: "default",
            startedAt: "2026-07-09T00:00:00.000Z",
            version: "0.7.66",
          },
        };
      },
      subscribe() {
        return { close() {} };
      },
    };

    await expect(
      connectKodaXRuntime({
        profile: "space",
        transport,
      }),
    ).rejects.toThrow(
      "Runtime daemon profile mismatch: expected space, got default",
    );
  });

  it("auto-starts a local daemon host by default for daemon-mode SDK clients", async () => {
    const { connectKodaXRuntime, createKodaXRuntime } =
      await import("@kodax-ai/kodax/runtime");
    const {
      readRuntimeDaemonLockOwner,
      readRuntimeDaemonState,
      resolveRuntimeDaemonPaths,
    } = await import("./runtime-daemon/state.js");
    const sessionsDir = path.join(tempRoot, ".kodax", "sessions");
    const runtime = await createKodaXRuntime({
      mode: "daemon",
      homeDir: tempRoot,
      sessionsDir,
      profile: "sdk-auto",
      defaultProvider: "mock-provider",
    });

    const paths = resolveRuntimeDaemonPaths(tempRoot, "sdk-auto");
    let peer: Awaited<ReturnType<typeof connectKodaXRuntime>> | undefined;
    try {
      const session = await runtime.sessions.create({
        title: "Auto Daemon Session",
        projectPath: tempRoot,
        surface: "sdk",
      });

      expect(runtime.identity).toMatchObject({
        mode: "daemon",
        profile: "sdk-auto",
      });
      expect(session.title).toBe("Auto Daemon Session");
      expect(readRuntimeDaemonState(paths)).toMatchObject({
        runtimeId: runtime.identity.runtimeId,
        profile: "sdk-auto",
        status: "ready",
      });
      expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({
        runtimeId: runtime.identity.runtimeId,
      });

      peer = await connectKodaXRuntime({
        homeDir: tempRoot,
        profile: "sdk-auto",
      });
      await runtime.close();

      expect(readRuntimeDaemonState(paths)).toMatchObject({
        runtimeId: peer.identity.runtimeId,
        status: "ready",
      });
      await expect(peer.status.snapshot()).resolves.toMatchObject({
        runtimeId: runtime.identity.runtimeId,
      });
    } finally {
      await peer?.close();
      await runtime.close();
      await shutdownRuntimeDaemon(tempRoot, "sdk-auto");
    }

    expect(readRuntimeDaemonState(paths)).toBeUndefined();
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toBeUndefined();
  });

  it("uses homeDir as the default session storage root when sessionsDir is omitted", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const embeddedHome = path.join(tempRoot, "embedded-home");
    const daemonHome = path.join(tempRoot, "daemon-home");

    const embedded = await createKodaXRuntime({ homeDir: embeddedHome });
    try {
      const session = await embedded.sessions.create({
        title: "Embedded Home Session",
        projectPath: embeddedHome,
      });
      const listed = await embedded.sessions.list({ limit: 20 });
      expect(listed.map((item) => item.id)).toEqual([session.id]);
      expect(
        (
          await fs.stat(path.join(embeddedHome, ".kodax", "sessions"))
        ).isDirectory(),
      ).toBe(true);
    } finally {
      await embedded.close();
    }

    const daemonProfile = `home-sessions-${randomUUID()}`;
    const daemon = await createKodaXRuntime({
      mode: "daemon",
      homeDir: daemonHome,
      profile: daemonProfile,
      defaultProvider: "mock-provider",
    });
    try {
      const session = await daemon.sessions.create({
        title: "Daemon Home Session",
        projectPath: daemonHome,
      });
      const listed = await daemon.sessions.list({ limit: 20 });
      expect(listed.map((item) => item.id)).toEqual([session.id]);
      expect(
        (
          await fs.stat(path.join(daemonHome, ".kodax", "sessions"))
        ).isDirectory(),
      ).toBe(true);
    } finally {
      await daemon.close();
      await shutdownRuntimeDaemon(daemonHome, daemonProfile);
    }
  });

  it("keeps embedded run memory ownership on the Runtime config home", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const ownerHome = path.join(tempRoot, "embedded-owner");
    const runtime = await createKodaXRuntime({
      homeDir: ownerHome,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Owner Identity Boundary",
      projectPath: ownerHome,
    });
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession =>
        fakeRunningSession(
          options,
          Promise.resolve({
            success: true,
            lastText: "done",
            messages: [],
            sessionId: session.id,
          }),
        ),
    );

    try {
      const attackerConfigHome = path.join(tempRoot, "attacker-home");
      const handle = await runtime.runs.start({
        sessionId: session.id,
        prompt: "keep owner identity",
        options: {
          context: {
            configHome: attackerConfigHome,
            memoryIdentity: {
              configHome: attackerConfigHome,
              tenantId: "attacker-tenant",
              workspaceId: "attacker-workspace",
              agentId: "attacker-agent",
              projectId: "attacker-project",
              sessionId: session.id,
            },
          },
        },
      });
      await handle.result;

      const runOptions = codingMock.startKodaX.mock.calls[0]?.[0];
      expect(runOptions?.context?.configHome).toBe(
        path.join(ownerHome, ".kodax"),
      );
      expect(runOptions?.context?.memoryIdentity).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it("filters Runtime sessions by surface and continues with an opaque cursor", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({ homeDir: tempRoot });
    try {
      await runtime.sessions.create({ title: "ACP One", surface: "acp" });
      await runtime.sessions.create({ title: "REPL One", surface: "repl" });
      await runtime.sessions.create({ title: "ACP Two", surface: "acp" });
      await runtime.sessions.create({ title: "ACP Three", surface: "acp" });

      const firstPage = await runtime.sessions.list({
        surface: "acp",
        limit: 2,
      });
      const cursor = firstPage.at(-1)?.cursor;
      const secondPage = await runtime.sessions.list({
        surface: "acp",
        limit: 2,
        cursor,
      });
      const combined = [...firstPage, ...secondPage];

      expect(cursor).toEqual(expect.any(String));
      expect(new Set(combined.map((session) => session.id)).size).toBe(3);
      expect(combined.every((session) => session.surface === "acp")).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it("shares Space-style SDK control-plane access across daemon clients", async () => {
    const { connectKodaXRuntime, createKodaXRuntime } =
      await import("@kodax-ai/kodax/runtime");
    const profile = `space-${randomUUID()}`;
    const capabilities = {
      richEvents: true,
      permissionPrompts: true,
      configAdmin: true,
      commandCatalog: true,
      skillCatalog: true,
      artifactUpload: true,
      contextDiagnostics: true,
    };
    const space = await createKodaXRuntime({
      mode: "daemon",
      homeDir: tempRoot,
      profile,
      defaultProvider: "mock-provider",
      clientInfo: {
        name: "kodax-space",
        title: "KodaX Space",
        version: "0.1.29",
      },
      capabilities,
    });
    let ide: Awaited<ReturnType<typeof connectKodaXRuntime>> | undefined;

    try {
      ide = await connectKodaXRuntime({
        homeDir: tempRoot,
        profile,
        clientInfo: {
          name: "kodax-ide",
          title: "KodaX IDE Adapter",
          version: "0.1.0",
        },
        capabilities,
      });

      const session = await space.sessions.create({
        title: "Space Shared Session",
        projectPath: tempRoot,
        surface: "space-desktop",
        profileId: "space",
      });
      await fs.writeFile(
        path.join(tempRoot, "space-note.md"),
        "# shared note\n",
        "utf-8",
      );
      const visibleSessions = await ide.sessions.list({ limit: 20 });
      const updated = await ide.sessions.updateSettings(session.id, {
        provider: "mock-provider",
        model: "space-model",
      });
      const settingsFromSpace = await space.sessions.getSettings(session.id);
      const artifact = await ide.artifacts.create({
        kind: "file",
        path: path.join(tempRoot, "space-note.md"),
        name: "space-note.md",
        source: "file-picker",
      });
      const artifactFromSpace = await space.artifacts.get(artifact.id);
      const [providers, commands, skills, latestBudget, status] =
        await Promise.all([
          ide.catalog.providers(),
          ide.catalog.commands(tempRoot),
          ide.catalog.skills({ userInvocableOnly: true }),
          ide.diagnostics.latestContextBudget({ sessionId: session.id }),
          ide.status.snapshot(),
        ]);

      expect(space.identity.runtimeId).toBe(ide.identity.runtimeId);
      expect(visibleSessions.map((item) => item.id)).toContain(session.id);
      expect(updated).toMatchObject({
        provider: "mock-provider",
        model: "space-model",
      });
      expect(settingsFromSpace).toMatchObject({
        provider: "mock-provider",
        model: "space-model",
      });
      expect(artifactFromSpace).toMatchObject({
        id: artifact.id,
        kind: "file",
        name: "space-note.md",
        source: "file-picker",
      });
      expect(Array.isArray(providers)).toBe(true);
      expect(Array.isArray(commands)).toBe(true);
      expect(Array.isArray(skills)).toBe(true);
      expect(latestBudget).toBeNull();
      expect(status.runtimeId).toBe(space.identity.runtimeId);
      expect(status.profile).toBe(profile);
      expect(status.sessions.some((item) => item.id === session.id)).toBe(true);
    } finally {
      await ide?.close();
      await space.close();
      await shutdownRuntimeDaemon(tempRoot, profile);
    }
  });

  it("lets a Space-style daemon client subscribe to permission prompts and resolve another client run", async () => {
    const { connectKodaXRuntime, createKodaXRuntime } =
      await import("@kodax-ai/kodax/runtime");
    const profile = `space-permission-${randomUUID()}`;
    const capabilities = {
      richEvents: true,
      permissionPrompts: true,
      contextDiagnostics: true,
    };
    const worker = await createKodaXRuntime({
      mode: "daemon",
      homeDir: tempRoot,
      profile,
      defaultProvider: "mock-provider",
      clientInfo: {
        name: "kodax-repl",
        title: "KodaX REPL",
        version: "0.7.66",
      },
      capabilities,
    });
    let space: Awaited<ReturnType<typeof connectKodaXRuntime>> | undefined;
    let approvalDone: Promise<unknown> | undefined;
    let responseDone: Promise<boolean> | undefined;
    const seen: string[] = [];

    try {
      space = await connectKodaXRuntime({
        homeDir: tempRoot,
        profile,
        clientInfo: {
          name: "kodax-space",
          title: "KodaX Space",
          version: "0.1.29",
        },
        capabilities,
      });
      const session = await worker.sessions.create({
        title: "Space Permission Session",
        projectPath: tempRoot,
        surface: "space-desktop",
        profileId: "space",
      });

      const permissionSubscription = space.events.subscribe(
        { sessionId: session.id },
        (event) => {
          seen.push(event.type);
          if (event.type !== "permission.requested") return;
          const payload = event.payload;
          if (!isPermissionRequestPayload(payload)) return;
          responseDone = space?.permissions.respond(
            payload.id,
            { type: "allow_once" },
            { runId: payload.runId },
          );
        },
      );
      expect(permissionSubscription.ready).toBeInstanceOf(Promise);
      await permissionSubscription.ready;

      approvalDone = worker.permissions.request({
        sessionId: session.id,
        runId: "run-space-permission",
        turnId: "turn-space-permission",
        toolCallId: "tool-space-permission",
        toolName: "bash",
        inputPreview: '{"command":"echo from space permission"}',
      });
      await expect(
        expectSettles(approvalDone, "space permission approval", 5_000),
      ).resolves.toEqual({
        type: "allow_once",
      });
      if (!responseDone)
        throw new Error("Space permission response was not submitted.");
      await expect(
        expectSettles(responseDone, "space permission response", 5_000),
      ).resolves.toBe(true);
      await flushMicrotasks();

      expect(
        await space.permissions.listPending({ runId: "run-space-permission" }),
      ).toEqual([]);
      expect(seen).toContain("permission.requested");
      expect(seen).toContain("permission.resolved");
      const replay = await space.events.replay({
        runId: "run-space-permission",
        type: ["permission.requested", "permission.resolved"],
      });
      expect(replay.map((event) => event.type)).toEqual([
        "permission.requested",
        "permission.resolved",
      ]);
    } finally {
      await space?.close();
      await worker.close();
      await shutdownRuntimeDaemon(tempRoot, profile);
    }
  });

  it("keeps daemon-mode SDK clients attach-only when autoStartDaemon is false", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const {
      readRuntimeDaemonLockOwner,
      readRuntimeDaemonState,
      resolveRuntimeDaemonPaths,
    } = await import("./runtime-daemon/state.js");
    const profile = `sdk-no-auto-${randomUUID()}`;
    const paths = resolveRuntimeDaemonPaths(tempRoot, profile);

    await expect(
      createKodaXRuntime({
        mode: "daemon",
        homeDir: tempRoot,
        profile,
        autoStartDaemon: false,
      }),
    ).rejects.toThrow();

    expect(readRuntimeDaemonState(paths)).toBeUndefined();
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toBeUndefined();
  });

  it("creates an auto-ID Session without an all-project negative lookup", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const sessionsDir = path.join(tempRoot, "generated-session-store");
    await Promise.all(Array.from({ length: 300 }, (_, index) =>
      fs.mkdir(path.join(sessionsDir, `unrelated-project-${index}`), { recursive: true })));
    const runtime = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir });
    const readdir = vi.spyOn(nodeFsPromises, "readdir");
    try {
      await expect(runtime.sessions.create({ title: "No global negative lookup" }))
        .resolves.toMatchObject({ title: "No global negative lookup" });
      expect(readdir.mock.calls.filter(
        ([candidate]) => path.resolve(String(candidate)) === path.resolve(sessionsDir),
      )).toHaveLength(0);
    } finally {
      readdir.mockRestore();
      await runtime.close();
    }
  });

  it("creates, lists, loads, transcripts, and forks sessions through one runtime service", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({ sessionsDir: tempRoot });
    const seen: string[] = [];
    runtime.events.subscribe({}, (event) => seen.push(event.type));

    const session = await runtime.sessions.create({
      title: "Runtime Test",
      projectPath: tempRoot,
      surface: "sdk",
      profileId: "coder",
    });
    const listed = await runtime.sessions.list({ limit: 10 });
    const loaded = await runtime.sessions.load(session.id);
    const transcript = await runtime.sessions.transcript(session.id);
    const forked = await runtime.sessions.fork({
      sessionId: session.id,
      title: "Runtime Fork",
    });

    expect(session.title).toBe("Runtime Test");
    expect(session.workspaceRoot).toBe(path.resolve(tempRoot));
    expect(listed.map((item) => item.id)).toContain(session.id);
    expect(loaded.id).toBe(session.id);
    expect(transcript?.transcriptEntries).toEqual([]);
    expect(forked?.title).toBe("Runtime Fork");
    expect(seen.filter((type) => type === "session.created")).toHaveLength(2);

    await runtime.close();
  }, 60_000);

  it("isolates event listener failures from runtime operations and other subscribers", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({ homeDir: tempRoot });
    const received: string[] = [];
    runtime.events.subscribe({}, () => {
      throw new Error("consumer boom");
    });
    runtime.events.subscribe({}, (event) => {
      received.push(event.type);
    });

    const session = await runtime.sessions.create({
      title: "Listener Isolation",
    });

    expect(session.title).toBe("Listener Isolation");
    expect(received).toEqual(["session.created"]);
    await expect(
      runtime.events.replay({ sessionId: session.id }),
    ).resolves.toEqual([expect.objectContaining({ type: "session.created" })]);
    await runtime.close();
  });

  it("persists session settings and applies them as run defaults", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const sessionsDir = path.join(tempRoot, "sessions");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: "fallback-provider",
      defaultModel: "fallback-model",
    });
    const session = await runtime.sessions.create({ title: "Settings Test" });
    const settingsEvents: unknown[] = [];
    const effectiveConfigs: unknown[] = [];
    runtime.events.subscribe({ sessionId: session.id }, (event) => {
      if (event.type === "session.settings.updated")
        settingsEvents.push(event.payload);
      if (event.type === "config.effective")
        effectiveConfigs.push(event.payload);
    });
    const shellExecution = {
      version: 1 as const,
      shell: { kind: "pwsh" as const, profile: "none" as const },
      environment: { inherit: "filtered" as const },
      cache: { ttlMs: 30_000, refreshToken: "settings-v1" },
    };

    const settings = await runtime.sessions.updateSettings(session.id, {
      provider: "settings-provider",
      model: "settings-model",
      effort: "high",
      thinking: true,
      reasoningMode: "balanced",
      permissionMode: "accept-edits",
      executionCwd: path.resolve(tempRoot),
      shellExecution,
      autoModeClassifierModel: "mock-provider:classifier-model",
      autoModeTimeoutMs: 20_000,
      autoModeSpeculativeWindowMs: 0,
      compactionTriggerPercent: 110,
      compactionTriggerTokens: 120_000,
    });
    expect(settings).toMatchObject({
      provider: "settings-provider",
      model: "settings-model",
      effort: "high",
      thinking: true,
      reasoningMode: "balanced",
      permissionMode: "accept-edits",
      executionCwd: path.resolve(tempRoot),
      shellExecution,
      autoModeClassifierModel: "mock-provider:classifier-model",
      autoModeTimeoutMs: 20_000,
      autoModeSpeculativeWindowMs: 0,
      compactionTriggerPercent: 90,
      compactionTriggerTokens: 120_000,
    });
    await expect(
      runtime.sessions.updateSettings(session.id, { autoModeTimeoutMs: 0 }),
    ).rejects.toThrow(/positive safe integer/);
    await expect(
      runtime.sessions.updateSettings(session.id, {
        autoModeSpeculativeWindowMs: -1,
      }),
    ).rejects.toThrow(/non-negative safe integer/);
    await expect(
      runtime.sessions.updateSettings(session.id, {
        compactionTriggerTokens: -1,
      }),
    ).rejects.toThrow(/positive safe integer or zero/);
    await expect(
      runtime.sessions.getSettings(session.id),
    ).resolves.toMatchObject({
      autoModeTimeoutMs: 20_000,
      autoModeSpeculativeWindowMs: 0,
      compactionTriggerPercent: 90,
      compactionTriggerTokens: 120_000,
    });

    let capturedOptions: KodaXOptions | undefined;
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        capturedOptions = options;
        return fakeRunningSession(
          options,
          Promise.resolve({
            success: true,
            lastText: "settings done",
            messages: [],
            sessionId: session.id,
          }),
        );
      },
    );

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "uses settings",
    });
    await handle.result;

    expect(capturedOptions).toMatchObject({
      provider: "settings-provider",
      modelOverride: "settings-model",
      effort: "high",
      thinking: true,
      reasoningMode: "balanced",
      compaction: {
        triggerPercent: 90,
        triggerTokens: 120_000,
      },
      context: { executionCwd: path.resolve(tempRoot), shellExecution },
    });

    capturedOptions = undefined;
    const inheritedHandle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "inherits settings through explicit undefined",
      options: { context: { shellExecution: undefined } },
    });
    await inheritedHandle.result;
    expect(capturedOptions?.context?.shellExecution).toEqual(shellExecution);

    expect(settingsEvents).toHaveLength(1);
    expect(effectiveConfigs[0]).toMatchObject({
      provider: "settings-provider",
      model: "settings-model",
      effort: "high",
      thinking: true,
      reasoningMode: "balanced",
      permissionMode: "accept-edits",
      executionCwd: path.resolve(tempRoot),
      shellKind: "pwsh",
      shellExecutionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      autoModeClassifierModel: "mock-provider:classifier-model",
      autoModeTimeoutMs: 20_000,
      autoModeSpeculativeWindowMs: 0,
      compactionTriggerPercent: 90,
      compactionTriggerTokens: 120_000,
    });

    await runtime.close();

    const recreated = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: "fallback-provider",
    });
    await expect(
      recreated.sessions.getSettings(session.id),
    ).resolves.toMatchObject({
      provider: "settings-provider",
      model: "settings-model",
      permissionMode: "accept-edits",
      shellExecution,
      autoModeSpeculativeWindowMs: 0,
      compactionTriggerPercent: 90,
      compactionTriggerTokens: 120_000,
    });
    await expect(
      recreated.sessions.updateSettings(session.id, {
        compactionTriggerPercent: -5,
        compactionTriggerTokens: 0,
      }),
    ).resolves.toMatchObject({
      compactionTriggerPercent: 15,
    });
    await expect(
      recreated.sessions.getSettings(session.id),
    ).resolves.not.toHaveProperty("compactionTriggerTokens");
    await recreated.close();
  });

  it("keeps 0.7.x compatibility aliases without restoring retired AMAW behavior", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Compatibility Aliases",
    });
    await runtime.sessions.updateSettings(session.id, { agentMode: "amaw" });
    let effectiveAgentMode: unknown;
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        effectiveAgentMode = options.agentMode;
        return fakeRunningSession(
          options,
          Promise.resolve({
            success: true,
            lastText: "done",
            messages: [],
            sessionId: session.id,
          }),
        );
      },
    );

    await (
      await runtime.runs.start({ sessionId: session.id, prompt: "compat" })
    ).result;
    expect(effectiveAgentMode).toBe("ama");
    const preflight = await runtime.status.preflight();
    // Compile-time compatibility: 0.7.x consumers may access the legacy
    // property without an undefined guard.
    const legacyTasks: readonly unknown[] = preflight.activeAgentTasks;
    expect(legacyTasks).toBe(preflight.activeAgentTurns);
    await runtime.close();
  });

  it("hides exit_plan_mode when a Runtime run has no approval callback", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Plan Bridge Test",
    });
    const capturedOptions: KodaXOptions[] = [];
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        capturedOptions.push(options);
        return fakeRunningSession(
          options,
          Promise.resolve({
            success: true,
            lastText: "done",
            messages: [],
            sessionId: session.id,
          }),
        );
      },
    );

    await (
      await runtime.runs.start({
        sessionId: session.id,
        prompt: "plan without a bridge",
        options: { context: { excludeTools: ["caller_tool"] } },
      })
    ).result;
    await (
      await runtime.runs.start({
        sessionId: session.id,
        prompt: "plan with a bridge",
        options: {
          context: { excludeTools: ["caller_tool"] },
          events: { exitPlanMode: async () => true },
        },
      })
    ).result;

    expect(capturedOptions[0]?.context?.excludeTools).toEqual([
      "caller_tool",
      "exit_plan_mode",
    ]);
    expect(capturedOptions[1]?.context?.excludeTools).toEqual(["caller_tool"]);
    await runtime.close();
  });

  it("keeps session executionCwd settings inside the session workspace root", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const projectRoot = path.join(tempRoot, "project");
    const outsideRoot = path.join(tempRoot, "outside");
    const dotPrefixedDirectory = path.join(projectRoot, "..cache");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.mkdir(dotPrefixedDirectory, { recursive: true });
    const sessionsDir = path.join(tempRoot, "sessions");
    const runtime = await createKodaXRuntime({
      sessionsDir,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Workspace Settings Test",
      projectPath: projectRoot,
    });

    await expect(
      runtime.sessions.updateSettings(session.id, {
        executionCwd: projectRoot,
      }),
    ).resolves.toMatchObject({ executionCwd: path.resolve(projectRoot) });
    await expect(
      runtime.sessions.updateSettings(session.id, {
        executionCwd: dotPrefixedDirectory,
      }),
    ).resolves.toMatchObject({
      executionCwd: path.resolve(dotPrefixedDirectory),
    });
    await expect(
      runtime.sessions.updateSettings(session.id, {
        executionCwd: outsideRoot,
      }),
    ).rejects.toThrow(
      "executionCwd must stay within the session workspace root",
    );
    await expect(
      runtime.runs.start({
        sessionId: session.id,
        prompt: "blocked run cwd override",
        options: { context: { executionCwd: outsideRoot } },
      }),
    ).rejects.toThrow(
      "executionCwd must stay within the session workspace root",
    );
    await expect(
      runtime.runs.start({
        sessionId: session.id,
        prompt: "blocked run boundary override",
        options: { context: { gitRoot: outsideRoot } },
      }),
    ).rejects.toThrow(
      "gitRoot must match the session repository safety boundary",
    );
    await fs.writeFile(
      path.join(
        tempRoot,
        ".kodax",
        "runtime",
        "session-settings",
        `${encodeURIComponent(session.id)}.json`,
      ),
      JSON.stringify({ executionCwd: outsideRoot }),
      "utf-8",
    );
    await expect(
      runtime.runs.start({
        sessionId: session.id,
        prompt: "blocked by workspace root",
      }),
    ).rejects.toThrow(
      "executionCwd must stay within the session workspace root",
    );

    await runtime.close();
  });

  it("skips corrupted runtime persistence records and exposes runtime warnings", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const badRunDir = path.join(
      tempRoot,
      ".kodax",
      "runtime",
      "runs",
      "bad-run",
    );
    const settingsDir = path.join(
      tempRoot,
      ".kodax",
      "runtime",
      "session-settings",
    );
    await fs.mkdir(badRunDir, { recursive: true });
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(
      path.join(badRunDir, "status.json"),
      "{bad status",
      "utf-8",
    );
    await fs.writeFile(
      path.join(badRunDir, "events.jsonl"),
      '{"id":"evt_bad","seq":1}\nnot-json\n',
      "utf-8",
    );
    await fs.writeFile(
      path.join(settingsDir, "corrupt-session.json"),
      "{bad settings",
      "utf-8",
    );

    const runtime = await createKodaXRuntime({ homeDir: tempRoot });

    await expect(runtime.runs.list()).resolves.toEqual([]);
    await runtime.sessions.create({ sessionId: "corrupt-session" });
    await expect(
      runtime.sessions.getSettings("corrupt-session"),
    ).resolves.toEqual({});
    const warnings = await runtime.events.replay({ type: "runtime.warning" });
    const messages = warnings.map(
      (event) => (event.payload as { readonly message?: string }).message ?? "",
    );
    expect(
      messages.some((message) => message.includes("runtime status record")),
    ).toBe(true);
    expect(
      messages.some((message) => message.includes("runtime event record")),
    ).toBe(true);
    expect(
      messages.some((message) => message.includes("runtime session settings")),
    ).toBe(true);

    await runtime.close();
  });

  it("migrates run statuses once and bounds later startup reads to the durable index", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtimeDir = path.join(tempRoot, ".kodax", "runtime");
    const runsDir = path.join(runtimeDir, "runs");
    const statusCount = 230;
    await Promise.all(Array.from({ length: statusCount }, async (_, index) => {
      const runId = `indexed-terminal-${String(index).padStart(3, "0")}`;
      const dir = path.join(runsDir, runId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "status.json"), JSON.stringify({
        runId,
        sessionId: "indexed-session",
        phase: "completed",
        startedAt: "2026-07-09T00:00:00.000Z",
        endedAt: "2026-07-09T00:01:00.000Z",
        provider: "mock-provider",
      }), "utf-8");
    }));

    const migrated = await createKodaXRuntime({ homeDir: tempRoot });
    await migrated.close();
    const index = JSON.parse(await fs.readFile(
      path.join(runtimeDir, "run-status-index.json"),
      "utf-8",
    )) as { readonly activeRunIds: readonly string[]; readonly recentRunIds: readonly string[] };
    expect(index.activeRunIds).toEqual([]);
    expect(index.recentRunIds).toHaveLength(200);

    const originalReadFileSync = mutableNodeFs.readFileSync;
    const statusReads: string[] = [];
    mutableNodeFs.readFileSync = ((file, options) => {
      if (String(file).endsWith(`${path.sep}status.json`)) statusReads.push(String(file));
      return originalReadFileSync(file, options);
    }) as typeof nodeFs.readFileSync;
    syncBuiltinESMExports();
    let restarted: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
    let startupStatusReads = 0;
    try {
      restarted = await createKodaXRuntime({ homeDir: tempRoot });
      startupStatusReads = statusReads.length;
      await expect(restarted.runs.list()).resolves.toHaveLength(200);
      await expect(restarted.runs.get("indexed-terminal-000")).resolves.toMatchObject({
        runId: "indexed-terminal-000",
        phase: "completed",
      });
    } finally {
      mutableNodeFs.readFileSync = originalReadFileSync;
      syncBuiltinESMExports();
      await restarted?.close();
    }
    expect(startupStatusReads).toBe(200);
  });

  it("rebuilds a run-status index when a legacy writer publishes an unindexed active Run", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runsDir = path.join(tempRoot, ".kodax", "runtime", "runs");
    const preexistingRunId = "legacy-active-in-preexisting-dir";
    const newRunId = "legacy-active-in-new-dir";
    await fs.mkdir(path.join(runsDir, preexistingRunId), { recursive: true });

    const indexed = await createKodaXRuntime({ homeDir: tempRoot });
    await indexed.close();

    const writeLegacyStatus = async (runId: string): Promise<void> => {
      const dir = path.join(runsDir, runId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "status.json"), JSON.stringify({
        runId,
        sessionId: "legacy-active-session",
        phase: "running",
        startedAt: "2026-07-09T00:00:00.000Z",
        provider: "mock-provider",
      }), "utf-8");
    };
    await writeLegacyStatus(preexistingRunId);
    await writeLegacyStatus(newRunId);

    const restarted = await createKodaXRuntime({ homeDir: tempRoot });
    try {
      await expect(restarted.runs.list()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ runId: preexistingRunId }),
        expect.objectContaining({ runId: newRunId }),
      ]));
    } finally {
      await restarted.close();
    }
  });

  it("recovers a committed Run when its later index update is interrupted", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const sessionId = "status-before-index-session";
    const seeded = await createKodaXRuntime({ homeDir: tempRoot });
    await seeded.sessions.create({ sessionId });
    await seeded.close();

    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    const runStatusIndexFile = path.join(
      tempRoot,
      ".kodax",
      "runtime",
      "run-status-index.json",
    );
    const renameSync = mutableNodeFs.renameSync;
    let interruptions = 0;
    mutableNodeFs.renameSync = ((source, destination) => {
      if (String(destination) === runStatusIndexFile) {
        interruptions += 1;
        throw Object.assign(new Error("synthetic index commit interruption"), {
          code: "EIO",
        });
      }
      return renameSync(source, destination);
    }) as typeof nodeFs.renameSync;
    syncBuiltinESMExports();
    try {
      await expect(runtime.runs.start({
        sessionId,
        prompt: "persist before indexing",
      })).rejects.toThrow("Failed to persist running Runtime run");
    } finally {
      mutableNodeFs.renameSync = renameSync;
      syncBuiltinESMExports();
      await runtime.close();
    }
    expect(interruptions).toBeGreaterThan(0);

    const restarted = await createKodaXRuntime({ homeDir: tempRoot });
    try {
      await expect(restarted.runs.list({ sessionId })).resolves.toEqual([
        expect.objectContaining({ sessionId, phase: "failed" }),
      ]);
    } finally {
      await restarted.close();
    }
  });

  it("marks a clean run-status index dirty before a recovered Run becomes terminal", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtimeDir = path.join(tempRoot, ".kodax", "runtime");
    const runId = "clean-index-recovered-terminal";
    const seeded = await createKodaXRuntime({ homeDir: tempRoot });
    await seeded.close();

    const runDir = path.join(runtimeDir, "runs", runId);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, "status.json"), JSON.stringify({
      runId,
      sessionId: "clean-index-recovery-session",
      phase: "running",
      startedAt: "2026-07-09T00:00:00.000Z",
      provider: "mock-provider",
      _runtime: {
        revision: 1,
        owner: {
          ownerId: "dead-clean-index-owner",
          runtimeId: "dead-clean-index-runtime",
          pid: 2147483647,
          startedAt: "2026-07-09T00:00:00.000Z",
        },
      },
    }), "utf-8");

    const recovered = await createKodaXRuntime({ homeDir: tempRoot });
    let restarted: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
    try {
      const dirtyIndex = JSON.parse(await fs.readFile(
        path.join(runtimeDir, "run-status-index.json"),
        "utf-8",
      )) as { readonly requiresRescan?: unknown };
      expect(dirtyIndex.requiresRescan).toBe(true);

      restarted = await createKodaXRuntime({ homeDir: tempRoot });
      await expect(restarted.runs.get(runId)).resolves.toMatchObject({
        runId,
        phase: "interrupted",
      });
    } finally {
      await restarted?.close();
      await recovered.close();
    }
  });

  it("re-marks the run-status index dirty after another Runtime cleans it", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runStatusIndexFile = path.join(
      tempRoot,
      ".kodax",
      "runtime",
      "run-status-index.json",
    );
    const first = await createKodaXRuntime({
      homeDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    const session = await first.sessions.create({
      sessionId: "cross-runtime-index-session",
    });
    let finishRun: ((value: KodaXResult) => void) | undefined;
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => fakeRunningSession(
        options,
        new Promise<KodaXResult>((resolve) => {
          finishRun = resolve;
        }),
      ),
    );
    const handle = await first.runs.start({
      sessionId: session.id,
      prompt: "cross-runtime dirty witness",
    });
    let second: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
    let restarted: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
    try {
      second = await createKodaXRuntime({ homeDir: tempRoot });
      await second.close();
      second = undefined;
      const cleanIndex = JSON.parse(await fs.readFile(
        runStatusIndexFile,
        "utf-8",
      )) as { readonly requiresRescan?: unknown };
      expect(cleanIndex.requiresRescan).toBe(false);

      const statSync = mutableNodeFs.statSync;
      let lockedIndexIdentityChecks = 0;
      let unlockedIndexIdentityChecks = 0;
      mutableNodeFs.statSync = ((file, options) => {
        if (String(file) === runStatusIndexFile) {
          if (nodeFs.existsSync(`${runStatusIndexFile}.lock`)) {
            lockedIndexIdentityChecks += 1;
          } else {
            unlockedIndexIdentityChecks += 1;
          }
        }
        return statSync(file, options);
      }) as typeof nodeFs.statSync;
      syncBuiltinESMExports();
      try {
        finishRun?.({
          success: true,
          lastText: "done",
          messages: [],
          sessionId: session.id,
        });
        await handle.result;
      } finally {
        mutableNodeFs.statSync = statSync;
        syncBuiltinESMExports();
      }
      expect(lockedIndexIdentityChecks).toBeGreaterThan(0);
      expect(unlockedIndexIdentityChecks).toBe(0);
      const dirtyIndex = JSON.parse(await fs.readFile(
        runStatusIndexFile,
        "utf-8",
      )) as { readonly requiresRescan?: unknown };
      expect(dirtyIndex.requiresRescan).toBe(true);

      restarted = await createKodaXRuntime({ homeDir: tempRoot });
      await expect(restarted.runs.get(handle.runId)).resolves.toMatchObject({
        runId: handle.runId,
        phase: "completed",
      });
    } finally {
      finishRun?.({
        success: false,
        error: "test cleanup",
        messages: [],
        sessionId: session.id,
      });
      await second?.close();
      await restarted?.close();
      await first.close();
    }
  });

  it("performs one fail-closed scan for a stable overflow of pending legacy Runs", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runsDir = path.join(tempRoot, ".kodax", "runtime", "runs");
    await Promise.all(Array.from({ length: 1_001 }, (_, index) =>
      fs.mkdir(path.join(runsDir, `pending-${index}`), { recursive: true })));

    const readdirSync = mutableNodeFs.readdirSync;
    let runsDirectoryReads = 0;
    mutableNodeFs.readdirSync = ((directory, options) => {
      if (String(directory) === runsDir) runsDirectoryReads += 1;
      return readdirSync(directory, options);
    }) as typeof nodeFs.readdirSync;
    syncBuiltinESMExports();
    let runtime: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
    try {
      runtime = await createKodaXRuntime({ homeDir: tempRoot });
    } finally {
      mutableNodeFs.readdirSync = readdirSync;
      syncBuiltinESMExports();
      await runtime?.close();
    }
    expect(runsDirectoryReads).toBe(1);

    const index = JSON.parse(await fs.readFile(
      path.join(tempRoot, ".kodax", "runtime", "run-status-index.json"),
      "utf-8",
    )) as { readonly requiresRescan?: unknown };
    expect(index.requiresRescan).toBe(true);
  });

  it("does not reclaim an old Runtime lock while its owner PID is alive", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtimeDir = path.join(tempRoot, ".kodax", "runtime");
    const lockFile = path.join(runtimeDir, "event-sequence.lock");
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(lockFile, JSON.stringify({
      pid: process.pid,
      createdAt: Date.now() - 60_000,
      token: "live-owner",
    }), "utf-8");

    const runtime = await createKodaXRuntime({ homeDir: tempRoot });
    await runtime.sessions.create({
      sessionId: "live-lock-must-not-be-stolen",
    });
    await expect(runtime.events.replay({
      sessionId: "live-lock-must-not-be-stolen",
    })).rejects.toThrow("Runtime status lock timed out");
    await expect(fs.stat(lockFile)).resolves.toBeDefined();
    await fs.rm(lockFile, { force: true });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await expect(fs.stat(path.join(runtimeDir, "event-sequence")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(runtime.events.replay({
      sessionId: "live-lock-must-not-be-stolen",
    })).resolves.toHaveLength(1);
    await runtime.close();
  });

  it("keeps an acquired lock usable when candidate cleanup is deferred", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({ homeDir: tempRoot });
    const rmSync = mutableNodeFs.rmSync;
    let cleanupFailed = false;
    mutableNodeFs.rmSync = ((file, options) => {
      if (
        !cleanupFailed
        && String(file).includes("event-sequence.lock.candidate.")
      ) {
        cleanupFailed = true;
        throw new Error("synthetic candidate cleanup failure");
      }
      return rmSync(file, options);
    }) as typeof nodeFs.rmSync;
    syncBuiltinESMExports();

    try {
      await expect(runtime.sessions.create({
        sessionId: "candidate-cleanup-deferred",
      })).resolves.toMatchObject({ id: "candidate-cleanup-deferred" });
    } finally {
      mutableNodeFs.rmSync = rmSync;
      syncBuiltinESMExports();
    }

    expect(cleanupFailed).toBe(true);
    const runtimeDir = path.join(tempRoot, ".kodax", "runtime");
    await expect(fs.stat(path.join(runtimeDir, "event-sequence.lock")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(runtime.events.replay({
      sessionId: "candidate-cleanup-deferred",
    })).resolves.toHaveLength(1);
    await runtime.sessions.create({ sessionId: "candidate-cleanup-retry" });
    expect((await fs.readdir(runtimeDir)).some((name) => (
      name.includes("event-sequence.lock.candidate.")
    ))).toBe(false);
    await runtime.close();
  });

  it("bounds orphan candidates when candidate cleanup keeps failing", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({ homeDir: tempRoot });
    const runtimeDir = path.join(tempRoot, ".kodax", "runtime");
    const rmSync = mutableNodeFs.rmSync;
    let rejectedCandidateRemovals = 0;
    mutableNodeFs.rmSync = ((file, options) => {
      if (String(file).includes("event-sequence.lock.candidate.")) {
        rejectedCandidateRemovals += 1;
        throw new Error("persistent candidate cleanup failure");
      }
      return rmSync(file, options);
    }) as typeof nodeFs.rmSync;
    syncBuiltinESMExports();

    try {
      for (let index = 0; index < 3; index += 1) {
        await runtime.sessions.create({
          sessionId: `persistent-candidate-cleanup-${index}`,
        });
      }
      expect((await fs.readdir(runtimeDir)).filter((name) => (
        name.includes("event-sequence.lock.candidate.")
      ))).toHaveLength(1);
      expect(rejectedCandidateRemovals).toBeGreaterThan(1);
    } finally {
      mutableNodeFs.rmSync = rmSync;
      syncBuiltinESMExports();
    }

    await runtime.sessions.create({
      sessionId: "persistent-candidate-cleanup-recovered",
    });
    expect((await fs.readdir(runtimeDir)).filter((name) => (
      name.includes("event-sequence.lock.candidate.")
    ))).toHaveLength(0);
    await runtime.close();
  });

  it("does not create a new candidate beside an unremovable prior-process candidate", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtimeDir = path.join(tempRoot, ".kodax", "runtime");
    const lockFile = path.join(runtimeDir, "event-sequence.lock");
    const candidate = `${lockFile}.candidate.2147483647.00000000-0000-4000-8000-000000000001`;
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(candidate, JSON.stringify({
      pid: 2_147_483_647,
      createdAt: Date.now() - 60_000,
      token: "prior-process-candidate",
    }), "utf-8");
    const runtime = await createKodaXRuntime({ homeDir: tempRoot });
    const rmSync = mutableNodeFs.rmSync;
    mutableNodeFs.rmSync = ((file, options) => {
      if (String(file).includes("event-sequence.lock.candidate.")) {
        throw new Error("persistent prior-process candidate cleanup failure");
      }
      return rmSync(file, options);
    }) as typeof nodeFs.rmSync;
    syncBuiltinESMExports();

    try {
      await expect(runtime.sessions.create({
        sessionId: "prior-process-candidate-bound",
      })).resolves.toMatchObject({ id: "prior-process-candidate-bound" });
      expect((await fs.readdir(runtimeDir)).filter((name) => (
        name.includes("event-sequence.lock.candidate.")
      ))).toHaveLength(1);
    } finally {
      mutableNodeFs.rmSync = rmSync;
      syncBuiltinESMExports();
      await fs.rm(candidate, { force: true });
    }

    await runtime.close();
  });

  it("removes a published bakery claim when atomic-writer cleanup fails", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtimeDir = path.join(tempRoot, ".kodax", "runtime");
    const lockFile = path.join(runtimeDir, "event-sequence.lock");
    await fs.mkdir(runtimeDir, { recursive: true });
    const runtime = await createKodaXRuntime({ homeDir: tempRoot });
    const staleChoosing = `${lockFile}.choosing.00000000-0000-4000-8000-000000000001`;
    await fs.writeFile(staleChoosing, JSON.stringify({
      pid: 2_147_483_647,
      createdAt: Date.now(),
      token: "dead-chooser-before-claim-cleanup",
    }), "utf-8");
    const renameSync = mutableNodeFs.renameSync;
    let claimCleanupFailed = false;
    mutableNodeFs.renameSync = ((oldPath, newPath) => {
      renameSync(oldPath, newPath);
      if (
        !claimCleanupFailed
        && String(newPath).includes("event-sequence.lock.claim.")
      ) {
        claimCleanupFailed = true;
        throw new Error("synthetic published-claim writer failure");
      }
    }) as typeof nodeFs.renameSync;
    syncBuiltinESMExports();

    try {
      await runtime.sessions.create({
        sessionId: "published-claim-cleanup-failure",
      });
      expect(claimCleanupFailed).toBe(true);
    } finally {
      mutableNodeFs.renameSync = renameSync;
      syncBuiltinESMExports();
    }

    expect(claimCleanupFailed).toBe(true);
    expect((await fs.readdir(runtimeDir)).some((name) => (
      name.includes("event-sequence.lock.claim.")
    ))).toBe(false);
    await expect(runtime.events.replay({
      sessionId: "published-claim-cleanup-failure",
    })).resolves.toHaveLength(1);
    expect((await fs.readdir(runtimeDir)).some((name) => (
      name.includes("event-sequence.lock.claim.")
      || name.includes("event-sequence.lock.choosing.")
    ))).toBe(false);
    await expect(runtime.sessions.create({
      sessionId: "after-published-claim-cleanup",
    })).resolves.toMatchObject({ id: "after-published-claim-cleanup" });
    await runtime.close();
  });

  it("falls back to exclusive lock creation when hard links are unavailable", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({ homeDir: tempRoot });
    const linkSync = mutableNodeFs.linkSync;
    let fallbackUsed = false;
    mutableNodeFs.linkSync = ((_existingPath, _newPath) => {
      fallbackUsed = true;
      throw Object.assign(new Error("hard links unavailable"), { code: "EPERM" });
    }) as typeof nodeFs.linkSync;
    syncBuiltinESMExports();

    try {
      await expect(runtime.sessions.create({
        sessionId: "hard-link-fallback",
      })).resolves.toMatchObject({ id: "hard-link-fallback" });
    } finally {
      mutableNodeFs.linkSync = linkSync;
      syncBuiltinESMExports();
    }

    expect(fallbackUsed).toBe(true);
    await expect(runtime.events.replay({
      sessionId: "hard-link-fallback",
    })).resolves.toHaveLength(1);
    await runtime.close();
  });

  it("reclaims its malformed fallback lock by file identity after write cleanup fails", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({ homeDir: tempRoot });
    const lockFile = path.join(
      tempRoot,
      ".kodax",
      "runtime",
      "event-sequence.lock",
    );
    const openSync = mutableNodeFs.openSync;
    const writeFileSync = mutableNodeFs.writeFileSync;
    const linkSync = mutableNodeFs.linkSync;
    const rmSync = mutableNodeFs.rmSync;
    let fallbackDescriptor: number | undefined;
    let fallbackCleanupFailed = false;
    mutableNodeFs.openSync = ((file, flags, mode) => {
      const descriptor = openSync(file, flags, mode);
      if (String(file) === lockFile && flags === "wx") {
        fallbackDescriptor = descriptor;
      }
      return descriptor;
    }) as typeof nodeFs.openSync;
    mutableNodeFs.writeFileSync = ((file, data, options) => {
      if (file === fallbackDescriptor) {
        throw new Error("synthetic fallback record write failure");
      }
      return writeFileSync(file, data, options);
    }) as typeof nodeFs.writeFileSync;
    mutableNodeFs.linkSync = (() => {
      throw Object.assign(new Error("hard links unavailable"), { code: "EPERM" });
    }) as typeof nodeFs.linkSync;
    mutableNodeFs.rmSync = ((file, options) => {
      if (!fallbackCleanupFailed && String(file) === lockFile) {
        fallbackCleanupFailed = true;
        throw new Error("synthetic fallback cleanup failure");
      }
      return rmSync(file, options);
    }) as typeof nodeFs.rmSync;
    syncBuiltinESMExports();

    try {
      await expect(runtime.sessions.create({
        sessionId: "malformed-fallback-first-attempt",
      })).resolves.toMatchObject({ id: "malformed-fallback-first-attempt" });
    } finally {
      mutableNodeFs.openSync = openSync;
      mutableNodeFs.writeFileSync = writeFileSync;
      mutableNodeFs.linkSync = linkSync;
      mutableNodeFs.rmSync = rmSync;
      syncBuiltinESMExports();
    }

    expect(fallbackCleanupFailed).toBe(true);
    await expect(runtime.events.replay({
      sessionId: "malformed-fallback-first-attempt",
    })).resolves.toHaveLength(1);
    await expect(runtime.sessions.create({
      sessionId: "malformed-fallback-recovered",
    })).resolves.toMatchObject({ id: "malformed-fallback-recovered" });
    await expect(fs.stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
    await runtime.close();
  });

  it("reclaims a reclaim gate after its owner is definitely gone", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtimeDir = path.join(tempRoot, ".kodax", "runtime");
    const lockFile = path.join(runtimeDir, "event-sequence.lock");
    const reclaimFile = `${lockFile}.reclaim`;
    const cleanupFile = `${reclaimFile}.cleanup`;
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(reclaimFile, JSON.stringify({
      pid: 2_147_483_647,
      createdAt: Date.now() - 60_000,
      token: "crashed-reclaimer",
    }), "utf-8");
    await fs.writeFile(cleanupFile, JSON.stringify({
      pid: 2_147_483_646,
      createdAt: Date.now() - 60_000,
      token: "crashed-reclaim-cleaner",
    }), "utf-8");

    const runtime = await createKodaXRuntime({ homeDir: tempRoot });
    await expect(runtime.sessions.create({
      sessionId: "stale-reclaim-gate",
    })).resolves.toMatchObject({ id: "stale-reclaim-gate" });
    await expect(runtime.events.replay({
      sessionId: "stale-reclaim-gate",
    })).resolves.toHaveLength(1);
    await expect(fs.stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(reclaimFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(cleanupFile)).rejects.toMatchObject({ code: "ENOENT" });
    await runtime.close();
  });

  it("fails closed for an old malformed Runtime lock", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtimeDir = path.join(tempRoot, ".kodax", "runtime");
    const lockFile = path.join(runtimeDir, "event-sequence.lock");
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(lockFile, "not-json", "utf-8");
    const stale = new Date(Date.now() - 31_000);
    await fs.utimes(lockFile, stale, stale);

    const runtime = await createKodaXRuntime({ homeDir: tempRoot });
    await runtime.sessions.create({ sessionId: "malformed-stale-lock" });
    await expect(runtime.events.replay({
      sessionId: "malformed-stale-lock",
    })).rejects.toThrow("Runtime status lock timed out");
    await expect(fs.readFile(lockFile, "utf-8")).resolves.toBe("not-json");
    await fs.rm(lockFile, { force: true });
    await expect(runtime.events.replay({
      sessionId: "malformed-stale-lock",
    })).resolves.toHaveLength(1);
    await runtime.close();
  });

  it("reclaims a Runtime lock only after its owner is definitely gone", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtimeDir = path.join(tempRoot, ".kodax", "runtime");
    const lockFile = path.join(runtimeDir, "event-sequence.lock");
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(lockFile, JSON.stringify({
      pid: 2_147_483_647,
      createdAt: Date.now(),
      token: "dead-owner",
      processStartIdentity: "gone:identity",
    }), "utf-8");

    const runtime = await createKodaXRuntime({ homeDir: tempRoot });
    await expect(runtime.sessions.create({
      sessionId: "dead-lock-recovery",
    })).resolves.toMatchObject({ id: "dead-lock-recovery" });
    await expect(runtime.events.replay({
      sessionId: "dead-lock-recovery",
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "session.created" }),
    ]));
    await expect(fs.stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
    await runtime.close();
  });

  it("reclaims a Runtime lock when process identity proves PID reuse", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtimeDir = path.join(tempRoot, ".kodax", "runtime");
    const lockFile = path.join(runtimeDir, "event-sequence.lock");
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(lockFile, JSON.stringify({
      pid: process.pid,
      createdAt: Date.now(),
      token: "reused-pid-owner",
      processStartIdentity: "invalid:previous-process",
    }), "utf-8");

    const runtime = await createKodaXRuntime({ homeDir: tempRoot });
    await expect(runtime.sessions.create({
      sessionId: "reused-pid-lock-recovery",
    })).resolves.toMatchObject({ id: "reused-pid-lock-recovery" });
    await expect(runtime.events.replay({
      sessionId: "reused-pid-lock-recovery",
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "session.created" }),
    ]));
    await expect(fs.stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
    await runtime.close();
  });

  it("marks non-terminal runs from a definitely dead Runtime interrupted on startup", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runDir = path.join(
      tempRoot,
      ".kodax",
      "runtime",
      "runs",
      "run-crashed",
    );
    const queuedRunDir = path.join(
      tempRoot,
      ".kodax",
      "runtime",
      "runs",
      "run-queued",
    );
    await fs.mkdir(runDir, { recursive: true });
    await fs.mkdir(queuedRunDir, { recursive: true });
    await fs.writeFile(
      path.join(runDir, "status.json"),
      JSON.stringify({
        runId: "run-crashed",
        sessionId: "session-crashed",
        phase: "running",
        startedAt: "2026-07-09T00:00:00.000Z",
        provider: "mock-provider",
        stop: {
          requestedAt: "2026-07-09T00:00:02.000Z",
          state: "unknown",
          outcome: "unknown",
          reason: "runtime run aborted",
        },
        _runtime: {
          revision: 1,
          owner: {
            ownerId: "dead-running-owner",
            runtimeId: "dead-runtime",
            pid: 2147483647,
            startedAt: "2026-07-09T00:00:00.000Z",
          },
        },
        interruptInputs: [
          {
            inputId: "input-crashed",
            afterRunId: "run-crashed",
            delivery: "interrupt",
            state: "queued",
            contentPreview: "lost on restart",
            queuedAt: "2026-07-09T00:00:01.000Z",
          },
        ],
      }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(queuedRunDir, "status.json"),
      JSON.stringify({
        runId: "run-queued",
        sessionId: "session-crashed",
        phase: "queued",
        startedAt: "2026-07-09T00:00:01.000Z",
        provider: "mock-provider",
        _runtime: {
          revision: 1,
          owner: {
            ownerId: "dead-queued-owner",
            runtimeId: "dead-runtime",
            pid: 2147483647,
            startedAt: "2026-07-09T00:00:00.000Z",
          },
        },
      }),
      "utf-8",
    );

    const runtime = await createKodaXRuntime({ homeDir: tempRoot });

    await expect(runtime.runs.get("run-crashed")).resolves.toMatchObject({
      runId: "run-crashed",
      sessionId: "session-crashed",
      phase: "interrupted",
      error: "daemon_crashed",
      terminal: {
        kind: "interrupted",
        code: "daemon_crashed",
        effectOutcome: "unknown",
      },
      stop: {
        state: "confirmed",
        outcome: "interrupted",
        resolvedAt: expect.any(String),
      },
      interruptInputs: [
        expect.objectContaining({
          inputId: "input-crashed",
          state: "terminal",
        }),
      ],
    });
    await expect(runtime.runs.get("run-queued")).resolves.toMatchObject({
      runId: "run-queued",
      phase: "interrupted",
      error: "runtime_restarted",
      terminal: {
        kind: "interrupted",
        code: "runtime_restarted",
        effectOutcome: "none",
      },
    });
    await expect(runtime.runs.await("run-crashed")).resolves.toMatchObject({
      runId: "run-crashed",
      sessionId: "session-crashed",
      phase: "interrupted",
      error: expect.any(Error),
    });
    await expect(
      runtime.events.replay({
        runId: "run-crashed",
        type: "run.interrupted",
      }),
    ).resolves.toHaveLength(1);

    await runtime.close();
  });

  it("keeps ownerless legacy non-terminal runs unknown and read-only", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runId = "run-legacy-ownerless";
    const runDir = path.join(
      tempRoot,
      ".kodax",
      "runtime",
      "runs",
      runId,
    );
    const statusFile = path.join(runDir, "status.json");
    const persisted = {
      runId,
      sessionId: "session-legacy-ownerless",
      phase: "running",
      startedAt: "2026-07-09T00:00:00.000Z",
      provider: "legacy-provider",
    };
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(statusFile, JSON.stringify(persisted), "utf-8");
    const before = await fs.readFile(statusFile);

    const runtime = await createKodaXRuntime({ homeDir: tempRoot });

    await expect(runtime.runs.get(runId)).resolves.toMatchObject({
      runId,
      phase: "unknown",
      error: "owner_liveness_unconfirmed",
    });
    await expect(runtime.status.preflight()).resolves.toMatchObject({
      canStop: false,
      blockers: expect.arrayContaining(["active_runs"]),
      activeRuns: [expect.objectContaining({ runId, phase: "unknown" })],
    });
    expect(await fs.readFile(statusFile)).toEqual(before);
    await expect(runtime.events.replay({
      runId,
      type: "run.interrupted",
    })).resolves.toHaveLength(0);

    await runtime.close();
  });

  it("publishes one restart terminal when two Runtimes recover the same dead Run", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runId = "run-concurrent-dead-owner";
    const sessionId = "session-concurrent-dead-owner";
    const runDir = path.join(tempRoot, ".kodax", "runtime", "runs", runId);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      path.join(runDir, "status.json"),
      JSON.stringify({
        runId,
        sessionId,
        phase: "running",
        startedAt: "2026-07-09T00:00:00.000Z",
        provider: "mock-provider",
        _runtime: {
          revision: 1,
          owner: {
            ownerId: "definitely-dead-owner",
            runtimeId: "definitely-dead-runtime",
            pid: 2147483647,
            startedAt: "2026-07-09T00:00:00.000Z",
          },
        },
      }),
      "utf-8",
    );

    const [first, second] = await Promise.all([
      createKodaXRuntime({ homeDir: tempRoot }),
      createKodaXRuntime({ homeDir: tempRoot }),
    ]);

    await expect(first.runs.get(runId)).resolves.toMatchObject({
      phase: "interrupted",
    });
    await expect(second.runs.get(runId)).resolves.toMatchObject({
      phase: "interrupted",
    });
    await expect(first.events.replay({
      runId,
      type: "run.interrupted",
    })).resolves.toHaveLength(1);

    await Promise.all([first.close(), second.close()]);
  });

  it("reports unknown without mutating a Run whose external owner cannot be confirmed", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runId = "run-owner-unconfirmed";
    const sessionId = "session-owner-unconfirmed";
    const runDir = path.join(
      tempRoot,
      ".kodax",
      "runtime",
      "runs",
      runId,
    );
    const statusFile = path.join(runDir, "status.json");
    const persisted = {
      runId,
      sessionId,
      phase: "running",
      startedAt: "2026-07-09T00:00:00.000Z",
      provider: "external-provider",
      _runtime: {
        revision: 1,
        owner: {
          ownerId: "external-owner-without-proof",
          runtimeId: "external-runtime",
          pid: process.pid,
          startedAt: "2026-07-09T00:00:00.000Z",
        },
      },
    };
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(statusFile, JSON.stringify(persisted), "utf-8");

    const runtime = await createKodaXRuntime({ homeDir: tempRoot });

    await expect(runtime.runs.get(runId)).resolves.toMatchObject({
      runId,
      phase: "unknown",
      error: "owner_liveness_unconfirmed",
    });
    await expect(runtime.runs.abort(runId)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      runtime.events.replay({ runId, type: "run.interrupted" }),
    ).resolves.toEqual([]);
    expect(JSON.parse(await fs.readFile(statusFile, "utf-8"))).toEqual(
      persisted,
    );

    await runtime.close();
  });

  it("restores a durable terminal event instead of emitting a conflicting restart terminal", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runId = "run-terminal-event-won";
    const sessionId = "session-terminal-event-won";
    const runDir = path.join(tempRoot, ".kodax", "runtime", "runs", runId);
    const completed = {
      runId,
      sessionId,
      phase: "completed",
      startedAt: "2026-07-09T00:00:00.000Z",
      endedAt: "2026-07-09T00:01:00.000Z",
      provider: "mock-provider",
      terminal: {
        revision: 1,
        kind: "completed",
        code: "completed",
        effectOutcome: "known",
      },
    };
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      path.join(runDir, "status.json"),
      JSON.stringify({
        runId,
        sessionId,
        phase: "running",
        startedAt: completed.startedAt,
        provider: completed.provider,
      }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(runDir, "events.jsonl"),
      `${JSON.stringify({
        id: "evt-terminal-event-won",
        seq: 1,
        time: completed.endedAt,
        sessionId,
        runId,
        type: "run.completed",
        payload: completed,
      })}\n`,
      "utf-8",
    );

    const runtime = await createKodaXRuntime({ homeDir: tempRoot });

    await expect(runtime.runs.get(runId)).resolves.toMatchObject({
      phase: "completed",
      terminal: { kind: "completed", code: "completed" },
    });
    await expect(runtime.events.replay({ runId })).resolves.toEqual([
      expect.objectContaining({ type: "run.completed" }),
    ]);
    await runtime.close();
  });

  it("recovers durable input delivery without terminalizing an ownerless legacy Run", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runId = "run-durable-interrupt-event";
    const sessionId = "session-durable-interrupt-event";
    const runDir = path.join(tempRoot, ".kodax", "runtime", "runs", runId);
    const queuedAt = "2026-07-09T00:00:01.000Z";
    const deliveredAt = "2026-07-09T00:00:02.000Z";
    const canonicalEntryId = "entry_durable_interrupt";
    await fs.mkdir(runDir, { recursive: true });
    const statusFile = path.join(runDir, "status.json");
    await fs.writeFile(
      statusFile,
      JSON.stringify({
        runId,
        sessionId,
        phase: "running",
        startedAt: "2026-07-09T00:00:00.000Z",
        provider: "mock-provider",
        interruptInputs: [
          {
            inputId: "input-durable",
            afterRunId: runId,
            delivery: "interrupt",
            state: "queued",
            contentPreview: "already consumed",
            queuedAt,
          },
          {
            inputId: "input-legacy",
            afterRunId: runId,
            delivery: "interrupt",
            state: "queued",
            contentPreview: "legacy consumed input",
            queuedAt,
          },
        ],
      }),
      "utf-8",
    );
    const originalStatus = await fs.readFile(statusFile);
    await fs.writeFile(
      path.join(runDir, "events.jsonl"),
      `${JSON.stringify({
        id: "evt-durable-interrupt",
        seq: 1,
        time: deliveredAt,
        sessionId,
        runId,
        type: "run.input.delivered",
        payload: {
          inputs: [
            {
              inputId: "input-durable",
              afterRunId: runId,
              input: { type: "text", text: "already consumed" },
              queuedAt,
              deliveredAt,
              entryId: canonicalEntryId,
            },
            {
              inputId: "input-legacy",
              afterRunId: runId,
              input: { type: "text", text: "legacy consumed input" },
              queuedAt,
              deliveredAt,
            },
          ],
        },
      })}\n`,
      "utf-8",
    );

    const runtime = await createKodaXRuntime({ homeDir: tempRoot });

    const recovered = await runtime.runs.get(runId);
    expect(recovered).toMatchObject({
      phase: "unknown",
      error: "owner_liveness_unconfirmed",
      interruptInputs: [
        expect.objectContaining({
          inputId: "input-durable",
          state: "delivered",
          deliveredAt,
          entryId: canonicalEntryId,
        }),
        expect.objectContaining({
          inputId: "input-legacy",
          state: "delivered",
          deliveredAt,
        }),
      ],
    });
    expect(recovered?.interruptInputs?.[1]).not.toHaveProperty("entryId");
    expect(await fs.readFile(statusFile)).toEqual(originalStatus);
    await runtime.close();
  });

  it("persists non-terminal run status while a run is active", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Active Status Persistence",
    });
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession =>
        fakeRunningSession(options, new Promise<KodaXResult>(() => undefined)),
    );

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "stay active",
    });
    const statusFile = path.join(
      tempRoot,
      ".kodax",
      "runtime",
      "runs",
      encodeURIComponent(handle.runId),
      "status.json",
    );
    const persisted = JSON.parse(await fs.readFile(statusFile, "utf-8")) as {
      readonly phase?: unknown;
    };

    expect(persisted.phase).toBe("running");
    await runtime.close();
  });

  it("keeps a live Run authoritative when a second Runtime opens the same store", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const sessionsDir = path.join(tempRoot, "sessions");
    const first = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: "mock-provider",
    });
    const session = await first.sessions.create({
      title: "Shared live Run ownership",
    });
    let finishRun: ((result: KodaXResult) => void) | undefined;
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession =>
        fakeRunningSession(
          options,
          new Promise<KodaXResult>((resolve) => {
            finishRun = resolve;
          }),
        ),
    );
    const handle = await first.runs.start({
      sessionId: session.id,
      prompt: "stay live while another Runtime observes",
    });

    const second = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: "mock-provider",
    });

    const observedLive = await second.runs.get(handle.runId);
    expect(observedLive.phase).toBe("running");
    expect(observedLive.terminal).toBeUndefined();
    await expect(second.runs.list({ sessionId: session.id })).resolves.toEqual([
      expect.objectContaining({ runId: handle.runId, phase: "running" }),
    ]);
    await second.sessions.load(session.id);

    finishRun?.({
      success: true,
      lastText: "done",
      messages: [],
      sessionId: session.id,
    });
    await expect(handle.result).resolves.toMatchObject({ phase: "completed" });
    await expect(second.runs.get(handle.runId)).resolves.toMatchObject({
      phase: "completed",
      terminal: expect.objectContaining({
        kind: "completed",
        code: "completed",
      }),
    });
    await Promise.all(
      Array.from({ length: 8 }, () => Promise.all([
        first.sessions.load(session.id),
        second.sessions.load(session.id),
      ])),
    );
    const replay = await second.events.replay();
    expect(replay.map((event) => event.seq)).toEqual(
      [...replay.map((event) => event.seq)].sort((left, right) => left - right),
    );
    expect(new Set(replay.map((event) => event.seq)).size).toBe(replay.length);
    expect(replay.filter(
      (event) =>
        event.sessionId === session.id
        && event.type === "session.loaded",
    )).toHaveLength(0);

    const firstStatus = await second.runs.get(handle.runId);
    await first.close();
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession =>
        fakeRunningSession(options, Promise.resolve({
          success: true,
          lastText: "second owner done",
          messages: [],
          sessionId: session.id,
        })),
    );
    const successor = await second.runs.start({
      sessionId: session.id,
      prompt: "continue after ownership transfer",
    });
    await successor.result;
    const successorStatus = await second.runs.get(successor.runId);
    expect(successorStatus.sessionOrder).toBeGreaterThan(
      firstStatus.sessionOrder ?? 0,
    );

    await second.close();
  });

  it("normalizes runtime multimodal input into prompt plus coding inputArtifacts", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Input Artifact Test",
    });
    let capturedOptions: KodaXOptions | undefined;

    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions, prompt: string): RunningSession => {
        expect(["inspect these inputs", "inspect artifact ref"]).toContain(
          prompt,
        );
        capturedOptions = options;
        return fakeRunningSession(
          options,
          Promise.resolve({
            success: true,
            lastText: "artifact done",
            messages: [],
            sessionId: session.id,
          }),
        );
      },
    );

    const handle = await runtime.runs.start({
      sessionId: session.id,
      input: [
        { type: "text", text: "inspect these inputs" },
        {
          type: "image",
          path: path.join(tempRoot, "screen.png"),
          mediaType: "image/png",
          source: "file-picker",
          description: "screenshot",
        },
        {
          type: "file",
          path: path.join(tempRoot, "notes.txt"),
          mimeType: "text/plain",
          name: "notes.txt",
        },
      ],
      options: {
        context: {
          inputArtifacts: [
            {
              kind: "file",
              path: path.join(tempRoot, "legacy.md"),
              mimeType: "text/markdown",
            },
          ],
        },
      },
    });
    await handle.result;

    expect(capturedOptions?.context?.inputArtifacts).toEqual([
      {
        kind: "file",
        path: path.join(tempRoot, "legacy.md"),
        mimeType: "text/markdown",
      },
      {
        kind: "image",
        path: path.join(tempRoot, "screen.png"),
        mediaType: "image/png",
        source: "file-picker",
        description: "screenshot",
      },
      {
        kind: "file",
        path: path.join(tempRoot, "notes.txt"),
        mimeType: "text/plain",
        name: "notes.txt",
      },
    ]);

    await fs.writeFile(
      path.join(tempRoot, "from-artifact-ref.txt"),
      "artifact contents",
      "utf-8",
    );
    const artifact = await runtime.artifacts.create({
      kind: "file",
      path: path.join(tempRoot, "from-artifact-ref.txt"),
      mimeType: "text/plain",
      name: "from-artifact-ref.txt",
      description: "created through runtime artifact service",
    });
    expect(artifact.sizeBytes).toBe(Buffer.byteLength("artifact contents"));
    const refHandle = await runtime.runs.start({
      sessionId: session.id,
      input: [
        { type: "text", text: "inspect artifact ref" },
        { type: "artifact_ref", artifactId: artifact.id },
      ],
    });
    await refHandle.result;

    expect(capturedOptions?.context?.inputArtifacts?.at(-1)).toEqual({
      kind: "file",
      path: path.join(tempRoot, "from-artifact-ref.txt"),
      mimeType: "text/plain",
      name: "from-artifact-ref.txt",
      description: "created through runtime artifact service",
    });

    await runtime.close();
  });

  it("rejects unsupported runtime artifacts before queueing a run", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Unsupported Artifact Test",
    });

    await expect(
      runtime.artifacts.create({
        kind: "audio",
        path: path.join(tempRoot, "clip.mp3"),
      } as unknown as Parameters<typeof runtime.artifacts.create>[0]),
    ).rejects.toThrow("Unsupported runtime artifact kind: audio");

    await expect(
      runtime.artifacts.create({
        kind: "file",
        path: path.join(tempRoot, "missing.txt"),
      }),
    ).rejects.toThrow("Runtime artifact path is not readable");
    await expect(
      runtime.artifacts.create({
        kind: "file",
        path: tempRoot,
      }),
    ).rejects.toThrow("Runtime artifact path must be a regular file");

    const oversizedPath = path.join(tempRoot, "oversized.bin");
    const oversized = await fs.open(oversizedPath, "w");
    try {
      await oversized.truncate(256 * 1024 * 1024 + 1);
    } finally {
      await oversized.close();
    }
    await expect(
      runtime.artifacts.create({
        kind: "file",
        path: oversizedPath,
      }),
    ).rejects.toThrow("Runtime artifact exceeds the 268435456-byte limit");

    await expect(
      runtime.runs.start({
        sessionId: session.id,
        input: [
          { type: "text", text: "listen to this" },
          { type: "audio", path: path.join(tempRoot, "clip.mp3") },
        ],
      } as unknown as Parameters<typeof runtime.runs.start>[0]),
    ).rejects.toThrow("Unsupported runtime input type: audio");

    expect(codingMock.startKodaX).not.toHaveBeenCalled();
    await expect(runtime.runs.list()).resolves.toEqual([]);

    await runtime.close();
  });

  it("exposes project prompt commands through the runtime catalog", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const commandDir = path.join(tempRoot, ".kodax", "commands");
    const commandFile = path.join(commandDir, "ship-runtime.md");
    await fs.mkdir(commandDir, { recursive: true });
    await fs.writeFile(
      commandFile,
      [
        "---",
        "name: ship-runtime",
        "aliases: [deploy-runtime]",
        "description: Deploy from the runtime catalog",
        "argument-hint: <target>",
        "allowed-tools: bash, read",
        "agent: release",
        "model: release-model",
        "---",
        "",
        "Deploy the selected target.",
        "",
      ].join("\n"),
      "utf8",
    );

    const runtime = await createKodaXRuntime({
      mode: "embedded",
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, ".kodax", "sessions"),
      defaultProvider: "mock-provider",
    });

    try {
      const commands = await runtime.catalog.commands(tempRoot);
      const command = commands.find((item) => item.name === "ship-runtime");

      expect(command).toMatchObject({
        name: "ship-runtime",
        aliases: ["deploy-runtime"],
        description: "Deploy from the runtime catalog",
        source: "extension",
        location: "project",
        path: commandFile,
        userInvocable: true,
        argumentHint: "<target>",
        allowedTools: "bash, read",
        agent: "release",
        model: "release-model",
      });

      await expect(
        runtime.catalog.resolveCommand({
          name: "deploy-runtime",
          projectRoot: tempRoot,
        }),
      ).resolves.toMatchObject({
        name: "ship-runtime",
        path: commandFile,
      });
    } finally {
      await runtime.close();
    }
  });

  it("does not mutate the REPL global command registry when listing project commands", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const { getCommandRegistry } = await import("@kodax-ai/repl");
    const registry = getCommandRegistry();
    registry.unregister("runtime-local-only");
    registry.register({
      name: "runtime-local-only",
      description: "Registered by the live REPL process",
      source: "extension",
      handler: async () => {},
    });

    const commandDir = path.join(tempRoot, ".kodax", "commands");
    await fs.mkdir(commandDir, { recursive: true });
    await fs.writeFile(
      path.join(commandDir, "space-project.md"),
      [
        "---",
        "name: space-project",
        "description: Project command for Space",
        "---",
        "",
        "Run the project command.",
        "",
      ].join("\n"),
      "utf8",
    );

    const runtime = await createKodaXRuntime({
      mode: "embedded",
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, ".kodax", "sessions"),
      defaultProvider: "mock-provider",
    });

    try {
      const commands = await runtime.catalog.commands(tempRoot);

      expect(commands.some((item) => item.name === "space-project")).toBe(true);
      expect(registry.has("runtime-local-only")).toBe(true);
      expect(registry.has("space-project")).toBe(false);
    } finally {
      registry.unregister("runtime-local-only");
      await runtime.close();
    }
  });

  it("exposes read-only extension inventory and MCP validation through runtime services", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      mode: "embedded",
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, ".kodax", "sessions"),
      defaultProvider: "mock-provider",
    });

    try {
      await expect(runtime.catalog.extensions()).resolves.toEqual({
        active: false,
        extensions: [],
      });
      await expect(
        runtime.mcp.validateServer("local", {
          type: "stdio",
          command: "echo",
        }),
      ).resolves.toEqual({
        ok: true,
        config: {
          type: "stdio",
          command: "echo",
        },
      });
      await expect(
        runtime.mcp.validateServer("broken", {
          type: "stdio",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining("stdio transport requires"),
      });
    } finally {
      await runtime.close();
    }
  });

  it("exposes custom provider CRUD through runtime catalog services", async () => {
    const { setAgentConfigHome } = await import("@kodax-ai/agent");
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const configHome = path.join(tempRoot, ".kodax");
    setAgentConfigHome(configHome);

    const runtime = await createKodaXRuntime({
      mode: "embedded",
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, ".kodax", "sessions"),
      defaultProvider: "mock-provider",
    });

    try {
      await expect(runtime.catalog.customProviders()).resolves.toEqual([]);
      await expect(
        runtime.catalog.upsertCustomProvider({
          name: "custom-openai",
          protocol: "openai",
          baseUrl: "https://example.invalid/v1",
          apiKeyEnv: "CUSTOM_OPENAI_KEY",
          model: "custom-model",
        }),
      ).resolves.toMatchObject({
        name: "custom-openai",
        model: "custom-model",
      });
      await expect(runtime.catalog.customProviders()).resolves.toEqual([
        expect.objectContaining({
          name: "custom-openai",
          baseUrl: "https://example.invalid/v1",
        }),
      ]);
      await expect(
        runtime.catalog.deleteCustomProvider("custom-openai"),
      ).resolves.toBe(true);
      await expect(runtime.catalog.customProviders()).resolves.toEqual([]);
    } finally {
      await runtime.close();
      setAgentConfigHome(undefined);
    }
  });

  it("exposes transcript notice session operation through runtime events", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({ sessionsDir: tempRoot });
    const session = await runtime.sessions.create({ title: "Notice Test" });
    const seen: string[] = [];
    runtime.events.subscribe({ sessionId: session.id }, (event) => {
      seen.push(event.type);
    });

    const entry = await runtime.sessions.appendNotice({
      sessionId: session.id,
      source: "test",
      content: "host-side notice",
    });
    const transcript = await runtime.sessions.transcript(session.id);

    expect(entry).toMatchObject({
      type: "client_notice",
      source: "client",
      payload: { content: "host-side notice" },
    });
    expect(transcript?.transcriptEntries).toContainEqual(
      expect.objectContaining({
        type: "client_notice",
        source: "client",
        payload: expect.objectContaining({
          content: "host-side notice",
          source: "test",
        }),
      }),
    );
    expect(seen).toContain("session.notice.appended");

    await runtime.close();
  });

  it("exposes rewind and setActiveEntry session operations through runtime events", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const {
      createSessionLineage,
      listPendingEpisodeReviews,
      persistPendingEpisodeReview,
    } = await import("@kodax-ai/agent");
    const { createSessionManager } = await import("@kodax-ai/repl");
    const sessionId = "runtime-history-session";
    const manager = createSessionManager({ sessionsDir: tempRoot });
    const messages: KodaXMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "first reply" },
      { role: "user", content: "second" },
      { role: "assistant", content: "second reply" },
    ];
    const lineage = createSessionLineage(messages);
    const userEntries = lineage.entries.filter(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    const firstUserEntry = userEntries[0];
    const secondUserEntry = userEntries[1];
    expect(firstUserEntry).toBeDefined();
    expect(secondUserEntry).toBeDefined();
    await manager.storage.save(sessionId, {
      messages,
      lineage,
      title: "History Test",
      gitRoot: tempRoot,
      scope: "user",
    });

    const configHome = path.join(tempRoot, ".kodax");
    const reviewIdentity = {
      configHome,
      tenantId: "tenant-runtime-test",
      workspaceId: tempRoot,
      agentId: "kodax-coding",
      projectId: "project-runtime-test",
      sessionId,
    };
    const pendingDigest = {
      id: "runtime-rewind-digest-1",
      reviewKey: "runtime-rewind-review-1",
      sessionId,
      branchId: sessionId,
      sequence: 2,
      objective: "Verify Runtime rewind fencing",
      approach: "Run a verified check",
      outcome: "succeeded" as const,
      summary: "Verification passed",
      evidenceRefs: ["artifact:check-1"],
      visibility: "prompt_safe" as const,
      createdAt: "2026-07-27T00:00:00.000Z",
    };
    await persistPendingEpisodeReview(reviewIdentity, pendingDigest);

    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: tempRoot,
    });
    const seen: string[] = [];
    runtime.events.subscribe({ sessionId }, (event) => {
      seen.push(event.type);
    });

    const rewound = await runtime.sessions.rewind({
      sessionId,
      selector: secondUserEntry!.id,
    });
    const afterRewind = await manager.loadSession(sessionId);
    expect(rewound?.id).toBe(sessionId);
    expect(afterRewind?.messages.map((message) => message.content)).toEqual([
      "first",
      "first reply",
      "second",
    ]);
    expect(
      await listPendingEpisodeReviews({
        configHome,
        tenantId: reviewIdentity.tenantId,
      }),
    ).toEqual([]);

    await persistPendingEpisodeReview(reviewIdentity, {
      ...pendingDigest,
      id: "runtime-rewind-digest-2",
      reviewKey: "runtime-rewind-review-2",
      createdAt: "2026-07-27T00:01:00.000Z",
    });

    const active = await runtime.sessions.setActiveEntry({
      sessionId,
      entryId: firstUserEntry!.id,
    });
    const afterSetActive = await manager.loadSession(sessionId);
    expect(active?.id).toBe(sessionId);
    expect(afterSetActive?.messages.map((message) => message.content)).toEqual([
      "first",
    ]);
    expect(
      await listPendingEpisodeReviews({
        configHome,
        tenantId: reviewIdentity.tenantId,
      }),
    ).toEqual([]);
    expect(seen).toEqual(["session.rewound", "session.active_entry.updated"]);

    await runtime.close();
  });

  it("rejects canonical session mutations while the session has an active run", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Active Mutation Conflict",
    });
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession =>
        fakeRunningSession(options, new Promise<KodaXResult>(() => undefined)),
    );
    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "stay active",
    });

    await expect(
      runtime.sessions.rewind({ sessionId: session.id }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      runtime.sessions.setActiveEntry({
        sessionId: session.id,
        entryId: "entry-during-run",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      runtime.sessions.compact({ sessionId: session.id }),
    ).rejects.toMatchObject({ code: "conflict" });

    await runtime.runs.abort(run.runId);
    await runtime.close();
  });

  it("normalizes run callbacks into scoped runtime events and terminal status", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({ title: "Run Test" });
    const events: Array<{
      type: string;
      sessionId: string;
      runId: string;
      seq: number;
      time: string;
      turnId?: string;
    }> = [];
    runtime.events.subscribe({ sessionId: session.id }, (event) => {
      events.push({
        type: event.type,
        sessionId: event.sessionId,
        runId: event.runId,
        seq: event.seq,
        time: event.time,
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      });
    });

    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions, prompt: string): RunningSession => {
        expect(prompt).toBe("hello runtime");
        const sessionId = options.session?.id ?? "missing-session";
        queueMicrotask(() => {
          options.events?.onTurnStarted?.({
            sessionId,
            seq: 1,
            turnId: "turn-1",
            deliveryKind: "initial",
            timestamp: "2026-07-08T00:00:00.000Z",
          });
          options.events?.onTextDelta?.("hi", {
            sessionId,
            seq: 2,
            turnId: "turn-1",
            timestamp: "2026-07-08T00:00:00.001Z",
          });
          options.events?.onToolUseStart?.(
            { id: "tool-1", name: "bash", input: { command: "pwd" } },
            {
              sessionId,
              seq: 3,
              turnId: "turn-1",
              toolId: "tool-1",
              timestamp: "2026-07-08T00:00:00.002Z",
            },
          );
          options.events?.onToolSandboxObservation?.(
            {
              id: "tool-1",
              observation: {
                version: 1,
                state: "applied",
                backend: "windows-restricted-user",
                policyId: "kodax-workspace-shell-v1",
              },
            },
            {
              sessionId,
              seq: 4,
              turnId: "turn-1",
              toolId: "tool-1",
              timestamp: "2026-07-08T00:00:00.003Z",
            },
          );
          options.events?.onToolResult?.(
            { id: "tool-1", name: "bash", content: "ok" },
            {
              sessionId,
              seq: 5,
              turnId: "turn-1",
              toolId: "tool-1",
              timestamp: "2026-07-08T00:00:00.004Z",
            },
          );
        });
        return fakeRunningSession(
          options,
          Promise.resolve({
            success: true,
            lastText: "done",
            messages: [],
            sessionId,
          }),
        );
      },
    );

    const handle = await runtime.runs.start({
      sessionId: session.id,
      input: { type: "text", text: "hello runtime" },
    });
    const result = await handle.result;
    const awaitedResult = await runtime.runs.await(handle.runId);
    const status = await runtime.runs.get(handle.runId);
    const replay = await runtime.events.replay({ runId: handle.runId });
    const assistantReplay = await runtime.events.replay({
      runId: handle.runId,
      type: "assistant.delta",
    });

    expect(result.phase).toBe("completed");
    expect(awaitedResult).toEqual(result);
    expect(status.phase).toBe("completed");
    expect(status.turnId).toBe("turn-1");
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "config.effective",
      "turn.started",
      "assistant.delta",
      "tool.started",
      "tool.sandbox",
      "tool.finished",
      "run.completed",
    ]);
    expect(new Set(events.map((event) => event.runId))).toEqual(
      new Set([handle.runId]),
    );
    expect(events.every((event) => event.sessionId === session.id)).toBe(true);
    expect(
      events.every((event) => event.seq > 0 && event.time.includes("T")),
    ).toBe(true);
    expect(replay.every((event) => event.sessionId === session.id)).toBe(true);
    expect(replay.every((event) => event.runId === handle.runId)).toBe(true);
    expect(
      replay.every((event) => event.id && event.time && event.seq > 0),
    ).toBe(true);
    expect(replay.map((event) => event.seq)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(
      replay.find((event) => event.type === "tool.sandbox")?.payload,
    ).toMatchObject({
      update: {
        id: "tool-1",
        observation: {
          state: "applied",
          policyId: "kodax-workspace-shell-v1",
        },
      },
    });
    expect(assistantReplay.map((event) => event.type)).toEqual([
      "assistant.delta",
    ]);

    await runtime.close();
  });

  it("emits one canonical post-commit compaction event with stable context ownership", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Canonical Compact Event",
    });
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        queueMicrotask(() => {
          options.events?.onCompactedMessages?.(
            [{ role: "user", content: "checkpoint" }],
            {
              preCompactionMessages: [
                {
                  role: "user",
                  content: `HOST_ONLY_HISTORY_${"x".repeat(256_000)}`,
                },
              ],
              anchor: {
                summary: `PRIVATE_SUMMARY_${"y".repeat(256_000)}`,
                tokensBefore: 1_000,
                tokensAfter: 400,
                entriesRemoved: 3,
                reason: "automatic_compaction",
              },
              postCompactAttachments: [
                {
                  role: "system",
                  content: `PRIVATE_ATTACHMENT_${"z".repeat(256_000)}`,
                },
              ],
            },
          );
          options.events?.onCompactStats?.({
            tokensBefore: 1_000,
            tokensAfter: 400,
          });
          options.events?.onCompact?.(400);
          options.events?.onContextCompactionFinished?.({
            sessionId: session.id,
            seq: 4,
            turnId: "turn-compact",
            contextId: session.id,
            contextKind: "root",
            contextRevision: 1,
            source: "automatic_threshold",
            tokensBefore: 1_000,
            tokensAfter: 400,
            committed: true,
            elapsedMs: 12,
            strategy: "full_prefix",
          });
        });
        return fakeRunningSession(
          options,
          Promise.resolve({
            success: true,
            lastText: "done",
            messages: [],
            sessionId: session.id,
          }),
        );
      },
    );

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "compact",
      options: { session: { persistedByHost: true } },
    });
    await handle.result;
    await flushMicrotasks();
    const events = await runtime.events.replay({
      runId: handle.runId,
      type: "context.compaction.finished",
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      contextId: session.id,
      contextKind: "root",
      contextRevision: 1,
      beforeRevision: 0,
      afterRevision: 1,
      tokensBefore: 1_000,
      tokensAfter: 400,
      committed: true,
    });
    const messageEvents = await runtime.events.replay({
      runId: handle.runId,
      type: "context.compaction.messages",
    });
    expect(messageEvents).toHaveLength(1);
    expect(messageEvents[0]?.payload).toMatchObject({
      messageCount: 1,
      update: {
        hasAnchor: true,
        tokensBefore: 1_000,
        tokensAfter: 400,
        entriesRemoved: 3,
        artifactLedgerEntryCount: 0,
        postCompactAttachmentCount: 1,
        exactSnapshotAvailable: true,
      },
    });
    const eventJson = JSON.stringify(messageEvents[0]);
    expect(eventJson).not.toContain("HOST_ONLY_HISTORY");
    expect(eventJson).not.toContain("PRIVATE_SUMMARY");
    expect(eventJson).not.toContain("PRIVATE_ATTACHMENT");
    expect(Buffer.byteLength(eventJson, "utf8")).toBeLessThan(4_096);
    expect(
      codingMock.startKodaX.mock.calls[0]?.[0].session?.persistedByHost,
    ).toBe(false);
    await runtime.close();
  });

  it("keeps completed and delivered managed turns canonical when the active Run crashes", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const sessionsDir = path.join(tempRoot, "managed-durable-boundary-sessions");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Managed Durable Boundary",
    });
    let signalStarted: (() => void) | undefined;
    let releaseQueuedInput: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const queuedInputReady = new Promise<void>((resolve) => {
      releaseQueuedInput = resolve;
    });

    codingMock.startKodaX.mockImplementation((options: KodaXOptions) => {
      const result = (async (): Promise<KodaXResult> => {
        const storage = options.session?.storage;
        if (!storage) throw new Error("Runtime canonical storage missing");
        const initial: KodaXMessage = {
          role: "user",
          content: "FIRST_MANAGED_PROMPT",
          turnId: "turn-durable-1",
        };
        await storage.save(session.id, {
          messages: [initial],
          title: "Managed Durable Boundary",
          gitRoot: tempRoot,
        });
        options.events?.onTurnStarted?.({
          sessionId: session.id,
          seq: 1,
          turnId: "turn-durable-1",
          contextId: session.id,
          contextKind: "root",
          contextRevision: 0,
          deliveryKind: "initial",
        });
        options.context?.interruptInput?.reopenInputWindow();
        signalStarted?.();
        await queuedInputReady;

        const completed: KodaXMessage[] = [
          initial,
          {
            role: "assistant",
            content: "FIRST_MANAGED_ANSWER",
            turnId: "turn-durable-1",
          },
        ];
        await storage.save(session.id, {
          messages: completed,
          title: "Managed Durable Boundary",
          gitRoot: tempRoot,
        });
        options.events?.onTurnCompleted?.({
          sessionId: session.id,
          seq: 2,
          turnId: "turn-durable-1",
          contextId: session.id,
          contextKind: "root",
          contextRevision: 0,
          status: "completed",
        });

        const queued = getMessageQueue().dequeue({
          agentId: actorQueueId(session.id, "/root"),
          maxPriority: "user",
          mode: "prompt",
        });
        const queuedPrompt = queued[0];
        if (!queuedPrompt) throw new Error("Runtime queued prompt missing");
        const queuedMessage: KodaXMessage = {
          role: "user",
          content: queuedPrompt.content,
          turnId: "turn-durable-2",
        };
        await storage.save(session.id, {
          messages: [
            ...completed,
            queuedMessage,
          ],
          title: "Managed Durable Boundary",
          gitRoot: tempRoot,
        });
        options.events?.onMidTurnUserMessages?.(
          [queuedPrompt.content],
          {
            queuedMessageIds: [queuedPrompt.id],
            queuedMessageEntryIds: {
              [queuedPrompt.id]: getSessionMessageEntryId(queuedMessage)!,
            },
          },
        );
        throw new Error("simulated daemon crash during queued turn");
      })();
      return fakeRunningSession(options, result);
    });

    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "FIRST_MANAGED_PROMPT",
    });
    await started;
    const queued = await runtime.runs.submitInput({
      sessionId: session.id,
      afterRunId: run.runId,
      delivery: "interrupt",
      input: { type: "text", text: "SECOND_MANAGED_PROMPT" },
    });
    expect(queued.accepted).toBe(true);
    releaseQueuedInput?.();
    await run.result;

    const canonical = await new FileSessionStorage({ sessionsDir }).load(session.id);
    const canonicalJson = JSON.stringify(canonical?.messages);
    expect(canonicalJson).toContain("FIRST_MANAGED_PROMPT");
    expect(canonicalJson).toContain("FIRST_MANAGED_ANSWER");
    expect(canonicalJson).toContain("SECOND_MANAGED_PROMPT");
    const lifecycle = await runtime.events.replay({ runId: run.runId });
    const completedIndex = lifecycle.findIndex((event) => event.type === "turn.completed");
    const deliveredIndex = lifecycle.findIndex((event) => event.type === "run.input.delivered");
    expect(completedIndex).toBeGreaterThanOrEqual(0);
    expect(deliveredIndex).toBeGreaterThan(completedIndex);
    const deliveredEvent = lifecycle[deliveredIndex];
    expect(deliveredEvent?.type).toBe("run.input.delivered");
    const deliveredEntryId = deliveredEvent?.type === "run.input.delivered"
      ? (deliveredEvent.payload as RuntimeRunInputDeliveredEventPayload).inputs[0]?.entryId
      : undefined;
    await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({
      interruptInputs: [expect.objectContaining({
        state: "delivered",
        entryId: deliveredEntryId,
      })],
    });
    if (!canonical?.lineage) throw new Error("canonical lineage missing");
    const retainedInterrupt = canonical.messages.at(-1);
    if (!retainedInterrupt) throw new Error("canonical interrupt missing");
    await persistCompactedSessionHistory({
      storage: new FileSessionStorage({ sessionsDir }),
      sessionId: session.id,
      compactedMessages: [retainedInterrupt],
      update: {
        preCompactionMessages: canonical.messages,
        anchor: {
          summary: "Compacted before interrupt entry verification",
          tokensBefore: 3,
          tokensAfter: 1,
          entriesRemoved: 2,
          reason: "test_compaction",
        },
      },
    });
    const conversation = await runtime.sessions.conversation(session.id);
    if (conversation === null) throw new Error("conversation missing after compaction");
    const deliveredConversationEntry = conversation.entries.find((entry) =>
      entry.boundaryId === deliveredEntryId
      || entry.auditEntryIds.includes(deliveredEntryId ?? ""));
    expect(deliveredEntryId).toMatch(/^entry_/);
    expect(JSON.stringify(deliveredConversationEntry?.message.content)).toContain(
      "SECOND_MANAGED_PROMPT",
    );

    const pagedEntries: Array<NonNullable<typeof deliveredConversationEntry>> = [];
    let pageCursor: string | undefined;
    do {
      const page = await runtime.sessions.conversationPage({
        sessionId: session.id,
        ...(pageCursor !== undefined ? { cursor: pageCursor } : {}),
        limit: 1,
      });
      if (page === null) throw new Error("conversation page missing");
      for (const item of page.entries) {
        if (item.entry !== undefined) pagedEntries.push(item.entry);
      }
      pageCursor = page.nextCursor;
    } while (pageCursor !== undefined);
    expect(pagedEntries.some((entry) =>
      entry.boundaryId === deliveredEntryId
      || entry.auditEntryIds.includes(deliveredEntryId ?? ""))).toBe(true);

    await runtime.close();
    const resumedRuntime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: "mock-provider",
    });
    const resumedDelivery = await resumedRuntime.events.replay({
      runId: run.runId,
      type: "run.input.delivered",
    });
    const resumedDeliveryPayload = resumedDelivery[0]?.payload as
      | RuntimeRunInputDeliveredEventPayload
      | undefined;
    expect(resumedDeliveryPayload?.inputs[0]?.entryId).toBe(deliveredEntryId);
    await expect(resumedRuntime.runs.get(run.runId)).resolves.toMatchObject({
      interruptInputs: [expect.objectContaining({
        state: "delivered",
        entryId: deliveredEntryId,
      })],
    });
    const resumedConversation = await resumedRuntime.sessions.conversation(session.id);
    if (resumedConversation === null) throw new Error("resumed conversation missing");
    expect(resumedConversation.entries.some((entry) =>
      entry.boundaryId === deliveredEntryId
      || entry.auditEntryIds.includes(deliveredEntryId ?? ""))).toBe(true);
    await resumedRuntime.close();
  });

  it("emits one ordered canonical lifecycle for manual session compaction", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Manual Compact Lifecycle",
    });
    const events: Array<{ readonly type: string; readonly payload: unknown }> =
      [];
    runtime.events.subscribe({ sessionId: session.id }, (event) => {
      if (event.type.startsWith("context.compaction.")) {
        events.push({ type: event.type, payload: event.payload });
      }
    });

    const result = await runtime.sessions.compact({
      sessionId: session.id,
      provider: "mock-provider",
    });

    expect(result.compacted).toBe(false);
    expect(events.map((event) => event.type)).toEqual([
      "context.compaction.started",
      "context.compaction.finished",
      "context.compaction.ended",
    ]);
    expect(events[0]?.payload).toMatchObject({
      meta: {
        contextId: session.id,
        contextKind: "root",
        contextRevision: 0,
      },
    });
    expect(events[1]?.payload).toMatchObject({
      contextId: session.id,
      contextKind: "root",
      contextRevision: 0,
      beforeRevision: 0,
      afterRevision: 0,
      source: "manual",
      committed: false,
    });
    expect(events[2]?.payload).toMatchObject({
      meta: {
        contextId: session.id,
        contextKind: "root",
        contextRevision: 0,
      },
    });
    await runtime.close();
  });

  it("keeps active live projection complete after durable event history is trimmed", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Live Projection Retention",
    });
    const chunk = "x".repeat(2 * 1024 * 1024);
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        const sessionId = options.session?.id ?? session.id;
        options.events?.onToolUseStart?.(
          { id: "long-tool", name: "bash", input: { command: "long-running" } },
          {
            sessionId,
            seq: 1,
            turnId: "turn-live",
            toolId: "long-tool",
            timestamp: "2026-07-09T00:00:00.000Z",
          },
        );
        for (let index = 0; index < 9; index += 1) {
          options.events?.onTextDelta?.(chunk, {
            sessionId,
            seq: index + 2,
            turnId: "turn-live",
            timestamp: "2026-07-09T00:00:00.000Z",
          });
        }
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );

    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "large active run",
    });
    const observation = await runtime.sessions.observe(
      session.id,
      () => undefined,
    );

    expect(observation.snapshot.live.activeTools).toEqual([
      expect.objectContaining({ runId: run.runId }),
    ]);
    expect(
      observation.snapshot.live.assistantTextByRun[run.runId],
    ).toHaveLength(chunk.length * 9);
    await expect(
      runtime.events.replay({ runId: run.runId, sinceSeq: 0 }),
    ).rejects.toMatchObject({ code: "resync_required" });
    observation.close();
    await runtime.close();
  });

  it("requires resync for trimmed Session events without a Run status", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
    });
    const session = await runtime.sessions.create({
      sessionId: "session%retention",
      title: "Session Event Retention",
    });
    const largeNotice = "n".repeat(9 * 1024 * 1024);
    await runtime.sessions.appendNotice({
      sessionId: session.id,
      source: "retention",
      content: largeNotice,
    });
    await runtime.sessions.appendNotice({
      sessionId: session.id,
      source: "retention",
      content: largeNotice,
    });

    await expect(runtime.events.replay({
      sessionId: session.id,
      sinceSeq: 0,
    })).rejects.toMatchObject({ code: "resync_required" });
    await runtime.close();
  });

  it("invalidates embedded Session observations when the Runtime closes", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
    });
    const session = await runtime.sessions.create({
      title: "Observation Runtime Close",
    });
    const observation = await runtime.sessions.observe(
      session.id,
      () => undefined,
    );
    let invalidation: unknown;
    void observation.invalidated.then((value) => {
      invalidation = value;
    });

    await runtime.close();
    await flushMicrotasks();

    expect(invalidation).toMatchObject({
      code: "observation_invalidated",
      reason: "runtime_changed",
      runtimeId: runtime.identity.runtimeId,
    });
  });

  it("invalidates an embedded observation when a terminal listener throws", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Observation Listener Failure",
    });
    let finishRun: ((result: KodaXResult) => void) | undefined;
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession =>
        fakeRunningSession(
          options,
          new Promise<KodaXResult>((resolve) => {
            finishRun = resolve;
          }),
        ),
    );
    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "complete after observation starts",
    });
    const delivered: string[] = [];
    const observation = await runtime.sessions.observe(session.id, (event) => {
      delivered.push(event.type);
      if (event.type === "run.completed") {
        throw new Error("Space reducer failed");
      }
    });

    finishRun?.({
      success: true,
      lastText: "done",
      messages: [],
      sessionId: session.id,
    });
    await run.result;

    await expect(observation.invalidated).resolves.toMatchObject({
      code: "observation_invalidated",
      reason: "delivery_failed",
      runtimeId: runtime.identity.runtimeId,
    });
    await runtime.sessions.appendNotice({
      sessionId: session.id,
      content: "must not be delivered after invalidation",
    });
    expect(delivered.at(-1)).toBe("run.completed");
    await runtime.close();
  });

  it("keeps child activity out of the primary live observation projection", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Child Activity Projection",
    });
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        const rootMeta = {
          sessionId: session.id,
          turnId: "turn-root",
          contextId: session.id,
          contextKind: "root",
          contextRevision: 0,
        } as const;
        options.events?.onTextDelta?.("root answer", rootMeta);
        options.events?.onTextDelta?.(" root live-only update", {
          liveOnly: true,
        });
        options.events?.onTextDelta?.("child answer", {
          sessionId: session.id,
          turnId: "turn-child",
          contextId: "child-context",
          contextKind: "child",
          contextRevision: 0,
        });
        options.events?.onThinkingDelta?.("root reasoning", rootMeta);
        options.events?.onThinkingDelta?.("child reasoning", {
          childAgentId: "child-agent",
        });
        options.events?.onToolUseStart?.(
          { id: "root-tool", name: "bash" },
          rootMeta,
        );
        options.events?.onToolUseStart?.(
          { id: "child-tool", name: "read" },
          { childAgentId: "child-tool-agent", liveOnly: true },
        );
        options.events?.onTodoUpdate?.([], rootMeta);
        options.events?.onTodoUpdate?.([], {
          workflowCorrelation: { workflowRunId: "workflow-child" },
        });
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );

    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "project root only",
    });
    const observation = await runtime.sessions.observe(
      session.id,
      () => undefined,
    );

    expect(observation.snapshot.live.assistantTextByRun).toEqual({
      [run.runId]: "root answer root live-only update",
    });
    expect(observation.snapshot.live.thinkingTextByRun).toEqual({
      [run.runId]: "root reasoning",
    });
    expect(observation.snapshot.live.activeTools).toEqual([
      expect.objectContaining({
        runId: run.runId,
        started: expect.objectContaining({
          tool: expect.objectContaining({ id: "root-tool" }),
        }),
      }),
    ]);
    expect(observation.snapshot.live.todo).toEqual(
      expect.objectContaining({
        items: [],
        meta: expect.objectContaining({ contextKind: "root" }),
      }),
    );
    observation.close();
    await runtime.close();
  });

  it("bounds observation transcripts and pages oversized entries explicitly", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
    });
    const session = await runtime.sessions.create({
      title: "Paged Transcript",
    });
    await runtime.sessions.appendNotice({
      sessionId: session.id,
      source: "large-test",
      content: "x".repeat(20 * 1024 * 1024),
    });

    const observation = await runtime.sessions.observe(
      session.id,
      () => undefined,
    );
    const slice = observation.snapshot.transcript;
    expect(Buffer.byteLength(JSON.stringify(slice), "utf8")).toBeLessThan(
      1024 * 1024,
    );
    expect(slice?.entries).toEqual([
      expect.objectContaining({
        index: 0,
        oversized: true,
        byteLength: expect.any(Number),
      }),
    ]);

    const recovered: Buffer[] = [];
    let cursor: string | undefined;
    let appendedDuringRead = false;
    do {
      const chunk = await runtime.sessions.transcriptEntryChunk({
        sessionId: session.id,
        revision: slice!.revision,
        entryIndex: 0,
        ...(cursor ? { cursor } : {}),
      });
      expect(chunk?.encoding).toBe("base64-json");
      expect(Buffer.byteLength(JSON.stringify(chunk), "utf8")).toBeLessThan(
        512 * 1024,
      );
      recovered.push(Buffer.from(chunk!.data, "base64"));
      cursor = chunk!.hasMore ? chunk!.nextCursor : undefined;
      if (!appendedDuringRead && cursor !== undefined) {
        appendedDuringRead = true;
        await runtime.sessions.appendNotice({
          sessionId: session.id,
          source: "revision-change",
          content: "newer",
        });
      }
    } while (cursor);
    const recoveredEntry = JSON.parse(
      Buffer.concat(recovered).toString("utf8"),
    ) as {
      message?: { content?: string };
    };
    expect(recoveredEntry.message?.content).toContain("x".repeat(1024));
    expect(recoveredEntry.message?.content?.length).toBeGreaterThanOrEqual(
      20 * 1024 * 1024,
    );

    await expect(
      runtime.sessions.transcriptEntryChunk({
        sessionId: session.id,
        revision: "sha256:missing-snapshot",
        entryIndex: 0,
      }),
    ).rejects.toMatchObject({ code: "resync_required" });

    observation.close();
    await runtime.close();
  });

  it("finishes a fixed transcript page boundary while the Session keeps appending", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
    });
    const session = await runtime.sessions.create({
      title: "Active Paged Transcript",
    });
    for (const content of ["one", "two", "three", "four"]) {
      await runtime.sessions.appendNotice({
        sessionId: session.id,
        source: "snapshot-page",
        content,
      });
    }

    const newest = await runtime.sessions.transcriptPage({
      sessionId: session.id,
      limit: 2,
    });
    expect(newest?.entries.map((entry) => entry.entry?.message.content)).toEqual([
      "three",
      "four",
    ]);
    const callerOwnedEntry = newest!.entries[0]!.entry as {
      message: { content: string };
    };
    callerOwnedEntry.message.content = "caller mutation";
    const originalChunk = await runtime.sessions.transcriptEntryChunk({
      sessionId: session.id,
      revision: newest!.revision,
      entryIndex: 2,
    });
    const originalEntry = JSON.parse(
      Buffer.from(originalChunk!.data, "base64").toString("utf8"),
    ) as { message: { content: string } };
    expect(originalEntry.message.content).toBe("three");
    await runtime.sessions.appendNotice({
      sessionId: session.id,
      source: "concurrent-append",
      content: "five",
    });
    const oldest = await runtime.sessions.transcriptPage({
      sessionId: session.id,
      cursor: newest!.nextCursor,
      limit: 2,
    });

    expect(oldest).toMatchObject({
      revision: newest!.revision,
      hasMore: false,
    });
    expect(oldest?.entries.map((entry) => entry.entry?.message.content)).toEqual([
      "one",
      "two",
    ]);
    const refreshed = await runtime.sessions.transcriptPage({
      sessionId: session.id,
      limit: 1,
    });
    expect(refreshed?.revision).not.toBe(newest?.revision);
    expect(refreshed?.entries[0]?.entry?.message.content).toBe("five");
    await runtime.close();
  });

  it("single-flights the first transcript capture and materialization across readers", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const sessionsDir = path.join(tempRoot, "snapshot-single-flight-sessions");
    const runtime = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir });
    const session = await runtime.sessions.create({
      sessionId: "snapshot-single-flight",
      title: "Snapshot single flight",
    });
    await runtime.sessions.appendNotice({
      sessionId: session.id,
      source: "single-flight",
      content: "shared searchable transcript",
    });
    const originalReadFile = nodeFsPromises.readFile.bind(nodeFsPromises);
    const originalOpen = nodeFsPromises.open.bind(nodeFsPromises);
    let sourcePayloadReads = 0;
    let snapshotMaterializations = 0;
    let releaseMaterialization: (() => void) | undefined;
    let markMaterializationStarted: (() => void) | undefined;
    const materializationGate = new Promise<void>((resolve) => {
      releaseMaterialization = resolve;
    });
    const materializationStarted = new Promise<void>((resolve) => {
      markMaterializationStarted = resolve;
    });
    const readFile = vi.spyOn(nodeFsPromises, "readFile").mockImplementation(
      async (file, options) => {
        if (path.basename(String(file)) === `${session.id}.jsonl`) {
          sourcePayloadReads += 1;
        }
        return originalReadFile(file, options);
      },
    );
    const open = vi.spyOn(nodeFsPromises, "open").mockImplementation(
      async (file, flags, mode) => {
        if (path.basename(String(file)) === `${session.id}.jsonl`) {
          sourcePayloadReads += 1;
        }
        if (String(file).endsWith(".entries") && String(flags) === "wx") {
          snapshotMaterializations += 1;
          markMaterializationStarted?.();
          await materializationGate;
        }
        return originalOpen(file, flags, mode);
      },
    );
    try {
      const observationRequest = runtime.sessions.observe(
        session.id,
        () => undefined,
      );
      await materializationStarted;
      const pageRequest = runtime.sessions.transcriptPage({
        sessionId: session.id,
      });
      const searchRequest = runtime.sessions.transcriptSearch({
        sessionId: session.id,
        query: "searchable",
      });
      releaseMaterialization?.();
      const [observation, page, search] = await Promise.all([
        observationRequest,
        pageRequest,
        searchRequest,
      ]);
      expect(sourcePayloadReads).toBe(1);
      expect(snapshotMaterializations).toBe(1);
      expect(page?.revision).toBe(observation.snapshot.transcriptRevision);
      expect(search?.revision).toBe(observation.snapshot.transcriptRevision);
      observation.close();
    } finally {
      releaseMaterialization?.();
      readFile.mockRestore();
      open.mockRestore();
      await runtime.close();
    }
  });

  it("batches transcript snapshot writes for long sessions", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const sessionsDir = path.join(tempRoot, "snapshot-batched-write-sessions");
    const sessionId = "snapshot-batched-writes";
    const messages: KodaXMessage[] = Array.from({ length: 600 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `snapshot entry ${index}`,
    }));
    await new FileSessionStorage({ sessionsDir }).save(sessionId, {
      messages,
      lineage: createSessionLineage(messages),
      title: "Snapshot batched writes",
    });
    const runtime = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir });
    const originalOpen = nodeFsPromises.open.bind(nodeFsPromises);
    let snapshotWrites = 0;
    const open = vi.spyOn(nodeFsPromises, "open").mockImplementation(
      async (file, flags, mode) => {
        const handle = await originalOpen(file, flags, mode);
        if (String(file).endsWith(".entries") && String(flags) === "wx") {
          const originalWrite = handle.write.bind(handle);
          handle.write = (async (...args: Parameters<typeof originalWrite>) => {
            snapshotWrites += 1;
            return originalWrite(...args);
          }) as typeof handle.write;
        }
        return handle;
      },
    );
    try {
      const observation = await runtime.sessions.observe(sessionId, () => undefined);
      expect(observation.snapshot.transcript.entries).toHaveLength(50);
      expect(snapshotWrites).toBeLessThanOrEqual(8);
      observation.close();
    } finally {
      open.mockRestore();
      await runtime.close();
    }
  });

  it("does not join a post-mutation fresh read to an older materialization flight", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "snapshot-mutation-flight-sessions"),
    });
    const session = await runtime.sessions.create({
      sessionId: "snapshot-mutation-flight",
    });
    await runtime.sessions.appendNotice({
      sessionId: session.id,
      source: "mutation-flight",
      content: "before mutation",
    });
    const originalOpen = nodeFsPromises.open.bind(nodeFsPromises);
    let releaseMaterializations: (() => void) | undefined;
    let markFirstMaterialization: (() => void) | undefined;
    const materializationGate = new Promise<void>((resolve) => {
      releaseMaterializations = resolve;
    });
    const firstMaterialization = new Promise<void>((resolve) => {
      markFirstMaterialization = resolve;
    });
    const open = vi.spyOn(nodeFsPromises, "open").mockImplementation(
      async (file, flags, mode) => {
        if (String(file).endsWith(".entries") && String(flags) === "wx") {
          markFirstMaterialization?.();
          await materializationGate;
        }
        return originalOpen(file, flags, mode);
      },
    );
    try {
      const beforeRequest = runtime.sessions.transcriptPage({
        sessionId: session.id,
      });
      await firstMaterialization;
      await runtime.sessions.appendNotice({
        sessionId: session.id,
        source: "mutation-flight",
        content: "after mutation",
      });
      const afterRequest = runtime.sessions.transcriptPage({
        sessionId: session.id,
      });
      releaseMaterializations?.();
      const [before, after] = await Promise.all([beforeRequest, afterRequest]);
      expect(before?.revision).not.toBe(after?.revision);
      expect(before?.entries.map((entry) => entry.entry?.message.content))
        .toEqual(["before mutation"]);
      expect(after?.entries.map((entry) => entry.entry?.message.content))
        .toEqual(["before mutation", "after mutation"]);
    } finally {
      releaseMaterializations?.();
      open.mockRestore();
      await runtime.close();
    }
  });

  it("does not join a post-delete fresh read to an older materialization flight", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "snapshot-delete-flight-sessions"),
    });
    const session = await runtime.sessions.create({
      sessionId: "snapshot-delete-flight",
    });
    await runtime.sessions.appendNotice({
      sessionId: session.id,
      source: "delete-flight",
      content: "deleted after capture",
    });
    const originalOpen = nodeFsPromises.open.bind(nodeFsPromises);
    let releaseMaterialization: (() => void) | undefined;
    let markMaterializationStarted: (() => void) | undefined;
    const materializationGate = new Promise<void>((resolve) => {
      releaseMaterialization = resolve;
    });
    const materializationStarted = new Promise<void>((resolve) => {
      markMaterializationStarted = resolve;
    });
    const open = vi.spyOn(nodeFsPromises, "open").mockImplementation(
      async (file, flags, mode) => {
        if (String(file).endsWith(".entries") && String(flags) === "wx") {
          markMaterializationStarted?.();
          await materializationGate;
        }
        return originalOpen(file, flags, mode);
      },
    );
    try {
      const retainedBoundary = runtime.sessions.transcriptPage({
        sessionId: session.id,
      });
      await materializationStarted;
      await runtime.sessions.delete(session.id);
      const freshAfterDelete = runtime.sessions.transcriptPage({
        sessionId: session.id,
      });
      const searchAfterDelete = runtime.sessions.transcriptSearch({
        sessionId: session.id,
        query: "deleted after capture",
      });
      const freshRejection = expect(freshAfterDelete).rejects.toThrow(
        `Session not found: ${session.id}`,
      );
      const searchRejection = expect(searchAfterDelete).rejects.toThrow(
        `Session not found: ${session.id}`,
      );
      releaseMaterialization?.();
      await expect(retainedBoundary).resolves.not.toBeNull();
      await freshRejection;
      await searchRejection;
    } finally {
      releaseMaterialization?.();
      open.mockRestore();
      await runtime.close();
    }
  });

  it("keeps a shared first capture alive when only one reader cancels", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const sessionsDir = path.join(tempRoot, "snapshot-shared-cancel-sessions");
    const runtime = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir });
    const session = await runtime.sessions.create({
      sessionId: "snapshot-shared-cancel",
    });
    await runtime.sessions.appendNotice({
      sessionId: session.id,
      source: "shared-cancel",
      content: "one reader remains",
    });
    const originalOpen = nodeFsPromises.open.bind(nodeFsPromises);
    let releaseSourceOpen: (() => void) | undefined;
    let markSourceOpenStarted: (() => void) | undefined;
    const sourceOpenGate = new Promise<void>((resolve) => {
      releaseSourceOpen = resolve;
    });
    const sourceOpenStarted = new Promise<void>((resolve) => {
      markSourceOpenStarted = resolve;
    });
    let sourceOpens = 0;
    let materializations = 0;
    const open = vi.spyOn(nodeFsPromises, "open").mockImplementation(
      async (file, flags, mode) => {
        if (path.basename(String(file)) === `${session.id}.jsonl`) {
          sourceOpens += 1;
          markSourceOpenStarted?.();
          await sourceOpenGate;
        }
        if (String(file).endsWith(".entries") && String(flags) === "wx") {
          materializations += 1;
        }
        return originalOpen(file, flags, mode);
      },
    );
    const controller = new AbortController();
    try {
      const cancelled = runtime.sessions.transcriptPage(
        { sessionId: session.id },
        { signal: controller.signal },
      );
      const retained = runtime.sessions.transcriptPage({
        sessionId: session.id,
      });
      await sourceOpenStarted;
      controller.abort();
      await expect(cancelled).rejects.toMatchObject({ code: "read_cancelled" });
      releaseSourceOpen?.();
      await expect(retained).resolves.not.toBeNull();
      expect(sourceOpens).toBe(1);
      expect(materializations).toBe(1);
    } finally {
      releaseSourceOpen?.();
      open.mockRestore();
      await runtime.close();
    }
  });

  it("keeps read-only Session APIs out of durable Runtime event persistence", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const sessionsDir = path.join(tempRoot, "readonly-session-api-sessions");
    const runtime = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir });
    const session = await runtime.sessions.create({
      sessionId: "readonly-session-api",
      title: "Read only Session API",
    });
    await runtime.sessions.appendNotice({
      sessionId: session.id,
      source: "readonly",
      content: "read only history",
    });
    const sequencePath = path.join(
      tempRoot,
      ".kodax",
      "runtime",
      "event-sequence",
    );
    const beforeEvents = await runtime.events.replay();
    const beforeSequence = await fs.readFile(sequencePath);
    replMock.loadSessionCalls = 0;

    await runtime.sessions.load(session.id);
    await runtime.sessions.list();
    await runtime.sessions.status(session.id);
    await runtime.sessions.transcript(session.id);
    const page = await runtime.sessions.transcriptPage({ sessionId: session.id });
    await runtime.sessions.transcriptSearch({
      sessionId: session.id,
      query: "history",
    });
    if (page?.entries[0] !== undefined) {
      await runtime.sessions.transcriptEntryChunk({
        sessionId: session.id,
        revision: page.revision,
        entryIndex: page.entries[0].index,
      });
    }
    const observation = await runtime.sessions.observe(
      session.id,
      () => undefined,
    );
    observation.close();
    await runtime.sessions.diagnostics({ sessionId: session.id });
    await runtime.sessions.getSettings(session.id);

    expect(await runtime.events.replay()).toEqual(beforeEvents);
    expect(await fs.readFile(sequencePath)).toEqual(beforeSequence);
    expect(replMock.loadSessionCalls).toBe(0);
    await runtime.close();
  });

  it("continues a fixed transcript snapshot after its source file disappears", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const sessionsDir = path.join(tempRoot, "snapshot-source-sessions");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
    });
    const session = await runtime.sessions.create({
      sessionId: "snapshot-source-disappears",
      title: "Snapshot Source Disappears",
    });
    for (const content of ["one", "two", "three"]) {
      await runtime.sessions.appendNotice({
        sessionId: session.id,
        source: "snapshot-source",
        content,
      });
    }
    const first = await runtime.sessions.transcriptPage({
      sessionId: session.id,
      limit: 1,
    });
    expect(first?.nextCursor).toEqual(expect.any(String));
    const sessionFiles = await fs.readdir(sessionsDir, { recursive: true });
    const relativeSource = sessionFiles.find(
      (candidate) => path.basename(candidate) === `${session.id}.jsonl`,
    );
    if (relativeSource === undefined) {
      throw new Error(`Session file not found for ${session.id}`);
    }
    const source = path.join(sessionsDir, relativeSource);
    const movedSource = `${source}.moved`;
    await fs.rename(source, movedSource);

    const second = await runtime.sessions.transcriptPage({
      sessionId: session.id,
      cursor: first!.nextCursor,
      limit: 1,
    });
    expect(second?.revision).toBe(first?.revision);
    expect(second?.entries[0]?.entry?.message.content).toBe("two");
    const chunk = await runtime.sessions.transcriptEntryChunk({
      sessionId: session.id,
      revision: first!.revision,
      entryIndex: first!.entries[0]!.index,
    });
    expect(
      Buffer.from(chunk!.data, "base64").toString("utf8"),
    ).toContain("three");
    await fs.rename(movedSource, source);
    await runtime.close();
  });

  it("reuses the same immutable file for concurrent equal transcript revisions", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "snapshot-concurrent-sessions"),
    });
    let open: ReturnType<typeof vi.spyOn> | undefined;
    let releaseRead: (() => void) | undefined;
    let markReadBlocked: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readBlocked = new Promise<void>((resolve) => {
      markReadBlocked = resolve;
    });
    try {
      const session = await runtime.sessions.create({
        sessionId: "snapshot-concurrent",
      });
      await runtime.sessions.appendNotice({
        sessionId: session.id,
        source: "snapshot-concurrent",
        content: "same revision",
      });
      const baseline = await runtime.sessions.transcriptPage({
        sessionId: session.id,
      });
      const originalOpen = fs.open.bind(fs);
      let blockNextRead = true;
      open = vi.spyOn(fs, "open").mockImplementation(
        async (file, flags, mode) => {
          if (
            blockNextRead
            && String(file).endsWith(".entries")
            && String(flags) === "r"
          ) {
            blockNextRead = false;
            markReadBlocked?.();
            await readGate;
          }
          return originalOpen(file, flags, mode);
        },
      );

      const first = runtime.sessions.transcriptPage({
        sessionId: session.id,
      });
      await readBlocked;
      const second = await runtime.sessions.transcriptPage({
        sessionId: session.id,
      });
      releaseRead?.();

      await expect(first).resolves.toMatchObject({
        revision: baseline!.revision,
      });
      expect(second?.revision).toBe(baseline?.revision);
    } finally {
      releaseRead?.();
      open?.mockRestore();
      await runtime.close();
    }
  });

  it("keeps an in-flight transcript reader alive across cache eviction", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "snapshot-reader-lease-sessions"),
    });
    let open: ReturnType<typeof vi.spyOn> | undefined;
    let releaseRead: (() => void) | undefined;
    let markReadBlocked: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readBlocked = new Promise<void>((resolve) => {
      markReadBlocked = resolve;
    });
    try {
      const session = await runtime.sessions.create({
        sessionId: "snapshot-reader-lease",
      });
      for (const content of ["one", "two"]) {
        await runtime.sessions.appendNotice({
          sessionId: session.id,
          source: "snapshot-reader-lease",
          content,
        });
      }
      const boundary = await runtime.sessions.transcriptPage({
        sessionId: session.id,
        limit: 1,
      });
      const originalOpen = fs.open.bind(fs);
      let blockNextRead = true;
      open = vi.spyOn(fs, "open").mockImplementation(
        async (file, flags, mode) => {
          if (
            blockNextRead
            && String(file).endsWith(".entries")
            && String(flags) === "r"
          ) {
            blockNextRead = false;
            markReadBlocked?.();
            await readGate;
          }
          return originalOpen(file, flags, mode);
        },
      );

      const retainedPage = runtime.sessions.transcriptPage({
        sessionId: session.id,
        cursor: boundary!.nextCursor,
        limit: 1,
      });
      await readBlocked;
      for (let index = 0; index < 8; index += 1) {
        const pressure = await runtime.sessions.create({
          sessionId: `snapshot-pressure-${index}`,
        });
        await runtime.sessions.appendNotice({
          sessionId: pressure.id,
          source: "snapshot-pressure",
          content: String(index),
        });
        await runtime.sessions.transcriptPage({ sessionId: pressure.id });
      }
      releaseRead?.();

      await expect(retainedPage).resolves.toMatchObject({
        revision: boundary!.revision,
        entries: [expect.objectContaining({
          entry: expect.objectContaining({
            message: expect.objectContaining({ content: "one" }),
          }),
        })],
      });
      await expect(runtime.sessions.transcriptPage({
        sessionId: session.id,
        cursor: boundary!.nextCursor,
      })).rejects.toMatchObject({ code: "resync_required" });
    } finally {
      releaseRead?.();
      open?.mockRestore();
      await runtime.close();
    }
  });

  it("requires resync when an immutable transcript snapshot is corrupted", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const snapshotDirsBefore = new Set(
      (await fs.readdir(os.tmpdir())).filter((name) =>
        name.startsWith("kodax-transcript-snapshots-")
      ),
    );
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "snapshot-integrity-sessions"),
    });
    try {
      const session = await runtime.sessions.create({
        sessionId: "snapshot-integrity",
      });
      await runtime.sessions.appendNotice({
        sessionId: session.id,
        source: "snapshot-integrity",
        content: `integrity-marker-${"x".repeat(256 * 1024)}`,
      });
      const first = await runtime.sessions.transcriptPage({
        sessionId: session.id,
      });
      const snapshotDirName = (await fs.readdir(os.tmpdir())).find(
        (name) =>
          name.startsWith("kodax-transcript-snapshots-")
          && !snapshotDirsBefore.has(name),
      );
      if (snapshotDirName === undefined) {
        throw new Error("Transcript snapshot directory was not created.");
      }
      const snapshotDir = path.join(os.tmpdir(), snapshotDirName);
      const snapshotFile = path.join(
        snapshotDir,
        (await fs.readdir(snapshotDir)).find((name) =>
          name.endsWith(".entries")
        )!,
      );
      const corrupted = await fs.readFile(snapshotFile);
      const markerOffset = corrupted.indexOf("integrity-marker");
      if (markerOffset < 0) throw new Error("Snapshot marker was not found.");
      corrupted[markerOffset] = corrupted[markerOffset] === 0x69 ? 0x6a : 0x69;
      await fs.writeFile(snapshotFile, corrupted);

      await expect(runtime.sessions.transcriptEntryChunk({
        sessionId: session.id,
        revision: first!.revision,
        entryIndex: 0,
      })).rejects.toMatchObject({ code: "resync_required" });

      const recovered = await runtime.sessions.transcriptPage({
        sessionId: session.id,
      });
      expect(recovered?.revision).toBe(first?.revision);
      const recoveredChunk = await runtime.sessions.transcriptEntryChunk({
        sessionId: session.id,
        revision: recovered!.revision,
        entryIndex: 0,
      });
      expect(Buffer.from(recoveredChunk!.data, "base64").toString("utf8"))
        .toContain("integrity-marker");
    } finally {
      await runtime.close();
    }
  });

  it("does not return snapshot success after its read budget expires or is cancelled", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const originalOpen = fs.open.bind(fs);
    const open = vi.spyOn(fs, "open").mockImplementation(
      async (file, flags, mode) => {
        if (String(file).endsWith(".entries")) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 150);
          });
        }
        return originalOpen(file, flags, mode);
      },
    );
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "snapshot-budget-read-sessions"),
    });
    try {
      const session = await runtime.sessions.create({
        sessionId: "snapshot-budget-read",
      });
      await runtime.sessions.appendNotice({
        sessionId: session.id,
        source: "snapshot-budget-read",
        content: "history",
      });
      const timeoutStartedAt = Date.now();
      await expect(runtime.sessions.transcriptPage(
        { sessionId: session.id },
        { timeoutMs: 20 },
      )).rejects.toMatchObject({ code: "read_timeout" });
      expect(Date.now() - timeoutStartedAt).toBeLessThan(100);

      const controller = new AbortController();
      const cancelStartedAt = Date.now();
      const cancelled = runtime.sessions.transcriptPage(
        { sessionId: session.id },
        { signal: controller.signal },
      );
      setTimeout(() => controller.abort(), 20);
      await expect(cancelled).rejects.toMatchObject({
        code: "read_cancelled",
      });
      expect(Date.now() - cancelStartedAt).toBeLessThan(100);
    } finally {
      open.mockRestore();
      await runtime.close();
    }
  });

  it("rejects one transcript snapshot larger than the hard disk budget", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const snapshotDirsBefore = new Set(
      (await fs.readdir(os.tmpdir())).filter((name) =>
        name.startsWith("kodax-transcript-snapshots-")
      ),
    );
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "snapshot-hard-budget-sessions"),
    });
    try {
      const retained = await runtime.sessions.create({
        sessionId: "snapshot-hard-budget-retained",
      });
      for (const content of ["retained one", "retained two"]) {
        await runtime.sessions.appendNotice({
          sessionId: retained.id,
          source: "snapshot-hard-budget-retained",
          content,
        });
      }
      const retainedBoundary = await runtime.sessions.transcriptPage({
        sessionId: retained.id,
        limit: 1,
      });
      const session = await runtime.sessions.create({
        sessionId: "snapshot-hard-budget",
      });
      await runtime.sessions.appendNotice({
        sessionId: session.id,
        source: "snapshot-hard-budget",
        content: "x".repeat(33 * 1024 * 1024),
      });

      await expect(runtime.sessions.transcriptPage({
        sessionId: session.id,
      })).rejects.toMatchObject({ code: "overloaded" });
      await expect(runtime.sessions.transcriptPage({
        sessionId: retained.id,
        cursor: retainedBoundary!.nextCursor,
      })).resolves.toMatchObject({
        revision: retainedBoundary!.revision,
      });

      await vi.waitFor(async () => {
        const snapshotDirNames = (await fs.readdir(os.tmpdir())).filter(
          (name) =>
            name.startsWith("kodax-transcript-snapshots-")
            && !snapshotDirsBefore.has(name),
        );
        const byteSizes = await Promise.all(snapshotDirNames.flatMap(
          async (name) => {
            const snapshotDir = path.join(os.tmpdir(), name);
            return Promise.all((await fs.readdir(snapshotDir)).map(
              async (fileName) =>
                (await fs.stat(path.join(snapshotDir, fileName))).size,
            ));
          },
        ));
        expect(byteSizes.flat().reduce((sum, size) => sum + size, 0))
          .toBeLessThanOrEqual(64 * 1024 * 1024);
      });
    } finally {
      await runtime.close();
    }
  }, 30_000);

  it("does not evict retained cursors when a multi-entry snapshot is oversized", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "snapshot-atomic-budget-sessions"),
    });
    try {
      const retained = await runtime.sessions.create({
        sessionId: "snapshot-atomic-budget-retained",
      });
      await runtime.sessions.appendNotice({
        sessionId: retained.id,
        source: "snapshot-atomic-budget",
        content: "r".repeat(18 * 1024 * 1024),
      });
      await runtime.sessions.appendNotice({
        sessionId: retained.id,
        source: "snapshot-atomic-budget",
        content: "retained tail",
      });
      const retainedBoundary = await runtime.sessions.transcriptPage({
        sessionId: retained.id,
        limit: 1,
      });

      const oversized = await runtime.sessions.create({
        sessionId: "snapshot-atomic-budget-oversized",
      });
      for (const marker of ["a", "b"]) {
        await runtime.sessions.appendNotice({
          sessionId: oversized.id,
          source: "snapshot-atomic-budget",
          content: marker.repeat(17 * 1024 * 1024),
        });
      }
      await expect(runtime.sessions.transcriptPage({
        sessionId: oversized.id,
      })).rejects.toMatchObject({ code: "overloaded" });
      await expect(runtime.sessions.transcriptPage({
        sessionId: retained.id,
        cursor: retainedBoundary!.nextCursor,
      })).resolves.toMatchObject({
        revision: retainedBoundary!.revision,
      });
    } finally {
      await runtime.close();
    }
  }, 30_000);

  it("keeps deleted in-flight snapshot generations inside the hard disk budget", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "snapshot-concurrent-budget-sessions"),
    });
    const originalOpen = nodeFsPromises.open.bind(nodeFsPromises);
    let releaseFirstWrite: (() => void) | undefined;
    let markFirstWriteStarted: (() => void) | undefined;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const firstWriteStarted = new Promise<void>((resolve) => {
      markFirstWriteStarted = resolve;
    });
    let firstSnapshotPath: string | undefined;
    let blockFirstSnapshotWrite = true;
    const open = vi.spyOn(nodeFsPromises, "open").mockImplementation(
      async (file, flags, mode) => {
        const handle = await originalOpen(file, flags, mode);
        if (
          !blockFirstSnapshotWrite
          || !String(file).endsWith(".entries")
          || String(flags) !== "wx"
        ) {
          return handle;
        }
        blockFirstSnapshotWrite = false;
        firstSnapshotPath = String(file);
        return {
          write: async (
            buffer: Uint8Array,
            offset?: number,
            length?: number,
            position?: number | null,
          ) => {
            markFirstWriteStarted?.();
            await firstWriteGate;
            return handle.write(buffer, offset, length, position);
          },
          close: () => handle.close(),
        } as unknown as Awaited<ReturnType<typeof originalOpen>>;
      },
    );
    try {
      const first = await runtime.sessions.create({
        sessionId: "snapshot-concurrent-budget-first",
      });
      await runtime.sessions.appendNotice({
        sessionId: first.id,
        source: "snapshot-concurrent-budget",
        content: "a".repeat(20 * 1024 * 1024),
      });
      const second = await runtime.sessions.create({
        sessionId: "snapshot-concurrent-budget-second",
      });
      await runtime.sessions.appendNotice({
        sessionId: second.id,
        source: "snapshot-concurrent-budget",
        content: "b".repeat(15 * 1024 * 1024),
      });

      const firstPage = runtime.sessions.transcriptPage({
        sessionId: first.id,
      });
      await firstWriteStarted;
      await fs.rm(path.dirname(firstSnapshotPath!), {
        recursive: true,
        force: true,
      });
      await expect(runtime.sessions.transcriptPage({
        sessionId: second.id,
      })).rejects.toMatchObject({ code: "overloaded" });
      releaseFirstWrite?.();
      await expect(firstPage).rejects.toMatchObject({
        code: "resync_required",
      });
    } finally {
      releaseFirstWrite?.();
      open.mockRestore();
      await runtime.close();
    }
  }, 30_000);

  it("bounds concurrent snapshot files before opening more handles", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "snapshot-file-budget-sessions"),
    });
    const sessions = await Promise.all(Array.from(
      { length: 17 },
      (_, index) => runtime.sessions.create({
        sessionId: `snapshot-file-budget-${index}`,
      }),
    ));
    const originalOpen = nodeFsPromises.open.bind(nodeFsPromises);
    let releaseOpen: (() => void) | undefined;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    let pendingSnapshotOpens = 0;
    const open = vi.spyOn(nodeFsPromises, "open").mockImplementation(
      async (file, flags, mode) => {
        if (String(file).endsWith(".entries") && String(flags) === "wx") {
          pendingSnapshotOpens += 1;
          await openGate;
        }
        return originalOpen(file, flags, mode);
      },
    );
    try {
      const pending = sessions.slice(0, 16).map((session) =>
        runtime.sessions.transcriptPage({ sessionId: session.id })
      );
      await vi.waitFor(() => {
        expect(pendingSnapshotOpens).toBe(16);
      });

      await expect(runtime.sessions.transcriptPage({
        sessionId: sessions[16]!.id,
      })).rejects.toMatchObject({
        code: "overloaded",
        data: {
          resource: "transcript_snapshot_io",
          limit: 16,
        },
      });

      releaseOpen?.();
      await expect(Promise.all(pending)).resolves.toHaveLength(16);
    } finally {
      releaseOpen?.();
      open.mockRestore();
      await runtime.close();
    }
  });

  it("bounds close while snapshot materialization remains blocked", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "snapshot-close-materialization"),
    });
    const emittedWarning = vi.spyOn(process, "emitWarning").mockImplementation(
      () => undefined,
    );
    const originalOpen = nodeFsPromises.open.bind(nodeFsPromises);
    let releaseWrite: (() => void) | undefined;
    let markWriteStarted: (() => void) | undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    let blockFirstSnapshotWrite = true;
    const open = vi.spyOn(nodeFsPromises, "open").mockImplementation(
      async (file, flags, mode) => {
        const handle = await originalOpen(file, flags, mode);
        if (
          !blockFirstSnapshotWrite
          || !String(file).endsWith(".entries")
          || String(flags) !== "wx"
        ) {
          return handle;
        }
        blockFirstSnapshotWrite = false;
        return {
          write: async (
            buffer: Uint8Array,
            offset?: number,
            length?: number,
            position?: number | null,
          ) => {
            markWriteStarted?.();
            await writeGate;
            return handle.write(buffer, offset, length, position);
          },
          close: () => handle.close(),
        } as unknown as Awaited<ReturnType<typeof originalOpen>>;
      },
    );
    try {
      const session = await runtime.sessions.create({
        sessionId: "snapshot-close-materialization",
      });
      for (const content of ["one", "two"]) {
        await runtime.sessions.appendNotice({
          sessionId: session.id,
          source: "snapshot-close-materialization",
          content,
        });
      }

      const page = runtime.sessions.transcriptPage({
        sessionId: session.id,
      });
      const pageResult = expect(page).rejects.toMatchObject({
        code: "read_cancelled",
      });
      await writeStarted;
      let closeSettled = false;
      const close = runtime.close().finally(() => {
        closeSettled = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(closeSettled).toBe(false);

      await expect(Promise.race([
        close,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("Runtime close remained blocked")), 1_000);
        }),
      ])).resolves.toBeUndefined();
      expect(closeSettled).toBe(true);
      expect(emittedWarning).toHaveBeenCalledWith(
        expect.stringContaining("snapshot I/O was still pending"),
        { code: "KODAX_TRANSCRIPT_SNAPSHOT_CLOSE_DEFERRED" },
      );

      releaseWrite?.();
      await pageResult;
    } finally {
      releaseWrite?.();
      open.mockRestore();
      emittedWarning.mockRestore();
      await runtime.close();
    }
  });

  it("retries snapshot directory cleanup after close fails once", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const snapshotDirsBefore = new Set(
      (await fs.readdir(os.tmpdir())).filter((name) =>
        name.startsWith("kodax-transcript-snapshots-")
      ),
    );
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "snapshot-close-retry-sessions"),
    });
    const session = await runtime.sessions.create({
      sessionId: "snapshot-close-retry",
    });
    await runtime.sessions.appendNotice({
      sessionId: session.id,
      source: "snapshot-close-retry",
      content: "history",
    });
    await runtime.sessions.transcriptPage({ sessionId: session.id });
    const snapshotDirName = (await fs.readdir(os.tmpdir())).find(
      (name) =>
        name.startsWith("kodax-transcript-snapshots-")
        && !snapshotDirsBefore.has(name),
    );
    if (snapshotDirName === undefined) {
      throw new Error("Transcript snapshot directory was not created.");
    }
    const snapshotDir = path.join(os.tmpdir(), snapshotDirName);
    const { createRequire, syncBuiltinESMExports } = await import("node:module");
    const mutableFs = createRequire(import.meta.url)("node:fs") as {
      rmSync: typeof import("node:fs").rmSync;
    };
    const originalRmSync = mutableFs.rmSync;
    let failCleanupOnce = true;
    mutableFs.rmSync = ((file, options) => {
      if (failCleanupOnce && path.resolve(String(file)) === snapshotDir) {
        failCleanupOnce = false;
        throw Object.assign(new Error("snapshot cleanup failed once"), {
          code: "EACCES",
        });
      }
      return originalRmSync(file, options);
    }) as typeof import("node:fs").rmSync;
    syncBuiltinESMExports();
    try {
      await expect(runtime.close()).rejects.toThrow(
        "snapshot cleanup failed once",
      );
      await expect(runtime.close()).resolves.toBeUndefined();
      await expect(fs.stat(snapshotDir)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      mutableFs.rmSync = originalRmSync;
      syncBuiltinESMExports();
      await runtime.close();
    }
  });

  it("does not recreate snapshot storage when a pre-close read resumes", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "snapshot-close-race-sessions"),
    });
    const session = await runtime.sessions.create({
      sessionId: "snapshot-close-race",
    });
    const snapshotDirsBefore = new Set(
      (await fs.readdir(os.tmpdir())).filter((name) =>
        name.startsWith("kodax-transcript-snapshots-")
      ),
    );
    const originalOpen = nodeFsPromises.open.bind(nodeFsPromises);
    let releaseOpen: (() => void) | undefined;
    let markOpenBlocked: (() => void) | undefined;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const openBlocked = new Promise<void>((resolve) => {
      markOpenBlocked = resolve;
    });
    let blockSnapshotOpen = true;
    const open = vi.spyOn(nodeFsPromises, "open").mockImplementation(
      async (file, flags, mode) => {
        if (
          blockSnapshotOpen
          && String(file).endsWith(".entries")
          && String(flags) === "wx"
        ) {
          blockSnapshotOpen = false;
          markOpenBlocked?.();
          await openGate;
          throw Object.assign(new Error("snapshot directory closed"), {
            code: "ENOENT",
          });
        }
        return originalOpen(file, flags, mode);
      },
    );
    try {
      const page = runtime.sessions.transcriptPage({
        sessionId: session.id,
      });
      const pageCancellation = expect(page).rejects.toMatchObject({
        code: "read_cancelled",
      });
      await openBlocked;
      let closeSettled = false;
      const close = runtime.close().finally(() => {
        closeSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closeSettled).toBe(false);
      releaseOpen?.();
      await pageCancellation;
      await expect(close).resolves.toBeUndefined();

      const snapshotDirsAfter = (await fs.readdir(os.tmpdir())).filter(
        (name) =>
          name.startsWith("kodax-transcript-snapshots-")
          && !snapshotDirsBefore.has(name),
      );
      expect(snapshotDirsAfter).toEqual([]);
    } finally {
      releaseOpen?.();
      open.mockRestore();
      await runtime.close();
    }
  });

  it("normalizes transcript snapshot storage failures", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "snapshot-storage-error-sessions"),
    });
    const session = await runtime.sessions.create({
      sessionId: "snapshot-storage-error",
    });
    const originalOpen = nodeFsPromises.open.bind(nodeFsPromises);
    const open = vi.spyOn(nodeFsPromises, "open").mockImplementation(
      async (file, flags, mode) => {
        if (
          String(file).endsWith(".entries")
          && String(flags) === "wx"
        ) {
          throw Object.assign(new Error("snapshot storage unavailable"), {
            code: "EACCES",
          });
        }
        return originalOpen(file, flags, mode);
      },
    );
    try {
      await expect(runtime.sessions.transcriptPage({
        sessionId: session.id,
      })).rejects.toMatchObject({ code: "internal_error" });
    } finally {
      open.mockRestore();
      await runtime.close();
    }
  });

  it("requires resync when transcript snapshot storage disappears", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "snapshot-storage-missing-sessions"),
    });
    const session = await runtime.sessions.create({
      sessionId: "snapshot-storage-missing",
    });
    const originalOpen = nodeFsPromises.open.bind(nodeFsPromises);
    const open = vi.spyOn(nodeFsPromises, "open").mockImplementation(
      async (file, flags, mode) => {
        if (
          String(file).endsWith(".entries")
          && String(flags) === "wx"
        ) {
          throw Object.assign(new Error("snapshot storage disappeared"), {
            code: "ENOENT",
          });
        }
        return originalOpen(file, flags, mode);
      },
    );
    try {
      await expect(runtime.sessions.transcriptPage({
        sessionId: session.id,
      })).rejects.toMatchObject({ code: "resync_required" });
    } finally {
      open.mockRestore();
      await runtime.close();
    }
  });

  it("times out promptly while reading a retained transcript chunk", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "snapshot-chunk-timeout-sessions"),
    });
    let open: ReturnType<typeof vi.spyOn> | undefined;
    let releaseRead: (() => void) | undefined;
    let markReadStarted: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let snapshotPath: string | undefined;
    const emittedWarning = vi.spyOn(process, "emitWarning").mockImplementation(
      () => undefined,
    );
    try {
      const session = await runtime.sessions.create({
        sessionId: "snapshot-chunk-timeout",
      });
      await runtime.sessions.appendNotice({
        sessionId: session.id,
        source: "snapshot-chunk-timeout",
        content: "x".repeat(256 * 1024),
      });
      const page = await runtime.sessions.transcriptPage({
        sessionId: session.id,
      });
      const originalOpen = fs.open.bind(fs);
      let blockFirstRead = true;
      open = vi.spyOn(fs, "open").mockImplementation(
        async (file, flags, mode) => {
          const handle = await originalOpen(file, flags, mode);
          if (
            !blockFirstRead
            || !String(file).endsWith(".entries")
            || String(flags) !== "r"
          ) {
            return handle;
          }
          blockFirstRead = false;
          snapshotPath = String(file);
          return {
            read: async (
              buffer: Uint8Array,
              offset?: number,
              length?: number,
              position?: number | null,
            ) => {
              markReadStarted?.();
              await readGate;
              return handle.read(buffer, offset, length, position);
            },
            close: () => handle.close(),
          } as unknown as Awaited<ReturnType<typeof originalOpen>>;
        },
      );

      const startedAt = Date.now();
      const chunk = runtime.sessions.transcriptEntryChunk(
        {
          sessionId: session.id,
          revision: page!.revision,
          entryIndex: 0,
        },
        { timeoutMs: 20 },
      );
      await readStarted;
      await expect(chunk).rejects.toMatchObject({ code: "read_timeout" });
      expect(Date.now() - startedAt).toBeLessThan(100);

      for (let index = 0; index < 8; index += 1) {
        const pressure = await runtime.sessions.create({
          sessionId: `snapshot-timeout-pressure-${index}`,
        });
        await runtime.sessions.appendNotice({
          sessionId: pressure.id,
          source: "snapshot-timeout-pressure",
          content: String(index),
        });
        await runtime.sessions.transcriptPage({ sessionId: pressure.id });
      }
      expect((await fs.stat(snapshotPath!)).isFile()).toBe(true);

      await expect(Promise.race([
        runtime.close(),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("Runtime close remained blocked")), 1_000);
        }),
      ])).resolves.toBeUndefined();
      expect(emittedWarning).toHaveBeenCalledWith(
        expect.stringContaining("snapshot I/O was still pending"),
        { code: "KODAX_TRANSCRIPT_SNAPSHOT_CLOSE_DEFERRED" },
      );

      releaseRead?.();
      await vi.waitFor(async () => {
        await expect(fs.stat(snapshotPath!)).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
    } finally {
      releaseRead?.();
      open?.mockRestore();
      emittedWarning.mockRestore();
      await runtime.close();
    }
  });

  it("bounds concurrent snapshot readers for one retained file", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "snapshot-reader-budget-sessions"),
    });
    const session = await runtime.sessions.create({
      sessionId: "snapshot-reader-budget",
    });
    await runtime.sessions.appendNotice({
      sessionId: session.id,
      source: "snapshot-reader-budget",
      content: "reader budget",
    });
    const page = await runtime.sessions.transcriptPage({
      sessionId: session.id,
    });
    const originalOpen = nodeFsPromises.open.bind(nodeFsPromises);
    let releaseReads: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    let openReaders = 0;
    const open = vi.spyOn(nodeFsPromises, "open").mockImplementation(
      async (file, flags, mode) => {
        const handle = await originalOpen(file, flags, mode);
        if (!String(file).endsWith(".entries") || String(flags) !== "r") {
          return handle;
        }
        openReaders += 1;
        return {
          read: async (
            buffer: Uint8Array,
            offset?: number,
            length?: number,
            position?: number | null,
          ) => {
            await readGate;
            return handle.read(buffer, offset, length, position);
          },
          close: () => handle.close(),
        } as unknown as Awaited<ReturnType<typeof originalOpen>>;
      },
    );
    try {
      const reads = Array.from(
        { length: 16 },
        () => runtime.sessions.transcriptEntryChunk({
          sessionId: session.id,
          revision: page!.revision,
          entryIndex: 0,
        }),
      );
      await vi.waitFor(() => {
        expect(openReaders).toBe(16);
      });

      await expect(runtime.sessions.transcriptEntryChunk({
        sessionId: session.id,
        revision: page!.revision,
        entryIndex: 0,
      })).rejects.toMatchObject({
        code: "overloaded",
        data: {
          resource: "transcript_snapshot_io",
          limit: 16,
        },
      });

      releaseReads?.();
      await expect(Promise.all(reads)).resolves.toHaveLength(16);
    } finally {
      releaseReads?.();
      open.mockRestore();
      await runtime.close();
    }
  });

  it("prunes expired transcript snapshot directories left by a crashed Runtime", async () => {
    const staleDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "kodax-transcript-snapshots-"),
    );
    await fs.writeFile(path.join(staleDir, "orphan.entries"), "old history");
    const staleAt = new Date(Date.now() - 10 * 60_000);
    await fs.utimes(staleDir, staleAt, staleAt);
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "snapshot-stale-dir-sessions"),
    });
    try {
      const session = await runtime.sessions.create({
        sessionId: "snapshot-stale-dir",
      });
      await runtime.sessions.appendNotice({
        sessionId: session.id,
        source: "snapshot-stale-dir",
        content: "fresh history",
      });
      const first = await runtime.sessions.transcriptPage({
        sessionId: session.id,
      });
      await expect(fs.stat(staleDir)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(staleDir, { recursive: true, force: true });
      await runtime.close();
    }
  });

  it("rebuilds its snapshot directory after external deletion", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const snapshotDirsBefore = new Set(
      (await fs.readdir(os.tmpdir())).filter((name) =>
        name.startsWith("kodax-transcript-snapshots-")
      ),
    );
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "snapshot-directory-rebuild-sessions"),
    });
    try {
      const session = await runtime.sessions.create({
        sessionId: "snapshot-directory-rebuild",
      });
      for (const content of ["one", "two"]) {
        await runtime.sessions.appendNotice({
          sessionId: session.id,
          source: "snapshot-directory-rebuild",
          content,
        });
      }
      const first = await runtime.sessions.transcriptPage({
        sessionId: session.id,
        limit: 1,
      });
      const snapshotDirName = (await fs.readdir(os.tmpdir())).find(
        (name) =>
          name.startsWith("kodax-transcript-snapshots-")
          && !snapshotDirsBefore.has(name),
      );
      if (snapshotDirName === undefined) {
        throw new Error("Transcript snapshot directory was not created.");
      }
      await fs.rm(path.join(os.tmpdir(), snapshotDirName), {
        recursive: true,
        force: true,
      });

      await expect(runtime.sessions.transcriptPage({
        sessionId: session.id,
        cursor: first!.nextCursor,
      })).rejects.toMatchObject({ code: "resync_required" });
      await expect(runtime.sessions.transcriptPage({
        sessionId: session.id,
      })).resolves.toMatchObject({
        revision: expect.any(String),
        entries: expect.any(Array),
      });
    } finally {
      await runtime.close();
    }
  });

  it("removes expired snapshot files without requiring another history read", async () => {
    vi.useFakeTimers();
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const snapshotDirsBefore = new Set(
      (await fs.readdir(os.tmpdir())).filter((name) =>
        name.startsWith("kodax-transcript-snapshots-")
      ),
    );
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "snapshot-heartbeat-ttl-sessions"),
    });
    try {
      const session = await runtime.sessions.create({
        sessionId: "snapshot-heartbeat-ttl",
      });
      await runtime.sessions.appendNotice({
        sessionId: session.id,
        source: "snapshot-heartbeat-ttl",
        content: "expires without another read",
      });
      const first = await runtime.sessions.transcriptPage({
        sessionId: session.id,
      });
      const snapshotDirName = (await fs.readdir(os.tmpdir())).find(
        (name) =>
          name.startsWith("kodax-transcript-snapshots-")
          && !snapshotDirsBefore.has(name),
      );
      if (snapshotDirName === undefined) {
        throw new Error("Transcript snapshot directory was not created.");
      }
      const snapshotDir = path.join(os.tmpdir(), snapshotDirName);
      expect(
        (await fs.readdir(snapshotDir)).some((name) =>
          name.endsWith(".entries")
        ),
      ).toBe(true);

      await vi.advanceTimersByTimeAsync(6 * 60_000);

      expect(
        (await fs.readdir(snapshotDir)).some((name) =>
          name.endsWith(".entries")
        ),
      ).toBe(false);
    } finally {
      await runtime.close();
      vi.useRealTimers();
    }
  });

  it("contains snapshot cleanup failures inside the lease heartbeat", async () => {
    vi.useFakeTimers();
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const snapshotDirsBefore = new Set(
      (await fs.readdir(os.tmpdir())).filter((name) =>
        name.startsWith("kodax-transcript-snapshots-")
      ),
    );
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(
      () => undefined,
    );
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "snapshot-heartbeat-error-sessions"),
    });
    try {
      const session = await runtime.sessions.create({
        sessionId: "snapshot-heartbeat-error",
      });
      await runtime.sessions.appendNotice({
        sessionId: session.id,
        source: "snapshot-heartbeat-error",
        content: "cleanup failure stays observable",
      });
      const first = await runtime.sessions.transcriptPage({
        sessionId: session.id,
      });
      let snapshotFile: string | undefined;
      for (const snapshotDirName of await fs.readdir(os.tmpdir())) {
        if (
          !snapshotDirName.startsWith("kodax-transcript-snapshots-")
          || snapshotDirsBefore.has(snapshotDirName)
        ) {
          continue;
        }
        const snapshotDir = path.join(os.tmpdir(), snapshotDirName);
        for (const snapshotFileName of await fs.readdir(snapshotDir)) {
          if (!snapshotFileName.endsWith(".entries")) continue;
          const candidate = path.join(snapshotDir, snapshotFileName);
          if (
            (await fs.stat(candidate)).isFile()
            && (await fs.readFile(candidate, "utf8")).includes(
              "cleanup failure stays observable",
            )
          ) {
            snapshotFile = candidate;
            break;
          }
        }
        if (snapshotFile !== undefined) break;
      }
      if (snapshotFile === undefined) {
        throw new Error("Transcript snapshot file was not created.");
      }
      await fs.rm(snapshotFile);
      await fs.mkdir(snapshotFile);

      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("Unable to remove transcript snapshot"),
        { code: "KODAX_TRANSCRIPT_SNAPSHOT_CLEANUP_FAILED" },
      );
      await expect(runtime.sessions.transcriptEntryChunk({
        sessionId: session.id,
        revision: first!.revision,
        entryIndex: 0,
      })).rejects.toMatchObject({ code: "resync_required" });
      await expect(runtime.sessions.transcriptPage({
        sessionId: session.id,
      })).resolves.toMatchObject({
        entries: expect.any(Array),
        revision: expect.any(String),
      });
      await fs.rm(snapshotFile, { recursive: true });
      await fs.writeFile(snapshotFile, "retry cleanup");
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      await expect(fs.stat(snapshotFile)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      warning.mockRestore();
      await runtime.close();
      vi.useRealTimers();
    }
  });

  it("expires fixed transcript snapshots with an explicit resync requirement", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "snapshot-ttl-sessions"),
    });
    const session = await runtime.sessions.create({
      sessionId: "snapshot-ttl",
    });
    for (const content of ["one", "two"]) {
      await runtime.sessions.appendNotice({
        sessionId: session.id,
        source: "snapshot-ttl",
        content,
      });
    }
    const first = await runtime.sessions.transcriptPage({
      sessionId: session.id,
      limit: 1,
    });
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60_000);
    try {
      await expect(runtime.sessions.transcriptPage({
        sessionId: session.id,
        cursor: first!.nextCursor,
        limit: 1,
      })).rejects.toMatchObject({ code: "resync_required" });
    } finally {
      nowSpy.mockRestore();
      await runtime.close();
    }
  });

  it("evicts transcript snapshots by total bytes before the count limit", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "snapshot-budget-sessions"),
    });
    const cursors: string[] = [];
    const ids = Array.from(
      { length: 8 },
      (_, index) => `snapshot-budget-${index + 1}`,
    );
    for (const id of ids) {
      const session = await runtime.sessions.create({ sessionId: id });
      await runtime.sessions.appendNotice({
        sessionId: session.id,
        source: "snapshot-budget",
        content: "x".repeat(9 * 1024 * 1024),
      });
      await runtime.sessions.appendNotice({
        sessionId: session.id,
        source: "snapshot-budget",
        content: "tail",
      });
      const first = await runtime.sessions.transcriptPage({
        sessionId: session.id,
        limit: 1,
      });
      expect(first?.nextCursor).toEqual(expect.any(String));
      cursors.push(first!.nextCursor!);
    }

    await expect(runtime.sessions.transcriptPage({
      sessionId: ids[0]!,
      cursor: cursors[0],
      limit: 1,
    })).rejects.toMatchObject({ code: "resync_required" });
    await expect(runtime.sessions.transcriptPage({
      sessionId: ids.at(-1)!,
      cursor: cursors.at(-1)!,
      limit: 1,
    })).resolves.toMatchObject({
      revision: expect.any(String),
    });
    await runtime.close();
  }, 30_000);

  it("rejects invalid transcript search queries before Session I/O", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "search-validation-sessions"),
    });
    try {
      await expect(runtime.sessions.transcriptSearch({
        sessionId: "missing-search-validation",
        query: "x".repeat(16 * 1024 + 1),
      })).rejects.toMatchObject({
        code: "invalid_params",
        data: { resource: "query" },
      });
      await expect(runtime.sessions.transcriptSearch({
        sessionId: "missing-search-validation",
        query: Array.from(
          { length: 129 },
          (_, index) => `term${index}`,
        ).join(" "),
      })).rejects.toMatchObject({
        code: "invalid_params",
        data: { resource: "query_terms" },
      });
    } finally {
      await runtime.close();
    }
  });

  it("rechecks cancellation after transcript snapshot search work", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "search-budget-sessions"),
    });
    try {
      const session = await runtime.sessions.create({
        sessionId: "search-budget",
      });
      await runtime.sessions.appendNotice({
        sessionId: session.id,
        source: "search-budget",
        content: "search cancellation marker",
      });
      const controller = new AbortController();
      const input = {
        sessionId: session.id,
        get query() {
          setImmediate(() => controller.abort());
          return "search cancellation marker";
        },
      };

      await expect(runtime.sessions.transcriptSearch(
        input,
        { signal: controller.signal },
      )).rejects.toMatchObject({ code: "read_cancelled" });
    } finally {
      await runtime.close();
    }
  });

  it("does not return transcript search success after its budget expires", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "search-timeout-sessions"),
    });
    try {
      const session = await runtime.sessions.create({
        sessionId: "search-timeout",
      });
      await runtime.sessions.appendNotice({
        sessionId: session.id,
        source: "search-timeout",
        content: "search timeout marker",
      });
      const input = {
        sessionId: session.id,
        get query() {
          const busyUntil = performance.now() + 150;
          while (performance.now() < busyUntil) {
            // Simulate a synchronous search stage that crosses its deadline.
          }
          return "search timeout marker";
        },
      };

      await expect(runtime.sessions.transcriptSearch(
        input,
        { timeoutMs: 100 },
      )).rejects.toMatchObject({ code: "read_timeout" });
    } finally {
      await runtime.close();
    }
  });

  it("keeps direct and paged transcripts in the same append order across island recovery", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const { createSessionManager } = await import("@kodax-ai/repl");
    const sessionsDir = path.join(tempRoot, "ordered-transcript-sessions");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
    });
    try {
      const session = await runtime.sessions.create({
        title: "Ordered Transcript",
        gitRoot: tempRoot,
      });
      const manager = createSessionManager({ sessionsDir });
      const timestamp = "2026-07-30T00:00:00.000Z";
      const initial = createSessionLineage([
        { role: "user", content: "retained parent", timestamp },
        { role: "assistant", content: "archived child", timestamp },
      ]);
      const retainedParent = initial.entries[0]!;
      const lineage = applySessionCompaction(
        {
          ...initial,
          entries: [
            ...initial.entries,
            {
              type: "label",
              id: "label_runtime_retained_parent",
              parentId: null,
              logicalId: "label_runtime_retained_parent",
              timestamp,
              targetId: retainedParent.id,
              label: "retain-parent",
            },
          ],
        },
        [
          { role: "system", content: "[对话历史摘要]\n\nold island" },
          { role: "user", content: "current island", timestamp },
        ],
        { summary: "old island" },
      );
      await manager.storage.save(session.id, {
        messages: getSessionMessagesFromLineage(lineage),
        title: "Ordered Transcript",
        gitRoot: tempRoot,
        lineage,
      });

      const [direct, concurrentDirect] = await Promise.all([
        runtime.sessions.transcript(session.id),
        runtime.sessions.transcript(session.id),
      ]);
      const directIds = direct?.transcriptEntries.map((entry) => entry.entryId) ?? [];
      const expectedIds = lineage.entries
        .filter((entry) => entry.type !== "label")
        .map((entry) => entry.id);
      expect(directIds).toEqual(expectedIds);
      const callerOwnedDirect = direct!.transcriptEntries[0]! as {
        message: { content: string };
      };
      callerOwnedDirect.message.content = "caller mutation";
      expect(concurrentDirect?.transcriptEntries[0]?.message.content).toBe(
        "retained parent",
      );

      const pagedIds: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await runtime.sessions.transcriptPage({
          sessionId: session.id,
          limit: 1,
          ...(cursor ? { cursor } : {}),
        });
        expect(page).not.toBeNull();
        pagedIds.unshift(...page!.entries.map((descriptor) => descriptor.entry!.entryId));
        cursor = page!.hasMore ? page!.nextCursor : undefined;
      } while (cursor);

      expect(pagedIds).toEqual(directIds);
    } finally {
      await runtime.close();
    }
  });

  it("keeps a reconciled v0.7.78 replay branch identical in direct and paged transcripts", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const { createSessionManager } = await import("@kodax-ai/repl");
    const sessionsDir = path.join(tempRoot, "legacy-replay-transcript-sessions");
    const runtime = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir });
    try {
      const session = await runtime.sessions.create({
        sessionId: "legacy-replay-transcript",
        title: "Legacy replay transcript",
      });
      const manager = createSessionManager({ sessionsDir });
      const active = createSessionLineage([
        { role: "user", content: "original query" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "legacy thought", signature: "sig" },
            { type: "text", text: "legacy answer" },
            { type: "tool_use", id: "legacy-tool", name: "read", input: {} },
          ],
        },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "legacy-tool",
            content: "legacy result",
          }],
        },
        { role: "assistant", content: "active suffix" },
      ]);
      const root = active.entries[0]!;
      const activeAssistant = active.entries[1]!;
      if (activeAssistant.type !== "message") throw new Error("expected message");
      const replayAssistant = {
        ...activeAssistant,
        id: "entry_runtime_legacy_replay",
        logicalId: "entry_runtime_legacy_replay",
        parentId: root.id,
      };
      const replayCarrier = {
        type: "message" as const,
        id: "entry_runtime_legacy_carrier",
        logicalId: "entry_runtime_legacy_carrier",
        parentId: replayAssistant.id,
        timestamp: "2026-07-29T00:00:00.000Z",
        message: {
          role: "system" as const,
          content: "[Post-compact: legacy context carrier]",
          _synthetic: true,
          _source: "compaction-context" as const,
        },
      };
      const legacy = JSON.parse(JSON.stringify({
        ...active,
        entries: [...active.entries, replayAssistant, replayCarrier],
      })) as typeof active;

      const legacyMessages = getSessionMessagesFromLineage(legacy);
      const legacyIds = legacy.entries.map((entry) => entry.id);
      const noChange = createSessionLineage(
        structuredClone(legacyMessages),
        legacy,
      );
      expect(noChange.entries.map((entry) => entry.id)).toEqual(legacyIds);
      await manager.storage.save(session.id, {
        messages: legacyMessages,
        title: "Legacy replay transcript",
        gitRoot: tempRoot,
        lineage: noChange,
      });
      const afterNoChangeSave = await runtime.sessions.transcript(session.id);
      expect(afterNoChangeSave?.transcriptEntries.map((entry) => entry.entryId))
        .toEqual(legacyIds);

      const nextMessages: KodaXMessage[] = [
        ...structuredClone(legacyMessages),
        { role: "user", content: "original query" },
      ];
      const beforeIds = new Set(noChange.entries.map((entry) => entry.id));
      const reconciled = createSessionLineage(nextMessages, noChange);
      expect(reconciled.entries.filter((entry) => !beforeIds.has(entry.id))).toHaveLength(1);
      await manager.storage.save(session.id, {
        messages: nextMessages,
        title: "Legacy replay transcript",
        gitRoot: tempRoot,
        lineage: reconciled,
      });

      const direct = await runtime.sessions.transcript(session.id);
      const directIds = direct?.transcriptEntries.map((entry) => entry.entryId) ?? [];
      const pagedIds: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await runtime.sessions.transcriptPage({
          sessionId: session.id,
          limit: 1,
          ...(cursor ? { cursor } : {}),
        });
        expect(page).not.toBeNull();
        pagedIds.unshift(...page!.entries.map((entry) => entry.entry!.entryId));
        cursor = page!.hasMore ? page!.nextCursor : undefined;
      } while (cursor);

      expect(pagedIds).toEqual(directIds);
      expect(new Set(directIds).size).toBe(directIds.length);
      expect(directIds).toEqual(reconciled.entries.map((entry) => entry.id));
    } finally {
      await runtime.close();
    }
  });

  it("searches exact compacted history through the Runtime session service", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const { createSessionManager } = await import("@kodax-ai/repl");
    const sessionsDir = path.join(tempRoot, "search-sessions");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
    });
    try {
      const session = await runtime.sessions.create({
        title: "Searchable transcript",
      });
      const manager = createSessionManager({ sessionsDir });
      const lineage = applySessionCompaction(
        createSessionLineage([
          { role: "user", content: "The exact historical code is ZX-4401." },
          {
            role: "assistant",
            content: "ZX-4401 was verified before compaction.",
          },
        ]),
        [{ role: "user", content: "active follow-up" }],
        { summary: "A historical code was verified." },
      );
      await manager.storage.save(session.id, {
        messages: [{ role: "user", content: "active follow-up" }],
        title: "Searchable transcript",
        gitRoot: tempRoot,
        lineage,
      });

      const result = await runtime.sessions.transcriptSearch({
        sessionId: session.id,
        query: "ZX-4401",
      });
      expect(result?.revision).toMatch(/^sha256:/);
      expect(result?.hits[0]).toMatchObject({
        active: false,
        entryIndex: expect.any(Number),
        citation: expect.stringMatching(/^session-history:entry_/),
      });
      const exact = await runtime.sessions.transcriptEntryChunk({
        sessionId: session.id,
        revision: result!.revision,
        entryIndex: result!.hits[0]!.entryIndex,
      });
      expect(Buffer.from(exact!.data, "base64").toString("utf8")).toContain(
        "ZX-4401",
      );
    } finally {
      await runtime.close();
    }
  });

  it("keeps parallel active tools when another tool finishes", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Parallel Tool Projection",
    });
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        const meta = { sessionId: session.id, turnId: "turn-tools" };
        options.events?.onToolUseStart?.({ id: "tool-a", name: "read" }, meta);
        options.events?.onToolUseStart?.({ id: "tool-b", name: "bash" }, meta);
        options.events?.onToolResult?.(
          { id: "tool-a", name: "read", content: "done" },
          meta,
        );
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );

    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "parallel tools",
    });
    const observation = await runtime.sessions.observe(
      session.id,
      () => undefined,
    );

    expect(observation.snapshot.live.activeTools).toEqual([
      expect.objectContaining({
        runId: run.runId,
        started: expect.objectContaining({
          tool: expect.objectContaining({ id: "tool-b" }),
        }),
      }),
    ]);
    observation.close();
    await runtime.close();
  });

  it("flushes coalesced streaming events before replay without dropping deltas", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Buffered Replay Test",
    });
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        queueMicrotask(() => {
          options.events?.onTextDelta?.("buffered delta", {
            sessionId: session.id,
            turnId: "turn-buffered",
          });
        });
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );

    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "stream",
    });
    await flushMicrotasks();
    const replay = await runtime.events.replay({
      runId: run.runId,
      type: "assistant.delta",
    });
    const eventLog = await fs.readFile(
      path.join(
        tempRoot,
        ".kodax",
        "runtime",
        "runs",
        encodeURIComponent(run.runId),
        "events.jsonl",
      ),
      "utf-8",
    );

    expect(replay).toEqual([
      expect.objectContaining({ type: "assistant.delta" }),
    ]);
    expect(eventLog).toContain("buffered delta");
    await runtime.runs.abort(run.runId);
    await runtime.close();
  });

  it("flushes pending deltas when a client subscription disconnects", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Subscription Disconnect Flush",
    });
    let activeEvents: KodaXOptions["events"];
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        activeEvents = options.events;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );
    const disconnectedEvents: RuntimeEvent[] = [];
    const remainingEvents: RuntimeEvent[] = [];
    const disconnected = runtime.events.subscribe(
      { sessionId: session.id },
      (event) => disconnectedEvents.push(event),
    );
    runtime.events.subscribe(
      { sessionId: session.id },
      (event) => remainingEvents.push(event),
    );
    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "disconnect while streaming",
    });
    disconnectedEvents.length = 0;
    remainingEvents.length = 0;

    activeEvents?.onTextDelta?.("flush on disconnect");
    disconnected.close();
    await flushMicrotasks();

    expect(
      disconnectedEvents.filter((event) => event.type === "assistant.delta"),
    ).toHaveLength(0);
    expect(
      remainingEvents.filter((event) => event.type === "assistant.delta")
        .map(runtimeTextPayload),
    ).toEqual(["flush on disconnect"]);
    expect(await fs.readFile(runtimeEventLogPath(tempRoot, run.runId), "utf-8"))
      .toContain("flush on disconnect");
    await runtime.runs.abort(run.runId);
    await runtime.close();
  });

  it("removes all synchronously closed subscribers before disconnect flush", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Shared Connection Disconnect Flush",
    });
    let activeEvents: KodaXOptions["events"];
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        activeEvents = options.events;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );
    const firstEvents: RuntimeEvent[] = [];
    const secondEvents: RuntimeEvent[] = [];
    const first = runtime.events.subscribe(
      { sessionId: session.id },
      (event) => firstEvents.push(event),
    );
    const second = runtime.events.subscribe(
      { sessionId: session.id },
      (event) => secondEvents.push(event),
    );
    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "disconnect a shared client",
    });
    firstEvents.length = 0;
    secondEvents.length = 0;

    activeEvents?.onTextDelta?.("persist without notifying dead connection");
    first.close();
    second.close();
    await flushMicrotasks();

    expect(firstEvents).toHaveLength(0);
    expect(secondEvents).toHaveLength(0);
    expect(await replayRuntimeText(runtime, run.runId)).toBe(
      "persist without notifying dead connection",
    );
    await runtime.runs.abort(run.runId);
    await runtime.close();
  });

  it("coalesces 25k thinking deltas and long text before sequence allocation and replay", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const sessionsDir = path.join(tempRoot, "sessions");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Streaming Delta Stress",
    });
    const thinkingChunk = "abcd";
    const textChunk = "xy";
    const thinkingCount = 25_000;
    const textCount = 10_000;
    const seen: RuntimeEvent[] = [];
    const appendFileSync = mutableNodeFs.appendFileSync;
    let eventAppendCount = 0;
    runtime.events.subscribe({ sessionId: session.id }, (event) => {
      seen.push(event);
    });
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        mutableNodeFs.appendFileSync = ((file, data, writeOptions) => {
          if (String(file).endsWith(`${path.sep}events.jsonl`)) {
            eventAppendCount += 1;
          }
          return appendFileSync(file, data, writeOptions);
        }) as typeof nodeFs.appendFileSync;
        syncBuiltinESMExports();
        queueMicrotask(() => {
          for (let index = 0; index < thinkingCount; index += 1) {
            options.events?.onThinkingDelta?.(thinkingChunk, {
              sessionId: session.id,
              turnId: "turn-stress",
              seq: index + 1,
            });
          }
          options.events?.onThinkingEnd?.(
            thinkingChunk.repeat(thinkingCount),
            { sessionId: session.id, turnId: "turn-stress" },
          );
          for (let index = 0; index < textCount; index += 1) {
            options.events?.onTextDelta?.(textChunk, {
              sessionId: session.id,
              turnId: "turn-stress",
              seq: thinkingCount + index + 1,
            });
          }
        });
        return fakeRunningSession(options, Promise.resolve({
          success: true,
          lastText: textChunk.repeat(textCount),
          messages: [],
          sessionId: session.id,
        }));
      },
    );

    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "stress streaming",
    });
    try {
      await run.result;
    } finally {
      mutableNodeFs.appendFileSync = appendFileSync;
      syncBuiltinESMExports();
    }
    const replay = await runtime.events.replay({ runId: run.runId });
    const thinking = replay.filter((event) => event.type === "thinking.delta");
    const text = replay.filter((event) => event.type === "assistant.delta");
    const logLines = (await fs.readFile(path.join(
      tempRoot,
      ".kodax",
      "runtime",
      "runs",
      encodeURIComponent(run.runId),
      "events.jsonl",
    ), "utf-8")).trim().split(/\r?\n/);

    expect(thinking).toHaveLength(13);
    expect(text).toHaveLength(3);
    expect(thinking.map(runtimeTextPayload).join("")).toBe(
      thinkingChunk.repeat(thinkingCount),
    );
    expect(text.map(runtimeTextPayload).join("")).toBe(
      textChunk.repeat(textCount),
    );
    expect(
      [...thinking, ...text].every(
        (event) => Buffer.byteLength(runtimeTextPayload(event), "utf8") <= 8 * 1024,
      ),
    ).toBe(true);
    expect(seen.filter((event) => event.type === "thinking.delta")).toHaveLength(
      thinking.length,
    );
    expect(eventAppendCount).toBeLessThan(100);
    expect(logLines).toHaveLength(replay.length);
    expect(replay.map((event) => event.seq)).toEqual(
      [...replay.map((event) => event.seq)].sort((left, right) => left - right),
    );

    await runtime.close();
    const recreated = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: "mock-provider",
    });
    const restored = await recreated.events.replay({ runId: run.runId });
    expect(
      restored.filter((event) => event.type === "thinking.delta")
        .map(runtimeTextPayload).join(""),
    ).toBe(thinkingChunk.repeat(thinkingCount));
    expect(
      restored.filter((event) => event.type === "assistant.delta")
        .map(runtimeTextPayload).join(""),
    ).toBe(textChunk.repeat(textCount));
    await recreated.close();
  });

  it("keeps legacy flat-message search revision and citations stable across Runtime restarts", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const sessionsDir = path.join(tempRoot, "legacy-search-sessions");
    const sessionId = "legacy-search";
    const legacyDir = path.join(sessionsDir, "_unknown");
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, `${sessionId}.jsonl`), [
      JSON.stringify({
        _type: "meta",
        id: sessionId,
        title: "Legacy searchable transcript",
        createdAt: "2025-01-02T03:04:05.000Z",
        scope: "user",
        lineageEntryCount: 0,
        activeMessageCount: 2,
      }),
      JSON.stringify({ role: "user", content: "Legacy needle ZX-9012." }),
      JSON.stringify({ role: "assistant", content: "The legacy needle is searchable." }),
    ].join("\n"), "utf8");
    const firstRuntime = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir });
    let firstResult: Awaited<ReturnType<typeof firstRuntime.sessions.transcriptSearch>>;
    try {
      firstResult = await firstRuntime.sessions.transcriptSearch({
        sessionId,
        query: "ZX-9012",
        scope: "all",
      });

      expect(firstResult?.hits).toHaveLength(1);
      expect(firstResult?.hits[0]).toMatchObject({
        active: true,
        entryIndex: 0,
        citation: expect.stringMatching(/^session-history:entry_/),
      });
      const entry = await firstRuntime.sessions.transcriptEntryChunk({
        sessionId,
        revision: firstResult!.revision,
        entryIndex: firstResult!.hits[0]!.entryIndex,
      });
      expect(Buffer.from(entry!.data, "base64").toString("utf8")).toContain(
        "ZX-9012",
      );
    } finally {
      await firstRuntime.close();
    }

    const secondRuntime = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir });
    try {
      const secondResult = await secondRuntime.sessions.transcriptSearch({
        sessionId,
        query: "ZX-9012",
        scope: "all",
      });
      expect(secondResult?.revision).toBe(firstResult!.revision);
      expect(secondResult?.hits[0]?.citation).toBe(firstResult!.hits[0]!.citation);
    } finally {
      await secondRuntime.close();
    }
  });

  it("retries transient data_changed captures and maps persistent churn to resync_required", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const sessionsDir = path.join(tempRoot, "capture-retry-sessions");
    const sessionId = "capture-retry";
    await new FileSessionStorage({ sessionsDir }).save(sessionId, {
      messages: [{ role: "user", content: "stable after retry" }],
      title: "Capture retry",
    });
    const runtime = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir });
    const original = FileSessionStorage.prototype.readFullSnapshot;
    let attempts = 0;
    const read = vi.spyOn(FileSessionStorage.prototype, "readFullSnapshot")
      .mockImplementation(async function (id, options) {
        if (id === sessionId && attempts < 2) {
          attempts += 1;
          throw new SessionReadError("data_changed", "writer changed the session");
        }
        if (id === sessionId) attempts += 1;
        return original.call(this, id, options);
      });
    try {
      await expect(runtime.sessions.conversation(sessionId)).resolves.toMatchObject({
        entries: [{ message: { content: "stable after retry" } }],
      });
      expect(attempts).toBe(3);

      attempts = 0;
      read.mockImplementation(async function (id, options) {
        if (id === sessionId) {
          attempts += 1;
          throw new SessionReadError("data_changed", "writer keeps changing the session");
        }
        return original.call(this, id, options);
      });
      await expect(runtime.sessions.transcript(sessionId)).rejects.toMatchObject({
        code: "resync_required",
      });
      expect(attempts).toBe(3);
    } finally {
      read.mockRestore();
      await runtime.close();
    }
  });

  it("flushes before two compatible fragments would exceed the 8 KiB merge limit", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Streaming Delta Size Limit",
    });
    const firstFragment = "a".repeat(7 * 1024);
    const secondFragment = "b".repeat(7 * 1024);
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        queueMicrotask(() => {
          options.events?.onTextDelta?.(firstFragment, {
            sessionId: session.id,
            turnId: "turn-size-limit",
          });
          options.events?.onTextDelta?.(secondFragment, {
            sessionId: session.id,
            turnId: "turn-size-limit",
          });
        });
        return fakeRunningSession(options, Promise.resolve({
          success: true,
          lastText: firstFragment + secondFragment,
          messages: [],
          sessionId: session.id,
        }));
      },
    );

    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "stream two large fragments",
    });
    await run.result;
    const replay = await runtime.events.replay({
      runId: run.runId,
      type: "assistant.delta",
    });

    expect(replay.map(runtimeTextPayload)).toEqual([
      firstFragment,
      secondFragment,
    ]);
    expect(
      replay.every(
        (event) => Buffer.byteLength(runtimeTextPayload(event)) <= 8 * 1024,
      ),
    ).toBe(true);
    expect(replay.map(runtimeTextPayload).join("")).toBe(
      firstFragment + secondFragment,
    );
    await runtime.close();
  });

  it("does not retain the fragment that crosses a failed coalescing boundary", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "coalescing-backpressure-sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Coalescing Backpressure",
    });
    let activeEvents: KodaXOptions["events"];
    codingMock.startKodaX.mockImplementation((options: KodaXOptions) => {
      activeEvents = options.events;
      return fakeRunningSession(
        options,
        new Promise<KodaXResult>(() => undefined),
      );
    });
    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "fail while crossing a coalescing boundary",
    });
    const firstFragment = "a".repeat(7 * 1024);
    const rejectedFragment = "b".repeat(7 * 1024);
    const eventFile = runtimeEventLogPath(tempRoot, run.runId);
    const appendFileSync = mutableNodeFs.appendFileSync;
    mutableNodeFs.appendFileSync = ((file, data, options) => {
      if (String(file) === eventFile) {
        throw new Error("coalescing boundary persistence failure");
      }
      return appendFileSync(file, data, options);
    }) as typeof nodeFs.appendFileSync;
    syncBuiltinESMExports();

    try {
      expect(() => activeEvents?.onTextDelta?.(firstFragment)).not.toThrow();
      expect(() => activeEvents?.onTextDelta?.(rejectedFragment))
        .toThrow("coalescing boundary persistence failure");
    } finally {
      mutableNodeFs.appendFileSync = appendFileSync;
      syncBuiltinESMExports();
    }

    expect(await replayRuntimeText(runtime, run.runId)).toBe(firstFragment);
    await runtime.runs.abort(run.runId);
    await runtime.close();
  });

  it("does not retain an oversized provider event when direct persistence fails", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "oversized-event-sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({ title: "Oversized Event" });
    let activeEvents: KodaXOptions["events"];
    codingMock.startKodaX.mockImplementation((options: KodaXOptions) => {
      activeEvents = options.events;
      return fakeRunningSession(
        options,
        new Promise<KodaXResult>(() => undefined),
      );
    });
    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "oversized provider fragment",
    });

    const eventFile = runtimeEventLogPath(tempRoot, run.runId);
    const appendFileSync = mutableNodeFs.appendFileSync;
    mutableNodeFs.appendFileSync = ((file, data, options) => {
      if (String(file) === eventFile) {
        throw new Error("oversized persistence failure");
      }
      return appendFileSync(file, data, options);
    }) as typeof nodeFs.appendFileSync;
    syncBuiltinESMExports();

    try {
      expect(() => activeEvents?.onTextDelta?.("x".repeat(1024 * 1024)))
        .toThrow("oversized persistence failure");
    } finally {
      mutableNodeFs.appendFileSync = appendFileSync;
      syncBuiltinESMExports();
    }

    expect(() => activeEvents?.onTextDelta?.("recovered")).not.toThrow();
    await expect(runtime.events.replay({
      runId: run.runId,
      type: "assistant.delta",
    })).resolves.toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ text: "recovered" }),
      }),
    ]);

    await runtime.runs.abort(run.runId);
    await runtime.close();
  });

  it("merges tool input only for one explicit toolId and keeps missing IDs separate", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Tool Input Delta Coalescing",
    });
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        queueMicrotask(() => {
          options.events?.onToolUseStart?.(
            { id: "tool-a", name: "edit" },
            { sessionId: session.id, turnId: "turn-tools", toolId: "tool-a" },
          );
          for (const fragment of ['{"path":', '"a.ts"', ',"text":"x"}']) {
            options.events?.onToolInputDelta?.("edit", fragment, {
              sessionId: session.id,
              turnId: "turn-tools",
              toolId: "tool-a",
            });
          }
          options.events?.onToolUseStart?.(
            { id: "tool-b", name: "write" },
            { sessionId: session.id, turnId: "turn-tools", toolId: "tool-b" },
          );
          for (const fragment of ['{"path":"b.ts",', '"text":"y"}']) {
            options.events?.onToolInputDelta?.("write", fragment, {
              sessionId: session.id,
              turnId: "turn-tools",
              toolId: "tool-b",
            });
          }
          options.events?.onToolResult?.(
            { id: "tool-b", name: "write", content: "ok" },
            { sessionId: session.id, turnId: "turn-tools", toolId: "tool-b" },
          );
          options.events?.onToolInputDelta?.("unknown", "first");
          options.events?.onToolInputDelta?.("unknown", "second");
        });
        return fakeRunningSession(options, Promise.resolve({
          success: true,
          lastText: "done",
          messages: [],
          sessionId: session.id,
        }));
      },
    );

    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "stream tool arguments",
    });
    await run.result;
    const toolInputs = (await runtime.events.replay({
      runId: run.runId,
      type: "tool.progress",
    })).filter(isRuntimeToolInputEvent);

    expect(toolInputs.map((event) => ({
      toolId: runtimeToolInputId(event),
      json: runtimeToolInputJson(event),
    }))).toEqual([
      { toolId: "tool-a", json: '{"path":"a.ts","text":"x"}' },
      { toolId: "tool-b", json: '{"path":"b.ts","text":"y"}' },
      { toolId: undefined, json: "first" },
      { toolId: undefined, json: "second" },
    ]);
    await runtime.close();
  });

  it("keeps the first and latest consecutive tool progress snapshots", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Latest Tool Progress",
    });
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        queueMicrotask(() => {
          options.events?.onToolUseStart?.(
            { id: "tool-progress", name: "bash" },
            { sessionId: session.id, toolId: "tool-progress" },
          );
          for (let index = 0; index < 1_000; index += 1) {
            options.events?.onToolProgress?.(
              { id: "tool-progress", message: `step ${index}` },
              { sessionId: session.id, toolId: "tool-progress" },
            );
          }
          options.events?.onToolResult?.(
            { id: "tool-progress", name: "bash", content: "done" },
            { sessionId: session.id, toolId: "tool-progress" },
          );
        });
        return fakeRunningSession(options, Promise.resolve({
          success: true,
          lastText: "done",
          messages: [],
          sessionId: session.id,
        }));
      },
    );

    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "report progress",
    });
    await run.result;
    const progress = (await runtime.events.replay({
      runId: run.runId,
      type: "tool.progress",
    })).filter(isRuntimeToolProgressEvent);

    expect(progress.map(runtimeToolProgressMessage)).toEqual([
      "step 0",
      "step 999",
    ]);
    await runtime.close();
  });

  it("snapshots caller-owned progress before deferred persistence", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "payload-snapshot-sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({ title: "Payload Snapshot" });
    let activeEvents: KodaXOptions["events"];
    codingMock.startKodaX.mockImplementation((options: KodaXOptions) => {
      activeEvents = options.events;
      return fakeRunningSession(
        options,
        new Promise<KodaXResult>(() => undefined),
      );
    });
    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "snapshot mutable provider payloads",
    });
    activeEvents?.onToolProgress?.({
      id: "mutable-progress",
      message: "first",
    });
    const mutableUpdate = {
      id: "mutable-progress",
      message: "second-before-mutation",
    };
    activeEvents?.onToolProgress?.(mutableUpdate);
    mutableUpdate.message = "x".repeat(2 * 1024 * 1024);

    const progress = (await runtime.events.replay({
      runId: run.runId,
      type: "tool.progress",
    })).filter(isRuntimeToolProgressEvent);
    expect(progress.map(runtimeToolProgressMessage)).toEqual([
      "first",
      "second-before-mutation",
    ]);
    await runtime.runs.abort(run.runId);
    await runtime.close();
  });

  it("preserves leading progress then publishes sustained updates at 20Hz", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Progress Frequency Limit",
    });
    let activeEvents: KodaXOptions["events"];
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        activeEvents = options.events;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );
    const seen: RuntimeEvent[] = [];
    runtime.events.subscribe({
      sessionId: session.id,
      type: "tool.progress",
    }, (event) => {
      seen.push(event);
    });
    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "sustained progress",
    });

    vi.useFakeTimers();
    try {
      for (let index = 0; index < 100; index += 1) {
        activeEvents?.onToolProgress?.({
          id: "rate-limited-tool",
          message: `window one ${index}`,
        });
      }
      await vi.advanceTimersByTimeAsync(49);
      expect(seen).toHaveLength(1);
      expect(runtimeToolProgressMessage(
        seen.filter(isRuntimeToolProgressEvent)[0]!,
      )).toBe("window one 0");
      await vi.advanceTimersByTimeAsync(1);
      expect(seen).toHaveLength(2);
      expect(runtimeToolProgressMessage(
        seen.filter(isRuntimeToolProgressEvent)[1]!,
      )).toBe("window one 99");

      for (let index = 0; index < 100; index += 1) {
        activeEvents?.onToolProgress?.({
          id: "rate-limited-tool",
          message: `window two ${index}`,
        });
      }
      await vi.advanceTimersByTimeAsync(50);
      expect(seen).toHaveLength(3);
      expect(runtimeToolProgressMessage(
        seen.filter(isRuntimeToolProgressEvent)[2]!,
      )).toBe("window two 99");
    } finally {
      vi.useRealTimers();
    }

    await runtime.runs.abort(run.runId);
    await runtime.close();
  });

  it("keeps one latest progress event per identity when progress streams interleave", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Interleaved Progress Frequency Limit",
    });
    let activeEvents: KodaXOptions["events"];
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        activeEvents = options.events;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );
    const seen: RuntimeEvent[] = [];
    runtime.events.subscribe({ sessionId: session.id }, (event) => {
      seen.push(event);
    });
    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "interleaved progress",
    });

    vi.useFakeTimers();
    try {
      for (let index = 0; index < 100; index += 1) {
        activeEvents?.onToolProgress?.({
          id: "progress-a",
          message: `a ${index}`,
        });
        activeEvents?.onTextDelta?.(".", {
          sessionId: session.id,
          turnId: "turn-interleaved-progress",
        });
        activeEvents?.onToolProgress?.({
          id: "progress-b",
          message: `b ${index}`,
        });
      }
      await vi.advanceTimersByTimeAsync(50);
    } finally {
      vi.useRealTimers();
    }

    const progress = seen.filter(isRuntimeToolProgressEvent);
    expect(progress.map(runtimeToolProgressMessage)).toEqual([
      "a 0",
      "b 0",
      "a 99",
      "b 99",
    ]);
    await runtime.runs.abort(run.runId);
    await runtime.close();
  });

  it("keeps latest workflow progress separate for each workflow process", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Parallel Workflow Progress",
    });
    let activeEvents: KodaXOptions["events"];
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        activeEvents = options.events;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );
    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "parallel workflow progress",
    });

    activeEvents?.onWorkflowProcessEvent?.(
      workflowProgressUpdate("workflow-a", "a 1"),
    );
    activeEvents?.onWorkflowProcessEvent?.(
      workflowProgressUpdate("workflow-b", "b 1"),
    );
    activeEvents?.onWorkflowProcessEvent?.(
      workflowProgressUpdate("workflow-a", "a 2"),
    );
    const replay = await runtime.events.replay({
      runId: run.runId,
      type: "workflow.updated",
    });

    expect(replay.map(runtimeWorkflowProgress)).toEqual([
      { runId: "workflow-b", message: "b 1" },
      { runId: "workflow-a", message: "a 2" },
    ]);
    await runtime.runs.abort(run.runId);
    await runtime.close();
  });

  it("retries a failed run batch without losing or duplicating another run", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const sessionsDir = path.join(tempRoot, "sessions");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: "mock-provider",
    });
    const firstSession = await runtime.sessions.create({
      title: "Persistence Retry A",
    });
    const secondSession = await runtime.sessions.create({
      title: "Persistence Retry B",
    });
    let firstEvents: KodaXOptions["events"];
    let secondEvents: KodaXOptions["events"];
    codingMock.startKodaX
      .mockImplementationOnce((options: KodaXOptions): RunningSession => {
        firstEvents = options.events;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      })
      .mockImplementationOnce((options: KodaXOptions): RunningSession => {
        secondEvents = options.events;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      });
    const firstRun = await runtime.runs.start({
      sessionId: firstSession.id,
      prompt: "first run",
    });
    const secondRun = await runtime.runs.start({
      sessionId: secondSession.id,
      prompt: "second run",
    });
    const secondEventFile = runtimeEventLogPath(tempRoot, secondRun.runId);
    const appendFileSync = mutableNodeFs.appendFileSync;
    let failed = false;
    mutableNodeFs.appendFileSync = ((file, data, options) => {
      if (!failed && String(file) === secondEventFile) {
        failed = true;
        throw new Error("transient event append failure");
      }
      return appendFileSync(file, data, options);
    }) as typeof nodeFs.appendFileSync;
    syncBuiltinESMExports();

    try {
      firstEvents?.onTextDelta?.("first durable delta");
      secondEvents?.onTextDelta?.("second durable delta");
      firstEvents?.onToolUseStart?.({ id: "first-boundary", name: "read" });
      expect(() => secondEvents?.onToolUseStart?.({
        id: "second-boundary",
        name: "read",
      })).toThrow("transient event append failure");
      await runtime.events.replay({ runId: secondRun.runId });
    } finally {
      mutableNodeFs.appendFileSync = appendFileSync;
      syncBuiltinESMExports();
    }
    expect(failed).toBe(true);
    await runtime.runs.abort(firstRun.runId);
    await runtime.runs.abort(secondRun.runId);
    await runtime.close();

    const recreated = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: "mock-provider",
    });
    expect(await replayRuntimeText(recreated, firstRun.runId)).toBe(
      "first durable delta",
    );
    expect(await replayRuntimeText(recreated, secondRun.runId)).toBe(
      "second durable delta",
    );
    await recreated.close();
  });

  it("reallocates a failed batch above another Runtime's committed watermark", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const sessionsDir = path.join(tempRoot, "sessions");
    const firstRuntime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: "mock-provider",
    });
    const secondRuntime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: "mock-provider",
    });
    const firstSession = await firstRuntime.sessions.create({
      title: "Shared Sequence Retry A",
    });
    const secondSession = await secondRuntime.sessions.create({
      title: "Shared Sequence Retry B",
    });
    let firstEvents: KodaXOptions["events"];
    let secondEvents: KodaXOptions["events"];
    codingMock.startKodaX
      .mockImplementationOnce((options: KodaXOptions): RunningSession => {
        firstEvents = options.events;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      })
      .mockImplementationOnce((options: KodaXOptions): RunningSession => {
        secondEvents = options.events;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      });
    const firstRun = await firstRuntime.runs.start({
      sessionId: firstSession.id,
      prompt: "first shared Runtime",
    });
    const secondRun = await secondRuntime.runs.start({
      sessionId: secondSession.id,
      prompt: "second shared Runtime",
    });
    const firstEventFile = runtimeEventLogPath(tempRoot, firstRun.runId);
    const appendFileSync = mutableNodeFs.appendFileSync;
    let failed = false;
    mutableNodeFs.appendFileSync = ((file, data, options) => {
      if (!failed && String(file) === firstEventFile) {
        failed = true;
        throw new Error("first Runtime append failure");
      }
      return appendFileSync(file, data, options);
    }) as typeof nodeFs.appendFileSync;
    syncBuiltinESMExports();

    let secondWatermark = 0;
    try {
      firstEvents?.onTextDelta?.("retry above watermark");
      firstEvents?.onToolUseStart?.({ id: "first-shared-boundary", name: "read" });
      secondEvents?.onTextDelta?.("committed between attempts");
      secondEvents?.onToolUseStart?.({
        id: "second-shared-boundary",
        name: "read",
      });
      const secondReplay = await secondRuntime.events.replay({
        runId: secondRun.runId,
      });
      secondWatermark = Math.max(...secondReplay.map((event) => event.seq));
      await firstRuntime.events.replay({ runId: firstRun.runId });
    } finally {
      mutableNodeFs.appendFileSync = appendFileSync;
      syncBuiltinESMExports();
    }

    expect(failed).toBe(true);
    const retried = await secondRuntime.events.replay({
      sinceSeq: secondWatermark,
    });
    expect(
      retried.filter((event) => event.runId === firstRun.runId)
        .map((event) => event.seq),
    ).toEqual(expect.arrayContaining([
      expect.any(Number),
    ]));
    expect(
      retried.filter((event) => event.runId === firstRun.runId)
        .every((event) => event.seq > secondWatermark),
    ).toBe(true);

    await firstRuntime.runs.abort(firstRun.runId);
    await secondRuntime.runs.abort(secondRun.runId);
    await firstRuntime.close();
    await secondRuntime.close();
  });

  it("rolls back a partially appended batch before retrying it", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Partial Event Batch Rollback",
    });
    let activeEvents: KodaXOptions["events"];
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        activeEvents = options.events;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );
    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "partial append",
    });
    const eventFile = runtimeEventLogPath(tempRoot, run.runId);
    const appendFileSync = mutableNodeFs.appendFileSync;
    let failed = false;
    mutableNodeFs.appendFileSync = ((file, data, options) => {
      if (!failed && String(file) === eventFile) {
        failed = true;
        const content = String(data);
        appendFileSync(
          file,
          content.slice(0, Math.max(1, Math.floor(content.length / 2))),
          options,
        );
        throw new Error("partial event batch append failure");
      }
      return appendFileSync(file, data, options);
    }) as typeof nodeFs.appendFileSync;
    syncBuiltinESMExports();

    try {
      activeEvents?.onTextDelta?.("exactly once after partial append");
      activeEvents?.onToolUseStart?.({
        id: "partial-append-boundary",
        name: "read",
      });
      await runtime.events.replay({ runId: run.runId });
    } finally {
      mutableNodeFs.appendFileSync = appendFileSync;
      syncBuiltinESMExports();
    }

    expect(failed).toBe(true);
    expect(await replayRuntimeText(runtime, run.runId)).toBe(
      "exactly once after partial append",
    );
    const records = (await fs.readFile(eventFile, "utf-8"))
      .trim()
      .split(/\r?\n/);
    expect(() => records.map((record) => JSON.parse(record))).not.toThrow();
    await fs.appendFile(eventFile, '{"id":"crash-interrupted-tail"');
    activeEvents?.onTextDelta?.(" and after reconnect repair");
    activeEvents?.onToolUseStart?.({
      id: "reconnect-repair-boundary",
      name: "read",
    });
    expect(await replayRuntimeText(runtime, run.runId)).toBe(
      "exactly once after partial append and after reconnect repair",
    );
    expect(() => (nodeFs.readFileSync(eventFile, "utf-8"))
      .trim()
      .split(/\r?\n/)
      .map((record) => JSON.parse(record))).not.toThrow();
    await runtime.runs.abort(run.runId);
    await runtime.close();

    const recreated = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    expect(await replayRuntimeText(recreated, run.runId)).toBe(
      "exactly once after partial append and after reconnect repair",
    );
    await recreated.close();
  });

  it.each(["event", "sequence"] as const)(
    "fails closed when partial append, rollback, and %s lock cleanup all fail",
    async (cleanupTarget) => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Indeterminate Event Batch Commit",
    });
    let activeEvents: KodaXOptions["events"];
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        activeEvents = options.events;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );
    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "append and rollback both fail",
    });
    const eventFile = runtimeEventLogPath(tempRoot, run.runId);
    const cleanupLockFile = cleanupTarget === "event"
      ? `${eventFile}.lock`
      : path.join(
          tempRoot,
          ".kodax",
          "runtime",
          "event-sequence.lock",
        );
    const appendFileSync = mutableNodeFs.appendFileSync;
    const rmSync = mutableNodeFs.rmSync;
    const truncateSync = mutableNodeFs.truncateSync;
    let appendFailed = false;
    let cleanupFailed = false;
    mutableNodeFs.appendFileSync = ((file, data, options) => {
      if (!appendFailed && String(file) === eventFile) {
        appendFailed = true;
        const content = String(data);
        appendFileSync(file, content.slice(0, content.length / 2), options);
        throw new Error("synthetic append failure after partial write");
      }
      return appendFileSync(file, data, options);
    }) as typeof nodeFs.appendFileSync;
    mutableNodeFs.truncateSync = ((file, length) => {
      if (String(file) === eventFile) {
        throw new Error("synthetic rollback failure");
      }
      return truncateSync(file, length);
    }) as typeof nodeFs.truncateSync;
    mutableNodeFs.rmSync = ((file, options) => {
      if (!cleanupFailed && String(file) === cleanupLockFile) {
        cleanupFailed = true;
        throw new Error("synthetic lock cleanup failure");
      }
      return rmSync(file, options);
    }) as typeof nodeFs.rmSync;
    syncBuiltinESMExports();

    try {
      activeEvents?.onTextDelta?.("must not be retried");
      activeEvents?.onToolUseStart?.({
        id: "indeterminate-commit-boundary",
        name: "read",
      });
    } finally {
      mutableNodeFs.appendFileSync = appendFileSync;
      mutableNodeFs.rmSync = rmSync;
      mutableNodeFs.truncateSync = truncateSync;
      syncBuiltinESMExports();
    }

    expect(appendFailed).toBe(true);
    expect(cleanupFailed).toBe(true);
    const partialContent = await fs.readFile(eventFile, "utf-8");
    await expect(runtime.events.replay({ runId: run.runId })).rejects.toThrow(
      "indeterminate",
    );
    expect(() => activeEvents?.onTextDelta?.("must be rejected after poison"))
      .toThrow("indeterminate");
    expect(await fs.readFile(eventFile, "utf-8")).toBe(partialContent);
    await expect(runtime.close()).rejects.toThrow("indeterminate");
    await expect(runtime.close()).rejects.toThrow("indeterminate");
    },
  );

  it.each(["event", "sequence"] as const)(
    "does not retry a committed batch when %s lock cleanup fails",
    async (cleanupTarget) => {
      const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
      const runtime = await createKodaXRuntime({
        homeDir: tempRoot,
        sessionsDir: path.join(tempRoot, "sessions"),
        defaultProvider: "mock-provider",
      });
      const session = await runtime.sessions.create({
        title: "Committed Event Lock Cleanup Failure",
      });
      let activeEvents: KodaXOptions["events"];
      codingMock.startKodaX.mockImplementation(
        (options: KodaXOptions): RunningSession => {
          activeEvents = options.events;
          return fakeRunningSession(
            options,
            new Promise<KodaXResult>(() => undefined),
          );
        },
      );
      const run = await runtime.runs.start({
        sessionId: session.id,
        prompt: "commit before lock cleanup failure",
      });
      const eventFile = runtimeEventLogPath(tempRoot, run.runId);
      const cleanupLockFile = cleanupTarget === "event"
        ? `${eventFile}.lock`
        : path.join(
            tempRoot,
            ".kodax",
            "runtime",
            "event-sequence.lock",
          );
      const appendFileSync = mutableNodeFs.appendFileSync;
      const rmSync = mutableNodeFs.rmSync;
      let eventAppendCalls = 0;
      let cleanupFailed = false;
      mutableNodeFs.appendFileSync = ((file, data, options) => {
        if (String(file) === eventFile) eventAppendCalls += 1;
        return appendFileSync(file, data, options);
      }) as typeof nodeFs.appendFileSync;
      mutableNodeFs.rmSync = ((file, options) => {
        if (!cleanupFailed && String(file) === cleanupLockFile) {
          cleanupFailed = true;
          throw new Error("synthetic committed lock cleanup failure");
        }
        return rmSync(file, options);
      }) as typeof nodeFs.rmSync;
      syncBuiltinESMExports();

      try {
        activeEvents?.onTextDelta?.("persisted once after cleanup failure");
        activeEvents?.onToolUseStart?.({
          id: "committed-cleanup-boundary",
          name: "read",
        });
      } finally {
        mutableNodeFs.appendFileSync = appendFileSync;
        mutableNodeFs.rmSync = rmSync;
        syncBuiltinESMExports();
      }

      expect(cleanupFailed).toBe(true);
      expect(eventAppendCalls).toBe(1);
      const replay = await runtime.events.replay({
        runId: run.runId,
        type: "assistant.delta",
      });
      expect(replay.map(runtimeTextPayload)).toEqual([
        "persisted once after cleanup failure",
      ]);
      await runtime.runs.abort(run.runId);
      await runtime.close();
    },
  );

  it("does not publish or advance a snapshot cursor before a failed batch is durable", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Persistence Watermark Fence",
    });
    let activeEvents: KodaXOptions["events"];
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        activeEvents = options.events;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );
    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "persistence watermark",
    });
    const seen: RuntimeEvent[] = [];
    runtime.events.subscribe({ sessionId: session.id }, (event) => {
      seen.push(event);
    });
    seen.length = 0;
    const eventFile = runtimeEventLogPath(tempRoot, run.runId);
    const appendFileSync = mutableNodeFs.appendFileSync;
    let appendAttempts = 0;
    mutableNodeFs.appendFileSync = ((file, data, options) => {
      if (String(file) === eventFile) {
        appendAttempts += 1;
        throw new Error("persistent event append failure");
      }
      return appendFileSync(file, data, options);
    }) as typeof nodeFs.appendFileSync;
    syncBuiltinESMExports();

    try {
      activeEvents?.onTextDelta?.("durable before visible");
      activeEvents?.onToolUseStart?.({ id: "watermark-boundary", name: "read" });
      expect(seen).toHaveLength(0);
      await expect(runtime.events.replay({ runId: run.runId })).rejects.toThrow(
        "persistent event append failure",
      );
      const attemptsAfterExplicitFlush = appendAttempts;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(appendAttempts).toBe(attemptsAfterExplicitFlush);
      expect(() => activeEvents?.onTextDelta?.("must not enter the failed queue"))
        .toThrow("persistent event append failure");
      expect(appendAttempts).toBe(attemptsAfterExplicitFlush);
    } finally {
      mutableNodeFs.appendFileSync = appendFileSync;
      syncBuiltinESMExports();
    }

    const replay = await runtime.events.replay({ runId: run.runId });
    expect(replay.filter((event) => event.type === "assistant.delta")
      .map(runtimeTextPayload)).toEqual(["durable before visible"]);
    expect(seen.map((event) => event.type)).toEqual([
      "assistant.delta",
      "tool.started",
    ]);
    const observation = await runtime.sessions.observe(
      session.id,
      () => undefined,
    );
    expect(observation.snapshot.live.assistantTextByRun[run.runId]).toBe(
      "durable before visible",
    );
    expect(observation.snapshot.cursor).toBeGreaterThanOrEqual(replay.at(-1)!.seq);
    observation.close();
    await runtime.runs.abort(run.runId);
    await runtime.close();
  });

  it("does not retry an appended batch when only event-log trimming fails", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const sessionsDir = path.join(tempRoot, "sessions");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Trim Failure Is Not Append Failure",
    });
    let activeEvents: KodaXOptions["events"];
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        activeEvents = options.events;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );
    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "trim failure",
    });
    const eventFile = runtimeEventLogPath(tempRoot, run.runId);
    const readFileSync = mutableNodeFs.readFileSync;
    const statSync = mutableNodeFs.statSync;
    mutableNodeFs.statSync = ((file) => {
      const value = statSync(file);
      return String(file) === eventFile
        ? { ...value, size: 17 * 1024 * 1024 }
        : value;
    }) as typeof nodeFs.statSync;
    let trimFailed = false;
    mutableNodeFs.readFileSync = ((file, options) => {
      if (!trimFailed && String(file) === eventFile) {
        trimFailed = true;
        throw new Error("synthetic trim failure");
      }
      return readFileSync(file, options);
    }) as typeof nodeFs.readFileSync;
    syncBuiltinESMExports();

    try {
      activeEvents?.onTextDelta?.("persisted once");
      activeEvents?.onToolUseStart?.({ id: "trim-boundary", name: "read" });
    } finally {
      mutableNodeFs.readFileSync = readFileSync;
      mutableNodeFs.statSync = statSync;
      syncBuiltinESMExports();
    }
    expect(trimFailed).toBe(true);
    await runtime.events.replay({ runId: run.runId });
    const persistedEvents = (await fs.readFile(eventFile, "utf-8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as RuntimeEvent);
    expect(
      persistedEvents.filter((event) => event.type === "assistant.delta"),
    ).toHaveLength(1);
    await runtime.runs.abort(run.runId);
    await runtime.close();

    const recreated = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: "mock-provider",
    });
    const replay = await recreated.events.replay({
      runId: run.runId,
      type: "assistant.delta",
    });
    expect(replay.map(runtimeTextPayload)).toEqual(["persisted once"]);
    await recreated.close();
  });

  it("does not retry a committed batch when trim-warning persistence also fails", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Post-Commit Warning Failure",
    });
    let activeEvents: KodaXOptions["events"];
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        activeEvents = options.events;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );
    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "warning failure after commit",
    });
    const eventFile = runtimeEventLogPath(tempRoot, run.runId);
    const linkSync = mutableNodeFs.linkSync;
    const readFileSync = mutableNodeFs.readFileSync;
    const statSync = mutableNodeFs.statSync;
    let sequenceLockCount = 0;
    mutableNodeFs.statSync = ((file) => {
      const value = statSync(file);
      return String(file) === eventFile
        ? { ...value, size: 17 * 1024 * 1024 }
        : value;
    }) as typeof nodeFs.statSync;
    mutableNodeFs.readFileSync = ((file, options) => {
      if (String(file) === eventFile) {
        throw new Error("synthetic trim failure before warning failure");
      }
      return readFileSync(file, options);
    }) as typeof nodeFs.readFileSync;
    mutableNodeFs.linkSync = ((existingPath, newPath) => {
      if (String(newPath).endsWith("event-sequence.lock")) {
        sequenceLockCount += 1;
        if (sequenceLockCount === 2) {
          throw new Error("synthetic trim-warning sequence failure");
        }
      }
      return linkSync(existingPath, newPath);
    }) as typeof nodeFs.linkSync;
    syncBuiltinESMExports();

    try {
      activeEvents?.onTextDelta?.("committed exactly once");
      activeEvents?.onToolUseStart?.({
        id: "post-commit-warning-boundary",
        name: "read",
      });
    } finally {
      mutableNodeFs.linkSync = linkSync;
      mutableNodeFs.readFileSync = readFileSync;
      mutableNodeFs.statSync = statSync;
      syncBuiltinESMExports();
    }

    expect(sequenceLockCount).toBe(2);
    const replay = await runtime.events.replay({ runId: run.runId });
    expect(
      replay.filter((event) => event.type === "assistant.delta")
        .map(runtimeTextPayload),
    ).toEqual(["committed exactly once"]);
    await runtime.runs.abort(run.runId);
    await runtime.close();
  });

  it("flushes pending deltas before error and cancellation boundaries", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const errorSession = await runtime.sessions.create({
      title: "Error Boundary Flush",
    });
    let errorEvents: KodaXOptions["events"];
    codingMock.startKodaX.mockImplementationOnce(
      (options: KodaXOptions): RunningSession => {
        errorEvents = options.events;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );
    const failed = await runtime.runs.start({
      sessionId: errorSession.id,
      prompt: "fail after deltas",
    });
    errorEvents?.onTextDelta?.("answer before failure");
    errorEvents?.onThinkingDelta?.("thinking before failure");
    errorEvents?.onToolProgress?.({
      id: "error-progress",
      message: "error progress first",
    });
    errorEvents?.onToolProgress?.({
      id: "error-progress",
      message: "error progress last",
    });
    errorEvents?.onError?.(new Error("stream failed"));
    await expectSettles(failed.result, "delta error boundary");
    const failedReplay = await runtime.events.replay({ runId: failed.runId });

    expect(runtimeEventIndex(failedReplay, "assistant.delta")).toBeLessThan(
      runtimeEventIndex(failedReplay, "runtime.warning"),
    );
    expect(runtimeEventIndex(failedReplay, "thinking.delta")).toBeLessThan(
      runtimeEventIndex(failedReplay, "run.failed"),
    );
    expect(
      failedReplay.filter(isRuntimeToolProgressEvent)
        .map(runtimeToolProgressMessage),
    ).toEqual(["error progress first", "error progress last"]);

    const cancelSession = await runtime.sessions.create({
      title: "Cancel Boundary Flush",
    });
    let cancelEvents: KodaXOptions["events"];
    codingMock.startKodaX.mockImplementationOnce(
      (options: KodaXOptions): RunningSession => {
        cancelEvents = options.events;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );
    const cancelled = await runtime.runs.start({
      sessionId: cancelSession.id,
      prompt: "cancel after delta",
    });
    cancelEvents?.onTextDelta?.("answer before cancel");
    cancelEvents?.onToolProgress?.({
      id: "cancel-progress",
      message: "cancel progress first",
    });
    cancelEvents?.onToolProgress?.({
      id: "cancel-progress",
      message: "cancel progress last",
    });
    await runtime.runs.abort(cancelled.runId);
    const cancelledReplay = await runtime.events.replay({
      runId: cancelled.runId,
    });
    expect(runtimeEventIndex(cancelledReplay, "assistant.delta")).toBeLessThan(
      runtimeEventIndex(cancelledReplay, "run.updated"),
    );
    expect(
      cancelledReplay.filter(isRuntimeToolProgressEvent)
        .map(runtimeToolProgressMessage),
    ).toEqual(["cancel progress first", "cancel progress last"]);
    await runtime.close();
  });

  it("hands off coalesced snapshot and incremental deltas without gaps or duplicates", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Coalesced Observation Handoff",
    });
    let activeEvents: KodaXOptions["events"];
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        activeEvents = options.events;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );
    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "observe streaming",
    });
    activeEvents?.onTextDelta?.("before ");
    activeEvents?.onTextDelta?.("snapshot");
    const delivered: RuntimeEvent[] = [];
    const observation = await runtime.sessions.observe(session.id, (event) => {
      delivered.push(event);
    });
    await flushMicrotasks();

    expect(observation.snapshot.live.assistantTextByRun[run.runId]).toBe(
      "before snapshot",
    );
    expect(await fs.readFile(path.join(
      tempRoot,
      ".kodax",
      "runtime",
      "runs",
      encodeURIComponent(run.runId),
      "events.jsonl",
    ), "utf-8")).toContain("before snapshot");
    activeEvents?.onTextDelta?.(" after");
    activeEvents?.onToolUseStart?.(
      { id: "handoff-boundary", name: "read" },
      { sessionId: session.id, toolId: "handoff-boundary" },
    );
    expect(
      delivered.filter((event) => event.type === "assistant.delta")
        .map(runtimeTextPayload).join(""),
    ).toBe(" after");
    expect(
      delivered.every((event) => event.seq > observation.snapshot.cursor),
    ).toBe(true);
    const replay = await runtime.events.replay({
      runId: run.runId,
      type: "assistant.delta",
    });
    expect(replay.map(runtimeTextPayload).join("")).toBe(
      "before snapshot after",
    );

    observation.close();
    await runtime.runs.abort(run.runId);
    await runtime.close();
  });

  it("forwards context diagnostics hooks into runtime event subscriptions", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Context Diagnostics Test",
    });
    const seen: string[] = [];
    const payloads: unknown[] = [];
    const callbackCacheDiagnostics: Array<{
      readonly requestId: string;
      readonly contextId?: string;
      readonly contextKind?: "root" | "child";
      readonly parentContextId?: string;
      readonly agentId?: string;
    }> = [];
    runtime.events.subscribe({ sessionId: session.id }, (event) => {
      const diagnosticPayload =
        event.payload !== null &&
        typeof event.payload === "object" &&
        !Array.isArray(event.payload)
          ? (event.payload as { readonly contextKind?: unknown })
          : undefined;
      if (diagnosticPayload?.contextKind === "child") return;
      if (
        event.type === "context.budget.snapshot" ||
        event.type === "provider.cache.diagnostics" ||
        event.type === "tool.exposure.planned" ||
        event.type === "context.compaction.skipped"
      ) {
        seen.push(event.type);
        payloads.push(event.payload);
      }
    });

    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        const sessionId = options.session?.id ?? "missing-session";
        const childSessionId = `${sessionId}-child-worker`;
        queueMicrotask(() => {
          options.events?.onContextBudgetSnapshot?.({
            sessionId,
            turnId: "turn-diagnostics",
            seq: 1,
            timestamp: "2026-07-08T00:00:00.000Z",
            profile: "report_only",
            contextWindow: 32_000,
            smallWindow: true,
            pressure: "low",
            tokenBreakdown: {
              systemPrompt: 1,
              toolSchemas: 2,
              skillCatalog: 0,
              mcpCatalog: 0,
              transcript: 3,
              pendingInput: 0,
              recentToolResults: 0,
              reservedResponse: 0,
              total: 6,
            },
            usedTokens: 6,
            availableTokens: 31_994,
            usedRatio: 0.0002,
            toolSchemaRatio: 0.0001,
            recommendations: [],
            createdAt: "2026-07-08T00:00:00.000Z",
          });
          options.events?.onPromptCacheDiagnostics?.({
            phase: "response",
            requestId: "cache-request-1",
            requestedAt: "2026-07-08T00:00:00.000Z",
            completedAt: "2026-07-08T00:00:00.001Z",
            provider: "mock-provider",
            model: "mock-model",
            endpoint: "https://example.test/v1",
            attempt: 1,
            systemPromptHash: "a".repeat(64),
            toolSchemaHash: "b".repeat(64),
            messagePrefixHash: "c".repeat(64),
            messagePrefixCount: 1,
            requestMessagesHash: "d".repeat(64),
            requestEnvelopeHash: "e".repeat(64),
            messageCount: 2,
            toolCount: 1,
            inputTokens: 100,
            outputTokens: 5,
            cachedReadTokens: 80,
          });
          options.events?.onToolExposurePlanned?.({
            sessionId,
            turnId: "turn-diagnostics",
            seq: 2,
            timestamp: "2026-07-08T00:00:00.001Z",
            profile: "report_only",
            reportOnly: true,
            pressure: "low",
            bridgeAvailable: false,
            nativeDeferredAvailable: true,
            decisions: [],
            modelVisibleToolNames: ["read", "tool_search"],
            estimatedToolSchemaTokensBefore: 10,
            estimatedToolSchemaTokensAfter: 8,
            estimatedToolSchemaTokensIfApplied: 8,
            estimatedTokensSaved: 2,
            estimatedTokensSavedIfApplied: 2,
            residentToolCount: 2,
            hintedToolCount: 0,
            bridgeToolCount: 0,
            nativeDeferredToolCount: 0,
            hiddenToolCount: 0,
          });
          options.events?.onContextCompactionSkipped?.({
            sessionId,
            turnId: "turn-diagnostics",
            seq: 3,
            timestamp: "2026-07-08T00:00:00.002Z",
            reason: "low_savings_cooldown",
            currentTokens: 18_000,
            contextWindow: 32_000,
            triggerPercent: 75,
            cooldownTurnsRemaining: 1,
            lowSavingsStreak: 0,
          });
          options.events?.onContextBudgetSnapshot?.({
            sessionId: childSessionId,
            turnId: "turn-child-diagnostics",
            contextKind: "child",
            agentId: "/root/reviewer",
            profile: "report_only",
            contextWindow: 32_000,
            smallWindow: true,
            pressure: "low",
            tokenBreakdown: {
              systemPrompt: 2,
              toolSchemas: 3,
              skillCatalog: 0,
              mcpCatalog: 0,
              transcript: 4,
              pendingInput: 0,
              recentToolResults: 0,
              reservedResponse: 0,
              total: 9,
            },
            usedTokens: 9,
            availableTokens: 31_991,
            usedRatio: 0.0003,
            toolSchemaRatio: 0.0001,
            recommendations: [],
            createdAt: "2026-07-08T00:00:00.003Z",
          });
          for (let index = 0; index < 101; index += 1) {
            const usedTokens = 10 + index;
            options.events?.onContextBudgetSnapshot?.({
              sessionId: childSessionId,
              turnId: `turn-child-diagnostics-${index}`,
              contextKind: "child",
              agentId: "/root/reviewer",
              profile: "report_only",
              contextWindow: 32_000,
              smallWindow: true,
              pressure: "low",
              tokenBreakdown: {
                systemPrompt: 2,
                toolSchemas: 3,
                skillCatalog: 0,
                mcpCatalog: 0,
                transcript: usedTokens - 5,
                pendingInput: 0,
                recentToolResults: 0,
                reservedResponse: 0,
                total: usedTokens,
              },
              usedTokens,
              availableTokens: 32_000 - usedTokens,
              usedRatio: usedTokens / 32_000,
              toolSchemaRatio: 0.0001,
              recommendations: [],
              createdAt: "2026-07-08T00:00:00.003Z",
            });
          }
          options.events?.onToolExposurePlanned?.({
            sessionId: childSessionId,
            contextKind: "child",
            agentId: "/root/reviewer",
            profile: "report_only",
            reportOnly: true,
            pressure: "low",
            bridgeAvailable: false,
            nativeDeferredAvailable: true,
            decisions: [],
            modelVisibleToolNames: ["read"],
            estimatedToolSchemaTokensBefore: 5,
            estimatedToolSchemaTokensAfter: 5,
            estimatedToolSchemaTokensIfApplied: 5,
            estimatedTokensSaved: 0,
            estimatedTokensSavedIfApplied: 0,
            residentToolCount: 1,
            hintedToolCount: 0,
            bridgeToolCount: 0,
            nativeDeferredToolCount: 0,
            hiddenToolCount: 0,
          });
          options.events?.onPromptCacheDiagnostics?.({
            phase: "response",
            transport: "stream",
            requestId: "cache-request-child",
            requestedAt: "2026-07-08T00:00:00.004Z",
            completedAt: "2026-07-08T00:00:00.005Z",
            provider: "mock-provider",
            contextKind: "child",
            agentId: "/root/reviewer",
            model: "mock-model",
            attempt: 1,
            systemPromptHash: "f".repeat(64),
            toolSchemaHash: "g".repeat(64),
            messagePrefixHash: "h".repeat(64),
            messagePrefixCount: 2,
            requestMessagesHash: "i".repeat(64),
            requestEnvelopeHash: "j".repeat(64),
            messageCount: 3,
            toolCount: 1,
            inputTokens: 120,
            outputTokens: 8,
            cachedReadTokens: 96,
          });
        });
        return fakeRunningSession(
          options,
          Promise.resolve({
            success: true,
            lastText: "diagnostics forwarded",
            messages: [],
            sessionId,
          }),
        );
      },
    );

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "diagnostics",
      options: {
        context: { contextDiagnostics: true },
        events: {
          onPromptCacheDiagnostics: (event) => {
            callbackCacheDiagnostics.push(event);
          },
        },
      },
    });
    await handle.result;
    await flushMicrotasks();
    const replay = await runtime.events.replay({ runId: handle.runId });
    const latestBudget = await runtime.diagnostics.latestContextBudget({
      runId: handle.runId,
    });
    const latestExposure = await runtime.diagnostics.latestToolExposure({
      runId: handle.runId,
    });
    const latestCache = await runtime.diagnostics.latestProviderCacheDiagnostic(
      {
        runId: handle.runId,
      },
    );
    const latestChildBudget = await runtime.diagnostics.latestContextBudget({
      runId: handle.runId,
      contextKind: "child",
      agentId: "/root/reviewer",
    });
    const latestChildExposure = await runtime.diagnostics.latestToolExposure({
      runId: handle.runId,
      contextKind: "child",
      agentId: "/root/reviewer",
    });
    const latestChildBudgetByRootSession =
      await runtime.diagnostics.latestContextBudget({
        sessionId: session.id,
        contextKind: "child",
        agentId: "/root/reviewer",
      });
    const latestChildCacheByRootSession =
      await runtime.diagnostics.latestProviderCacheDiagnostic({
        sessionId: session.id,
        contextKind: "child",
        agentId: "/root/reviewer",
      });
    const unrelatedRootChildBudget =
      await runtime.diagnostics.latestContextBudget({
        sessionId: "unrelated-root-session",
        contextKind: "child",
        agentId: "/root/reviewer",
      });
    const unrelatedRootChildCache =
      await runtime.diagnostics.latestProviderCacheDiagnostic({
        sessionId: "unrelated-root-session",
        contextKind: "child",
        agentId: "/root/reviewer",
      });

    expect(seen).toEqual([
      "context.budget.snapshot",
      "provider.cache.diagnostics",
      "tool.exposure.planned",
      "context.compaction.skipped",
    ]);
    expect(payloads[0]).toMatchObject({ pressure: "low", usedTokens: 6 });
    expect(payloads[1]).toMatchObject({
      phase: "response",
      cachedReadTokens: 80,
    });
    expect(payloads[2]).toMatchObject({
      reportOnly: true,
      modelVisibleToolNames: ["read", "tool_search"],
    });
    expect(payloads[3]).toMatchObject({
      reason: "low_savings_cooldown",
      cooldownTurnsRemaining: 1,
    });
    expect(replay.map((event) => event.type)).toContain(
      "context.budget.snapshot",
    );
    expect(replay.map((event) => event.type)).toContain(
      "provider.cache.diagnostics",
    );
    expect(replay.map((event) => event.type)).toContain(
      "tool.exposure.planned",
    );
    expect(replay.map((event) => event.type)).toContain(
      "context.compaction.skipped",
    );
    expect(latestBudget).toMatchObject({ pressure: "low", usedTokens: 6 });
    expect(latestExposure).toMatchObject({
      reportOnly: true,
      modelVisibleToolNames: ["read", "tool_search"],
    });
    expect(latestCache).toMatchObject({
      contextId: session.id,
      contextKind: "root",
      requestId: "cache-request-1",
      phase: "response",
      cachedReadTokens: 80,
    });
    expect(latestChildBudget).toMatchObject({
      contextKind: "child",
      agentId: "/root/reviewer",
      usedTokens: 110,
    });
    expect(latestChildExposure).toMatchObject({
      contextKind: "child",
      agentId: "/root/reviewer",
      modelVisibleToolNames: ["read"],
    });
    expect(latestChildBudgetByRootSession).toMatchObject({
      sessionId: `${session.id}-child-worker`,
      contextId: `${session.id}/agent/${encodeURIComponent("/root/reviewer")}`,
      contextKind: "child",
      agentId: "/root/reviewer",
      usedTokens: 110,
    });
    expect(latestChildCacheByRootSession).toMatchObject({
      contextId: `${session.id}/agent/${encodeURIComponent("/root/reviewer")}`,
      parentContextId: session.id,
      contextKind: "child",
      agentId: "/root/reviewer",
      requestId: "cache-request-child",
      cachedReadTokens: 96,
    });
    expect(unrelatedRootChildBudget).toBeNull();
    expect(unrelatedRootChildCache).toBeNull();
    expect(
      callbackCacheDiagnostics.find(
        (event) => event.requestId === "cache-request-child",
      ),
    ).toMatchObject({
      contextId: `${session.id}/agent/${encodeURIComponent("/root/reviewer")}`,
      parentContextId: session.id,
      contextKind: "child",
      agentId: "/root/reviewer",
    });

    await runtime.close();
  });

  it("serializes runs within one session while allowing queued status to be observed", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({ title: "Queue Test" });
    const starts: string[] = [];
    const queuedEvents: string[] = [];
    const persistedAtPublication: Array<{
      readonly event: string;
      readonly phase: string;
    }> = [];
    let finishFirst: ((value: KodaXResult) => void) | undefined;
    let finishSecond: ((value: KodaXResult) => void) | undefined;

    runtime.events.subscribe({ type: "run.queued" }, (event) =>
      queuedEvents.push(event.runId),
    );
    runtime.events.subscribe(
      {
        type: ["run.started", "run.queued", "run.completed"],
      },
      (event) => {
        const persisted: { readonly phase: string } = JSON.parse(
          readFileSync(
            path.join(
              tempRoot,
              ".kodax",
              "runtime",
              "runs",
              encodeURIComponent(event.runId),
              "status.json",
            ),
            "utf-8",
          ),
        ) as { readonly phase: string };
        persistedAtPublication.push({
          event: event.type,
          phase: persisted.phase,
        });
      },
    );
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions, prompt: string): RunningSession => {
        const sessionId = options.session?.id ?? session.id;
        starts.push(prompt);
        if (prompt === "first") {
          return fakeRunningSession(
            options,
            new Promise<KodaXResult>((resolve) => {
              finishFirst = resolve;
            }),
          );
        }
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>((resolve) => {
            finishSecond = resolve;
          }),
        );
      },
    );

    const first = await runtime.runs.start({
      sessionId: session.id,
      prompt: "first",
    });
    const second = await runtime.runs.start({
      sessionId: session.id,
      prompt: "second",
    });

    expect(starts).toEqual(["first"]);
    expect((await runtime.runs.get(first.runId)).phase).toBe("running");
    expect((await runtime.runs.get(second.runId)).phase).toBe("queued");
    expect(queuedEvents).toEqual([second.runId]);

    finishFirst?.({
      success: true,
      lastText: "first done",
      messages: [],
      sessionId: session.id,
    });
    await first.result;
    await flushMicrotasks();

    expect(starts).toEqual(["first", "second"]);
    expect((await runtime.runs.get(second.runId)).phase).toBe("running");

    finishSecond?.({
      success: true,
      lastText: "second done",
      messages: [],
      sessionId: session.id,
    });
    await expect(second.result).resolves.toMatchObject({ phase: "completed" });
    expect(persistedAtPublication).toEqual([
      { event: "run.started", phase: "running" },
      { event: "run.queued", phase: "queued" },
      { event: "run.completed", phase: "completed" },
      { event: "run.started", phase: "running" },
      { event: "run.completed", phase: "completed" },
    ]);

    await runtime.close();
  });

  it("preserves same-session start arrival order when session loading completes out of order", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Concurrent Queue Test",
    });
    let releaseFirstLoad: (() => void) | undefined;
    const firstLoadBlocked = new Promise<void>((resolve) => {
      releaseFirstLoad = resolve;
    });
    replMock.beforeLoadSession = async (call) => {
      if (call === 1) await firstLoadBlocked;
    };
    codingMock.startKodaX.mockImplementation((options: KodaXOptions) =>
      fakeRunningSession(options, new Promise<KodaXResult>(() => undefined)),
    );

    const firstStart = runtime.runs.start({
      sessionId: session.id,
      prompt: "first",
    });
    const secondStart = runtime.runs.start({
      sessionId: session.id,
      prompt: "second",
    });
    await vi.waitFor(() => expect(replMock.loadSessionCalls).toBe(1));
    releaseFirstLoad?.();
    const [first, second] = await Promise.all([firstStart, secondStart]);

    await expect(runtime.runs.get(first.runId)).resolves.toMatchObject({
      phase: "running",
      sessionOrder: 1,
    });
    await expect(runtime.runs.get(second.runId)).resolves.toMatchObject({
      phase: "queued",
      sessionOrder: 2,
    });
    await runtime.close();
  });

  it("creates ordered after-turn continuation runs and rejects stale delivery", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Continuation Test",
    });
    const starts: string[] = [];
    const finishers: Array<(value: KodaXResult) => void> = [];
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions, prompt: string): RunningSession => {
        starts.push(prompt);
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>((resolve) => {
            finishers.push(resolve);
          }),
        );
      },
    );

    const first = await runtime.runs.start({
      sessionId: session.id,
      prompt: "first",
    });
    const continuation = await runtime.runs.submitInput({
      sessionId: session.id,
      afterRunId: first.runId,
      delivery: "after_turn",
      input: { type: "text", text: "second" },
    });
    expect(continuation).toMatchObject({
      accepted: true,
      delivery: "after_turn",
      afterRunId: first.runId,
      sessionOrder: 2,
    });
    expect(starts).toEqual(["first"]);
    if (!continuation.accepted || continuation.delivery !== "after_turn") {
      throw new Error("Expected accepted continuation");
    }
    await expect(runtime.runs.get(continuation.runId)).resolves.toMatchObject({
      phase: "queued",
      continuation: {
        inputId: continuation.runId,
        afterRunId: first.runId,
        delivery: "after_turn",
        state: "queued",
        contentPreview: "second",
      },
    });
    const observation = await runtime.sessions.observe(
      session.id,
      () => undefined,
    );
    expect(observation.snapshot.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: continuation.runId,
          continuation: expect.objectContaining({
            inputId: continuation.runId,
          }),
        }),
      ]),
    );
    observation.close();

    finishers[0]?.({
      success: true,
      lastText: "done",
      messages: [],
      sessionId: session.id,
    });
    await first.result;
    await flushMicrotasks();
    expect(starts).toEqual(["first", "second"]);
    finishers[1]?.({
      success: true,
      lastText: "continued",
      messages: [],
      sessionId: session.id,
    });
    await runtime.runs.await(continuation.runId);

    await expect(
      runtime.runs.submitInput({
        sessionId: session.id,
        afterRunId: first.runId,
        delivery: "after_turn",
        input: { type: "text", text: "too late" },
      }),
    ).resolves.toMatchObject({ accepted: false, reason: "stale_run" });
    await runtime.close();
  });

  it("admits active-run input from cached Run identity without reading canonical Session", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "cached-run-admission-sessions"),
      defaultProvider: "mock-provider",
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({
      title: "Cached Run Admission",
      surface: "sdk",
    });
    const starts: string[] = [];
    const finishers: Array<(value: KodaXResult) => void> = [];
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions, prompt: string): RunningSession => {
        starts.push(prompt);
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>((resolve) => finishers.push(resolve)),
        );
      },
    );

    const first = await runtime.runs.start({
      sessionId: session.id,
      prompt: "first",
    });
    const loadSessionCalls = replMock.loadSessionCalls;
    replMock.beforeLoadSession = async (call) => {
      if (call > loadSessionCalls) {
        throw new SessionReadError(
          "data_changed",
          "active Run changed canonical Session data",
        );
      }
    };
    const canonicalRead = vi.spyOn(
      FileSessionStorage.prototype,
      "read",
    ).mockRejectedValue(new SessionReadError(
      "data_changed",
      "active Run changed canonical Session data",
    ));
    try {
      await expect(runtime.runs.submitInput({
        sessionId: "wrong-session",
        afterRunId: first.runId,
        delivery: "after_turn",
        input: { type: "text", text: "must not cross sessions" },
      })).rejects.toThrow(
        `Runtime continuation target ${first.runId} does not belong to session wrong-session`,
      );
      await expect(runtime.runs.get(first.runId)).resolves.toMatchObject({
        phase: "running",
      });
      await expect(runtime.runs.submitInput({
        sessionId: session.id,
        afterRunId: first.runId,
        delivery: "interrupt",
        input: { type: "text", text: "urgent" },
      })).resolves.toMatchObject({ accepted: true, delivery: "interrupt" });
      const continuation = await runtime.runs.submitInput({
        sessionId: session.id,
        afterRunId: first.runId,
        delivery: "after_turn",
        input: { type: "text", text: "second" },
      });
      if (!continuation.accepted || continuation.delivery !== "after_turn") {
        throw new Error("Expected accepted continuation");
      }
      const continuationResult = runtime.runs.await(continuation.runId);
      await flushMicrotasks();

      expect(canonicalRead).not.toHaveBeenCalled();
      expect(replMock.loadSessionCalls).toBe(loadSessionCalls);
      expect(starts).toEqual(["first"]);

      canonicalRead.mockRestore();
      replMock.beforeLoadSession = null;
      finishers[0]?.({
        success: true,
        lastText: "first done",
        messages: [],
        sessionId: session.id,
      });
      await first.result;
      await flushMicrotasks();
      expect(starts).toEqual(["first", "second"]);

      finishers[1]?.({
        success: true,
        lastText: "second done",
        messages: [],
        sessionId: session.id,
      });
      await expect(continuationResult).resolves.toMatchObject({
        phase: "completed",
      });
    } finally {
      canonicalRead.mockRestore();
      replMock.beforeLoadSession = null;
      await runtime.close();
    }
  });

  it.each([
    ["Partner", "partner-client"],
    ["unknown", "unrecognized-client"],
  ] as const)(
    "keeps %s Session surfaces outside shared Runtime Run admission",
    async (_label, surface) => {
      const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
      const sessionsDir = path.join(tempRoot, "surface-admission-sessions");
      const owner = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir });
      const session = await owner.sessions.create({
        title: "Non-daemon Session",
        surface,
      });
      await owner.close();

      const shared = await createKodaXRuntime({
        homeDir: tempRoot,
        sessionsDir,
        defaultProvider: "mock-provider",
        sharedDaemonHost: true,
      });
      try {
        await expect(shared.runs.start({
          sessionId: session.id,
          prompt: "must remain outside shared admission",
        })).rejects.toMatchObject({ code: "session_not_admitted" });
        expect(codingMock.startKodaX).not.toHaveBeenCalled();
      } finally {
        await shared.close();
      }
    },
  );

  it("rejects interrupt input after a managed task closes its final safe-boundary window", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Managed Interrupt Window Test",
    });
    let activeEvents: KodaXOptions["events"];
    let finishManaged: ((value: KodaXResult) => void) | undefined;
    codingMock.runManagedTask.mockImplementation((options: KodaXOptions) => {
      activeEvents = options.events;
      return new Promise<KodaXResult>((resolve) => {
        finishManaged = resolve;
      });
    });

    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "managed",
      mode: "managed_task",
    });
    activeEvents?.onManagedTaskStatus?.({
      agentMode: "ama",
      harnessProfile: "H0_DIRECT",
      currentRound: 1,
      maxRounds: 1,
      upgradeCeiling: "H0_DIRECT",
      phase: "completed",
      note: "Task completed",
      persistToHistory: true,
    });
    await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({
      phase: "running",
      stage: "finalizing",
      activeSubtaskCount: 0,
    });
    const queued = await runtime.runs.start({
      sessionId: session.id,
      prompt: "must wait for the executor result",
      mode: "managed_task",
    });
    await expect(runtime.runs.get(queued.runId)).resolves.toMatchObject({
      phase: "queued",
      stage: "queued",
    });

    await expect(
      runtime.runs.submitInput({
        sessionId: session.id,
        afterRunId: run.runId,
        delivery: "interrupt",
        input: { type: "text", text: "arrived during finalization" },
      }),
    ).resolves.toEqual({
      accepted: false,
      delivery: "interrupt",
      sessionId: session.id,
      afterRunId: run.runId,
      reason: "interrupt_window_closed",
    });
    expect(getMessageQueue().size()).toBe(0);
    await expect(
      runtime.events.replay({
        runId: run.runId,
        type: "run.input.queued",
      }),
    ).resolves.toEqual([]);

    finishManaged?.({
      success: true,
      lastText: "done",
      messages: [],
      sessionId: session.id,
    });
    await expect(run.result).resolves.toMatchObject({ phase: "completed" });
    await runtime.close();
    await expect(queued.result).resolves.toMatchObject({ phase: "unknown" });
  });

  it("reports waiting-agent and recovery phases through Run and Session status", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Authoritative lifecycle phases",
    });
    let activeEvents: KodaXOptions["events"];
    codingMock.runManagedTask.mockImplementation((options: KodaXOptions) => {
      activeEvents = options.events;
      return new Promise<KodaXResult>(() => undefined);
    });
    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "wait for children",
      mode: "managed_task",
    });

    activeEvents?.onManagedTaskStatus?.({
      agentMode: "ama",
      harnessProfile: "H0_DIRECT",
      phase: "worker",
      idleWaiting: true,
      idleWaitingPendingCount: 2,
    });
    await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({
      phase: "waiting_agent",
      stage: "worker",
      activeSubtaskCount: 2,
    });
    await expect(runtime.sessions.status(session.id)).resolves.toMatchObject({
      sessionId: session.id,
      runId: run.runId,
      phase: "waiting_agent",
    });
    await expect(runtime.status.snapshot()).resolves.toMatchObject({
      runs: [expect.objectContaining({
        runId: run.runId,
        phase: "waiting_agent",
      })],
    });
    await expect(runtime.status.preflight()).resolves.toMatchObject({
      canStop: false,
      blockers: expect.arrayContaining(["active_runs"]),
      activeRuns: [expect.objectContaining({
        runId: run.runId,
        phase: "waiting_agent",
      })],
    });

    activeEvents?.onProviderRecovery?.({
      stage: "streaming" as never,
      errorClass: "transient" as never,
      attempt: 1,
      maxAttempts: 3,
      delayMs: 10,
      recoveryAction: "retry" as never,
      ladderStep: 1,
      fallbackUsed: false,
    });
    await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({
      phase: "recovering",
      stage: "recovering",
    });
    await expect(runtime.status.preflight()).resolves.toMatchObject({
      canStop: false,
      activeRuns: [expect.objectContaining({
        runId: run.runId,
        phase: "recovering",
      })],
    });

    activeEvents?.onManagedTaskStatus?.({
      agentMode: "ama",
      harnessProfile: "H0_DIRECT",
      phase: "verifying",
      idleWaiting: false,
    });
    await expect(runtime.sessions.status(session.id)).resolves.toMatchObject({
      runId: run.runId,
      phase: "running",
    });
    await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({
      phase: "running",
      stage: "verifying",
      activeSubtaskCount: 0,
    });

    await runtime.runs.abort(run.runId);
    await runtime.close();
  });

  it("restores the latest executor phase after Actor settlement persistence recovers", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const originalSave = FileSessionStorage.prototype.saveActorSnapshot;
    let releaseSettlement: (() => void) | undefined;
    const settlementGate = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });
    let terminalAttempts = 0;
    const save = vi.spyOn(
      FileSessionStorage.prototype,
      "saveActorSnapshot",
    ).mockImplementation(async function (
      this: FileSessionStorage,
      id: string,
      snapshot: AgentActorSnapshot,
      expectedRevision: number,
    ) {
      const childTerminal = snapshot.turns.some(
        (turn) => turn.actorPath === "/root/worker" && turn.state === "failed",
      );
      if (childTerminal) {
        terminalAttempts += 1;
        if (terminalAttempts === 1) throw new Error("transient actor save");
        if (terminalAttempts === 2) await settlementGate;
      }
      await originalSave.call(this, id, snapshot, expectedRevision);
    });
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "actor-health-phase-sessions"),
      defaultProvider: "mock-provider",
    });
    try {
      const session = await runtime.sessions.create({
        title: "Actor health phase overlay",
      });
      let activeEvents: KodaXOptions["events"];
      codingMock.runManagedTask.mockImplementation((options: KodaXOptions) => {
        activeEvents = options.events;
        return new Promise<KodaXResult>(() => undefined);
      });
      const run = await runtime.runs.start({
        sessionId: session.id,
        prompt: "keep executing while child settlement retries",
        mode: "managed_task",
      });
      activeEvents?.onManagedTaskStatus?.({
        agentMode: "ama",
        harnessProfile: "H0_DIRECT",
        phase: "worker",
        idleWaiting: true,
        idleWaitingPendingCount: 1,
      });
      await runtime.agents.spawn(session.id, {
        taskName: "worker",
        objective: "Fail without an attached executor environment.",
      });
      await vi.waitFor(async () => {
        await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({
          phase: "recovering",
          lifecycleError: {
            code: "actor_settlement_retrying",
            retryable: true,
          },
        });
      });

      activeEvents?.onManagedTaskStatus?.({
        agentMode: "ama",
        harnessProfile: "H0_DIRECT",
        phase: "verifying",
        idleWaiting: false,
      });
      await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({
        phase: "recovering",
        stage: "recovering",
      });

      releaseSettlement?.();
      await vi.waitFor(async () => {
        const status = await runtime.runs.get(run.runId);
        expect(status).toMatchObject({
          phase: "running",
          stage: "verifying",
        });
        expect(status).not.toHaveProperty("lifecycleError");
      });
      await runtime.runs.abort(run.runId);
    } finally {
      releaseSettlement?.();
      save.mockRestore();
      await runtime.close();
    }
  });

  it("does not restore a stopped Run to active after Actor settlement recovers", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const originalSave = FileSessionStorage.prototype.saveActorSnapshot;
    let releaseSettlement: (() => void) | undefined;
    const settlementGate = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });
    let terminalAttempts = 0;
    const save = vi.spyOn(
      FileSessionStorage.prototype,
      "saveActorSnapshot",
    ).mockImplementation(async function (
      this: FileSessionStorage,
      id: string,
      snapshot: AgentActorSnapshot,
      expectedRevision: number,
    ) {
      const childTerminal = snapshot.turns.some(
        (turn) => turn.actorPath === "/root/worker" && turn.state === "failed",
      );
      if (childTerminal) {
        terminalAttempts += 1;
        if (terminalAttempts === 1) throw new Error("transient actor save");
        if (terminalAttempts === 2) await settlementGate;
      }
      await originalSave.call(this, id, snapshot, expectedRevision);
    });
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "actor-stop-recovery-sessions"),
      defaultProvider: "mock-provider",
    });
    try {
      const session = await runtime.sessions.create({
        title: "Stop during Actor settlement recovery",
      });
      codingMock.runManagedTask.mockImplementation(
        () => new Promise<KodaXResult>(() => undefined),
      );
      const run = await runtime.runs.start({
        sessionId: session.id,
        prompt: "remain stopped after Actor recovery",
        mode: "managed_task",
      });
      await runtime.agents.spawn(session.id, {
        taskName: "worker",
        objective: "Create a transient Actor settlement.",
      });
      await vi.waitFor(async () => {
        await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({
          phase: "recovering",
        });
      });

      await expect(runtime.runs.abort(run.runId)).resolves.toMatchObject({
        accepted: true,
        state: "unknown",
        outcome: "unknown",
        phase: "unknown",
      });
      releaseSettlement?.();
      await vi.waitFor(async () => {
        const status = await runtime.runs.get(run.runId);
        expect(status).toMatchObject({
          phase: "unknown",
          stage: "unknown",
          stop: {
            state: "unknown",
            outcome: "unknown",
          },
        });
        expect(status).not.toHaveProperty("lifecycleError");
      });
    } finally {
      releaseSettlement?.();
      save.mockRestore();
      await runtime.close();
    }
  });

  it("preserves Actor settlement unknown diagnostics when external Stop follows it", async () => {
    vi.useFakeTimers();
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const originalSave = FileSessionStorage.prototype.saveActorSnapshot;
    const save = vi.spyOn(
      FileSessionStorage.prototype,
      "saveActorSnapshot",
    ).mockImplementation(async function (
      this: FileSessionStorage,
      id: string,
      snapshot: AgentActorSnapshot,
      expectedRevision: number,
    ) {
      if (snapshot.turns.some(
        (turn) => turn.actorPath === "/root/worker" && turn.state === "failed",
      )) {
        throw new Error("actor storage remains unavailable");
      }
      await originalSave.call(this, id, snapshot, expectedRevision);
    });
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "actor-stop-unknown-sessions"),
      defaultProvider: "mock-provider",
    });
    try {
      const session = await runtime.sessions.create({
        title: "Stop plus Actor unknown diagnostics",
      });
      codingMock.runManagedTask.mockImplementation(
        () => new Promise<KodaXResult>(() => undefined),
      );
      const abortController = new AbortController();
      const run = await runtime.runs.start({
        sessionId: session.id,
        prompt: "retain both unknown facts",
        mode: "managed_task",
        options: { abortSignal: abortController.signal },
      });
      await runtime.agents.spawn(session.id, {
        taskName: "worker",
        objective: "Fail settlement permanently.",
      });
      await vi.advanceTimersByTimeAsync(6_000);
      await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({
        phase: "unknown",
        lifecycleError: {
          code: "actor_settlement_not_persisted",
          retryable: false,
        },
      });

      abortController.abort(new Error("host cancelled after Actor unknown"));

      await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({
        phase: "unknown",
        stop: {
          state: "unknown",
          outcome: "unknown",
          reason: "host cancelled after Actor unknown",
        },
        lifecycleError: {
          code: "actor_settlement_not_persisted",
          retryable: false,
        },
      });
    } finally {
      vi.useRealTimers();
      save.mockRestore();
      await expect(runtime.close()).rejects.toMatchObject({
        code: "actor_shutdown_not_persisted",
      });
    }
  });

  it("does not terminalize a Run before its Actor settlements are durable", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const originalSave = FileSessionStorage.prototype.saveActorSnapshot;
    let releaseSettlement: (() => void) | undefined;
    const settlementGate = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });
    const save = vi.spyOn(
      FileSessionStorage.prototype,
      "saveActorSnapshot",
    ).mockImplementation(async function (
      this: FileSessionStorage,
      id: string,
      snapshot: AgentActorSnapshot,
      expectedRevision: number,
    ) {
      if (snapshot.turns.some(
        (turn) => turn.actorPath === "/root/worker" && turn.state === "failed",
      )) {
        await settlementGate;
      }
      await originalSave.call(this, id, snapshot, expectedRevision);
    });
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "actor-terminal-gate-sessions"),
      defaultProvider: "mock-provider",
    });
    try {
      const session = await runtime.sessions.create({
        title: "Actor terminal gate",
      });
      let finishRoot: ((value: KodaXResult) => void) | undefined;
      codingMock.runManagedTask.mockImplementation(
        () => new Promise<KodaXResult>((resolve) => {
          finishRoot = resolve;
        }),
      );
      const run = await runtime.runs.start({
        sessionId: session.id,
        prompt: "finish only after child durability",
        mode: "managed_task",
      });
      await runtime.agents.spawn(session.id, {
        taskName: "worker",
        objective: "Create a pending settlement.",
      });
      await vi.waitFor(async () => {
        await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({
          phase: "recovering",
        });
      });
      finishRoot?.({
        success: true,
        lastText: "root reply is complete",
        messages: [],
        sessionId: session.id,
      });
      await flushMicrotasks();
      const pendingStatus = await runtime.runs.get(run.runId);
      expect(pendingStatus).toMatchObject({
        phase: "recovering",
      });
      expect(pendingStatus).not.toHaveProperty("terminal");

      releaseSettlement?.();
      await expect(run.result).resolves.toMatchObject({
        phase: "completed",
        result: expect.objectContaining({
          lastText: "root reply is complete",
        }),
      });
      await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({
        phase: "completed",
      });
      expect(await runtime.runs.get(run.runId)).not.toHaveProperty(
        "lifecycleError",
      );
    } finally {
      releaseSettlement?.();
      save.mockRestore();
      await runtime.close();
    }
  });

  it("rejects a later Run when Session Actor settlement state is unknown", async () => {
    vi.useFakeTimers();
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const originalSave = FileSessionStorage.prototype.saveActorSnapshot;
    const save = vi.spyOn(
      FileSessionStorage.prototype,
      "saveActorSnapshot",
    ).mockImplementation(async function (
      this: FileSessionStorage,
      id: string,
      snapshot: AgentActorSnapshot,
      expectedRevision: number,
    ) {
      if (snapshot.turns.some(
        (turn) => turn.actorPath === "/root/worker" && turn.state === "failed",
      )) {
        throw new Error("actor snapshot storage unavailable");
      }
      await originalSave.call(this, id, snapshot, expectedRevision);
    });
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "actor-unknown-sessions"),
      defaultProvider: "mock-provider",
    });
    try {
      const session = await runtime.sessions.create({
        title: "Latched Actor unknown health",
      });
      await runtime.agents.spawn(session.id, {
        taskName: "worker",
        objective: "Become durably uncertain.",
      });
      await vi.advanceTimersByTimeAsync(6_000);

      await expect(runtime.runs.start({
        sessionId: session.id,
        prompt: "must not execute against unknown Actor state",
        mode: "managed_task",
      })).rejects.toMatchObject({
        code: "actor_settlement_not_persisted",
        retryable: false,
      });
      expect(codingMock.runManagedTask).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      save.mockRestore();
      await expect(runtime.close()).rejects.toMatchObject({
        code: "actor_shutdown_not_persisted",
      });
    }
  });

  it("captures read-only Session diagnostics with explicit unknown and Stop outcomes", async () => {
    const {
      captureRuntimeSessionDiagnostics,
      createKodaXRuntime,
    } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const emptySession = await runtime.sessions.create({
      title: "No Run Control Record",
    });
    const noRun = await captureRuntimeSessionDiagnostics(runtime, {
      sessionId: emptySession.id,
      timeoutMs: 5_000,
    });
    expect(noRun).toMatchObject({
      schemaVersion: 1,
      runtimeId: runtime.identity.runtimeId,
      runtimeMode: "embedded",
      daemonVersion: null,
      sessionId: emptySession.id,
      observation: {
        cursor: expect.any(Number),
        transcriptRevision: expect.any(String),
      },
      run: {
        controlRecord: "unknown",
        state: "unknown",
        stage: "unknown",
        terminalTimeKnown: false,
        activeSubtaskCount: null,
        activeSubtaskCountSource: "unknown",
        errors: [expect.objectContaining({ code: "run_control_unknown" })],
      },
    });

    const activeSession = await runtime.sessions.create({
      title: "Diagnostic Stop Lifecycle",
    });
    let activeEvents: KodaXOptions["events"];
    let finishManaged: ((value: KodaXResult) => void) | undefined;
    codingMock.runManagedTask.mockImplementation((options: KodaXOptions) => {
      activeEvents = options.events;
      return new Promise<KodaXResult>((resolve) => {
        finishManaged = resolve;
      });
    });
    const run = await runtime.runs.start({
      sessionId: activeSession.id,
      prompt: "capture verifier and Stop state",
      mode: "managed_task",
    });
    activeEvents?.onManagedTaskStatus?.({
      agentMode: "ama",
      harnessProfile: "H0_DIRECT",
      phase: "verifying",
      idleWaiting: false,
    });
    const verifying = await captureRuntimeSessionDiagnostics(runtime, {
      sessionId: activeSession.id,
      runId: run.runId,
    });
    expect(verifying.run).toMatchObject({
      controlRecord: "present",
      runId: run.runId,
      state: "active",
      phase: "running",
      stage: "verifying",
      activeSubtaskCount: 0,
      activeSubtaskCountSource: "run_status",
      errors: [],
    });

    await runtime.runs.abort(run.runId);
    const stopping = await captureRuntimeSessionDiagnostics(runtime, {
      sessionId: activeSession.id,
      runId: run.runId,
    });
    expect(stopping.run).toMatchObject({
      state: "unknown",
      phase: "unknown",
      stage: "unknown",
      stop: {
        state: "unknown",
        outcome: "unknown",
        reason: "runtime run aborted",
      },
      errors: [expect.objectContaining({
        code: "stop_outcome_unconfirmed",
      })],
    });

    finishManaged?.({
      success: true,
      lastText: "executor ignored Stop and completed",
      messages: [],
      sessionId: activeSession.id,
    });
    await expect(run.result).resolves.toMatchObject({ phase: "completed" });
    const terminal = await captureRuntimeSessionDiagnostics(runtime, {
      sessionId: activeSession.id,
      runId: run.runId,
    });
    expect(terminal.run).toMatchObject({
      state: "terminal",
      phase: "completed",
      stage: "terminal",
      terminalAt: expect.any(String),
      terminalTimeKnown: true,
      stop: {
        state: "confirmed",
        outcome: "completed",
        resolvedAt: expect.any(String),
      },
      errors: [],
    });

    const failedSession = await runtime.sessions.create({
      title: "Diagnostic Failed Run",
    });
    codingMock.runManagedTask.mockRejectedValueOnce(
      new Error("finalizer verifier failed"),
    );
    const failedRun = await runtime.runs.start({
      sessionId: failedSession.id,
      prompt: "capture a structured failure",
      mode: "managed_task",
    });
    await expect(failedRun.result).resolves.toMatchObject({ phase: "failed" });
    const failed = await captureRuntimeSessionDiagnostics(runtime, {
      sessionId: failedSession.id,
      runId: failedRun.runId,
    });
    expect(failed.run).toMatchObject({
      state: "terminal",
      phase: "failed",
      errors: [{
        code: "run_failed",
        message: "finalizer verifier failed",
      }],
    });
    await runtime.close();
  });

  it("cancels a diagnostic capture through the read-only Session diagnostic path", async () => {
    const { captureRuntimeSessionDiagnostics } = await import(
      "@kodax-ai/kodax/runtime"
    );
    const abortController = new AbortController();
    const runtime = {
      identity: {
        runtimeId: "diagnostic-runtime",
        mode: "embedded",
        profile: "default",
        startedAt: "2026-07-30T00:00:00.000Z",
        version: "0.7.79",
      },
      sessions: {
        diagnostics: vi.fn(
          (input: { readonly signal?: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              input.signal?.addEventListener("abort", () => {
                reject(Object.assign(
                  new Error("Runtime history read cancelled"),
                  { code: "read_cancelled" as const },
                ));
              }, { once: true });
            }),
        ),
      },
    } as unknown as KodaXRuntime;

    const capture = captureRuntimeSessionDiagnostics(runtime, {
      sessionId: "session-cancel",
      signal: abortController.signal,
    });
    abortController.abort();

    await expect(capture).rejects.toMatchObject({ code: "read_cancelled" });
    expect(runtime.sessions.diagnostics).toHaveBeenCalledOnce();
  });

  it("reports owner and Stop diagnostic errors independently without recovery", async () => {
    const {
      captureRuntimeSessionDiagnostics,
      createKodaXRuntime,
    } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Owner And Stop Diagnostic Errors",
    });
    const runId = "run-diagnostic-owner-stop";
    const statusFile = path.join(
      tempRoot,
      ".kodax",
      "runtime",
      "runs",
      runId,
      "status.json",
    );
    const persisted = {
      runId,
      sessionId: session.id,
      phase: "running",
      stage: "executing",
      startedAt: "2026-07-30T00:00:00.000Z",
      provider: "mock-provider",
      stop: {
        requestedAt: "2026-07-30T00:01:00.000Z",
        state: "unknown",
        outcome: "unknown",
        reason: "runtime run aborted",
      },
      _runtime: {
        revision: 1,
        owner: {
          ownerId: "dead-diagnostic-owner",
          runtimeId: "dead-diagnostic-runtime",
          pid: 2_147_483_647,
          startedAt: "2026-07-30T00:00:00.000Z",
        },
      },
    };
    await fs.mkdir(path.dirname(statusFile), { recursive: true });
    await fs.writeFile(statusFile, JSON.stringify(persisted), "utf-8");
    const before = await fs.readFile(statusFile);

    const diagnostic = await captureRuntimeSessionDiagnostics(runtime, {
      sessionId: session.id,
      runId,
    });

    expect(diagnostic.run.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "owner_recovery_required" }),
      expect.objectContaining({ code: "stop_outcome_unconfirmed" }),
    ]));
    expect(await fs.readFile(statusFile)).toEqual(before);
    await runtime.close();
  });

  it("times out diagnostics while owner liveness remains unresponsive", async () => {
    const {
      captureRuntimeSessionDiagnostics,
      createKodaXRuntime,
    } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Diagnostic Liveness Timeout",
    });
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0 });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Diagnostic liveness test server did not bind");
    }
    const runId = "run-diagnostic-timeout";
    const statusFile = path.join(
      tempRoot,
      ".kodax",
      "runtime",
      "runs",
      runId,
      "status.json",
    );
    await fs.mkdir(path.dirname(statusFile), { recursive: true });
    await fs.writeFile(statusFile, JSON.stringify({
      runId,
      sessionId: session.id,
      phase: "running",
      stage: "executing",
      startedAt: "2026-07-30T00:00:00.000Z",
      provider: "mock-provider",
      _runtime: {
        revision: 1,
        owner: {
          ownerId: "unresponsive-diagnostic-owner",
          runtimeId: "unresponsive-diagnostic-runtime",
          pid: process.pid,
          startedAt: "2026-07-30T00:00:00.000Z",
          livenessId: "a".repeat(32),
          livenessPort: address.port,
        },
      },
    }), "utf-8");

    try {
      const startedAt = Date.now();
      await expect(captureRuntimeSessionDiagnostics(runtime, {
        sessionId: session.id,
        runId,
        timeoutMs: 25,
      })).rejects.toMatchObject({ code: "read_timeout" });
      expect(Date.now() - startedAt).toBeLessThan(300);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await runtime.close();
    }
  });

  it("does not evict an existing transcript page boundary while capturing diagnostics", async () => {
    const {
      captureRuntimeSessionDiagnostics,
      createKodaXRuntime,
    } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const source = await runtime.sessions.create({
      title: "Retained transcript boundary",
    });
    await runtime.sessions.appendNotice({
      sessionId: source.id,
      content: "first",
    });
    await runtime.sessions.appendNotice({
      sessionId: source.id,
      content: "second",
    });
    const firstPage = await runtime.sessions.transcriptPage({
      sessionId: source.id,
      limit: 1,
    });
    expect(firstPage?.nextCursor).toEqual(expect.any(String));

    for (let index = 0; index < 10; index += 1) {
      const session = await runtime.sessions.create({
        title: `Diagnostic boundary ${index}`,
      });
      await captureRuntimeSessionDiagnostics(runtime, {
        sessionId: session.id,
      });
    }

    await expect(runtime.sessions.transcriptPage({
      sessionId: source.id,
      cursor: firstPage!.nextCursor,
      limit: 1,
    })).resolves.toMatchObject({
      revision: firstPage?.revision,
      entries: [expect.objectContaining({
        entry: expect.objectContaining({
          message: expect.objectContaining({ content: "first" }),
        }),
      })],
    });
    await runtime.close();
  });

  it("rejects interrupt input after an ordinary coding run reports completion", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Coding Interrupt Window Test",
    });
    let activeEvents: KodaXOptions["events"];
    let finishCoding: ((value: KodaXResult) => void) | undefined;
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        activeEvents = options.events;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>((resolve) => {
            finishCoding = resolve;
          }),
        );
      },
    );

    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "coding",
    });
    activeEvents?.onComplete?.();
    finishCoding?.({
      success: true,
      lastText: "done",
      messages: [],
      sessionId: session.id,
    });

    await expect(
      runtime.runs.submitInput({
        sessionId: session.id,
        afterRunId: run.runId,
        delivery: "interrupt",
        input: { type: "text", text: "arrived after completion callback" },
      }),
    ).resolves.toMatchObject({
      accepted: false,
      reason: "interrupt_window_closed",
    });
    expect(getMessageQueue().size()).toBe(0);
    await expect(run.result).resolves.toMatchObject({
      phase: "completed",
      result: expect.objectContaining({
        success: true,
        lastText: "done",
      }),
    });
    await runtime.close();
  });

  it("settles a coding Run from the executor completion signal even if its result promise is lost", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Explicit Completion Boundary",
    });
    let activeEvents: KodaXOptions["events"];
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        activeEvents = options.events;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );

    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "finish through the explicit executor signal",
    });
    activeEvents?.onComplete?.();

    await expectSettles(run.result, "executor-completed Run").then((result) => {
      expect(result).toMatchObject({ phase: "completed" });
    });
    await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({
      phase: "completed",
      terminal: {
        kind: "completed",
        code: "completed",
        effectOutcome: "known",
      },
    });
    await runtime.close();
  });

  it("keeps a latched executor completion authoritative when Stop races before fallback settlement", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Completion Before Stop",
    });
    let activeEvents: KodaXOptions["events"];
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        activeEvents = options.events;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );

    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "complete before Stop",
    });
    activeEvents?.onComplete?.();
    await runtime.runs.abort(run.runId);

    await expectSettles(run.result, "completion before Stop").then((result) => {
      expect(result).toMatchObject({ phase: "completed" });
      expect(result.stop).toBeUndefined();
    });
    await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({
      phase: "completed",
      terminal: {
        kind: "completed",
        code: "completed",
      },
    });
    await runtime.close();
  });

  it("returns an unknown Stop receipt while a latched completion waits for an active child", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const external = deferredExternalAgentFixture("stop-latched-child");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "stop-latched-child-sessions"),
      defaultProvider: "mock-provider",
      externalAgents: {
        factories: [external.factory],
        policy: async () => ({ allowed: true }),
        defaultContext: { actorId: "stop-latched-child-host" },
      },
    });
    let activeEvents: KodaXOptions["events"];
    try {
      await runtime.admin.agentRegistrations.upsert(external.registration);
      const session = await runtime.sessions.create({
        sessionId: "stop-latched-child",
      });
      await runtime.agents.spawn(session.id, {
        taskName: "deferred",
        kind: "external",
        objective: "Remain active while the root executor completes.",
        metadata: { agentId: external.registration.agentId },
      });
      codingMock.startKodaX.mockImplementation(
        (options: KodaXOptions): RunningSession => {
          activeEvents = options.events;
          return fakeRunningSession(
            options,
            new Promise<KodaXResult>(() => undefined),
          );
        },
      );
      const handle = await runtime.runs.start({
        sessionId: session.id,
        prompt: "complete while a child is still active",
      });
      activeEvents?.onComplete?.();

      await expectSettles(
        runtime.runs.abort(handle.runId),
        "Stop over latched completion with active child",
      ).then((receipt) => {
        expect(receipt).toMatchObject({
          accepted: true,
          phase: "unknown",
          state: "unknown",
          outcome: "unknown",
          revision: expect.any(Number),
        });
      });
      await expect(runtime.runs.get(handle.runId)).resolves.toMatchObject({
        phase: "unknown",
        stop: {
          state: "unknown",
          outcome: "unknown",
        },
      });
    } finally {
      external.finish();
      await runtime.close();
    }
  });

  it.each([
    ["external AbortSignal", "abort"],
    ["Runtime close", "close"],
  ] as const)(
    "does not let %s bypass Actor finalization for a latched completion",
    async (_label, trigger) => {
      const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
      const key = `terminal-gate-${trigger}`;
      const external = deferredExternalAgentFixture(key);
      const runtime = await createKodaXRuntime({
        homeDir: tempRoot,
        sessionsDir: path.join(tempRoot, `${key}-sessions`),
        defaultProvider: "mock-provider",
        externalAgents: {
          factories: [external.factory],
          policy: async () => ({ allowed: true }),
          defaultContext: { actorId: `${key}-host` },
        },
      });
      const abortController = new AbortController();
      let activeEvents: KodaXOptions["events"];
      let closing: Promise<void> | undefined;
      try {
        await runtime.admin.agentRegistrations.upsert(external.registration);
        const session = await runtime.sessions.create({ sessionId: key });
        await runtime.agents.spawn(session.id, {
          taskName: "deferred",
          kind: "external",
          objective: "Keep Actor finalization pending.",
          metadata: { agentId: external.registration.agentId },
        });
        codingMock.startKodaX.mockImplementation(
          (options: KodaXOptions): RunningSession => {
            activeEvents = options.events;
            return fakeRunningSession(
              options,
              new Promise<KodaXResult>(() => undefined),
            );
          },
        );
        const handle = await runtime.runs.start({
          sessionId: session.id,
          prompt: "latch completion before cancellation",
          options: { abortSignal: abortController.signal },
        });
        activeEvents?.onComplete?.();

        if (trigger === "abort") {
          abortController.abort(new Error("host cancelled"));
          const status = await runtime.runs.get(handle.runId);
          expect(status).toMatchObject({
            phase: "unknown",
            stop: {
              state: "unknown",
              outcome: "unknown",
              reason: "host cancelled",
            },
          });
          expect(status).not.toHaveProperty("terminal");
        } else {
          closing = runtime.close();
          const persisted = JSON.parse(readFileSync(path.join(
            tempRoot,
            ".kodax",
            "runtime",
            "runs",
            handle.runId,
            "status.json",
          ), "utf8")) as Record<string, unknown>;
          expect(persisted).toMatchObject({
            phase: "unknown",
            stop: {
              state: "unknown",
              outcome: "unknown",
              reason: "runtime closed",
            },
          });
          expect(persisted).not.toHaveProperty("terminal");
        }
      } finally {
        external.finish();
        if (closing !== undefined) {
          await closing;
        } else {
          await runtime.close();
        }
      }
    },
  );

  it.each(["abort-signal", "runs.abort"] as const)(
    "preserves a pre-existing Actor when a completed managed Run is stopped via %s",
    async (cancelVia) => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const external = deferredExternalAgentFixture("bounded-cancel-finalization");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "bounded-cancel-finalization-sessions"),
      defaultProvider: "mock-provider",
      externalAgents: {
        factories: [external.factory],
        policy: async () => ({ allowed: true }),
        defaultContext: { actorId: "bounded-cancel-host" },
      },
    });
    const abortController = new AbortController();
    try {
      await runtime.admin.agentRegistrations.upsert(external.registration);
      const session = await runtime.sessions.create({
        sessionId: "bounded-cancel-finalization",
      });
      await runtime.agents.spawn(session.id, {
        taskName: "deferred",
        kind: "external",
        objective: "Remain active across root completion.",
        metadata: { agentId: external.registration.agentId },
      });
      codingMock.runManagedTask.mockResolvedValue({
        success: true,
        lastText: "root complete",
        messages: [],
        sessionId: session.id,
      });
      const handle = await runtime.runs.start({
        sessionId: session.id,
        prompt: "wait for a legitimate long-running child",
        mode: "managed_task",
        ...(cancelVia === "abort-signal"
          ? { options: { abortSignal: abortController.signal } }
          : {}),
      });
      let settled = false;
      void handle.result.then(() => {
        settled = true;
      });
      await flushMicrotasks();
      expect(settled).toBe(false);

      if (cancelVia === "abort-signal") {
        abortController.abort(new Error("host cancelled long-running child"));
      } else {
        await expect(runtime.runs.abort(handle.runId)).resolves.toMatchObject({
          accepted: true,
          phase: "unknown",
          state: "unknown",
          outcome: "unknown",
        });
      }
      await expect(handle.result).resolves.toMatchObject({
        phase: "completed",
        terminal: { kind: "completed", code: "completed" },
        stop: {
          state: "confirmed",
          outcome: "completed",
          reason: cancelVia === "abort-signal"
            ? "host cancelled long-running child"
            : "runtime run aborted",
        },
      });
      expect(settled).toBe(true);
      await expect(runtime.agents.tree(session.id)).resolves.toMatchObject({
        activeNonRootTurns: 1,
      });
    } finally {
      external.finish();
      await flushMicrotasks();
      await runtime.close();
    }
    },
  );

  it("cooperatively interrupts Actor descendants admitted by the managed Run", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const external = deferredExternalAgentFixture("managed-run-owned-abort");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "managed-run-owned-abort-sessions"),
      defaultProvider: "mock-provider",
      externalAgents: {
        factories: [external.factory],
        policy: async () => ({ allowed: true }),
        defaultContext: { actorId: "managed-run-owned-abort-host" },
      },
    });
    let spawnedTurn: { readonly actorPath: string; readonly turnId: string } | undefined;
    try {
      await runtime.admin.agentRegistrations.upsert(external.registration);
      const session = await runtime.sessions.create({
        sessionId: "managed-run-owned-abort",
      });
      codingMock.runManagedTask.mockImplementation(async (options: KodaXOptions) => {
        const actorSession = options.context?.actorSession;
        if (!actorSession) throw new Error("expected Runtime-owned Actor session");
        spawnedTurn = await actorSession.rootControl().spawn({
          taskName: "run-child",
          kind: "external",
          objective: "Remain active until the owning managed Run is stopped.",
          metadata: { agentId: external.registration.agentId },
        });
        return new Promise<KodaXResult>((_resolve, reject) => {
          const rejectFromAbort = (): void => {
            const error = new Error("Provider observed the managed Run abort");
            error.name = "AbortError";
            options.events?.onError?.(error);
            reject(error);
          };
          options.abortSignal?.addEventListener("abort", rejectFromAbort, {
            once: true,
          });
          if (options.abortSignal?.aborted) rejectFromAbort();
        });
      });

      const handle = await runtime.runs.start({
        sessionId: session.id,
        prompt: "start a cooperative child then stop",
        mode: "managed_task",
      });
      await vi.waitFor(() => expect(spawnedTurn).toBeDefined());
      if (!spawnedTurn) throw new Error("managed Run did not admit its child turn");

      const receipt = await runtime.runs.abort(handle.runId);
      expect(receipt).toMatchObject({
        accepted: true,
        phase: "unknown",
        state: "unknown",
        outcome: "unknown",
      });

      await expect(handle.result).resolves.toMatchObject({
        phase: "interrupted",
        terminal: { kind: "interrupted", code: "interrupted" },
        stop: { state: "confirmed", outcome: "interrupted" },
      });
      await expect(runtime.agents.output(
        session.id,
        spawnedTurn.actorPath,
        spawnedTurn.turnId,
      )).resolves.toMatchObject({ state: "interrupted" });
      await expect(runtime.agents.tree(session.id)).resolves.toMatchObject({
        activeNonRootTurns: 0,
      });
    } finally {
      vi.useRealTimers();
      external.finish();
      await flushMicrotasks();
      await runtime.close();
    }
  });

  it("bounds Actor finalization after normal root completion with a stuck child", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const external = deferredExternalAgentFixture("bounded-normal-finalization");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "bounded-normal-finalization-sessions"),
      defaultProvider: "mock-provider",
      externalAgents: {
        factories: [external.factory],
        policy: async () => ({ allowed: true }),
        defaultContext: { actorId: "bounded-normal-host" },
      },
    });
    try {
      await runtime.admin.agentRegistrations.upsert(external.registration);
      const session = await runtime.sessions.create({
        sessionId: "bounded-normal-finalization",
      });
      await runtime.agents.spawn(session.id, {
        taskName: "deferred",
        kind: "external",
        objective: "Remain active after normal root completion.",
        metadata: { agentId: external.registration.agentId },
      });
      codingMock.runManagedTask.mockResolvedValue({
        success: true,
        lastText: "root complete",
        messages: [],
        sessionId: session.id,
      });
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const handle = await runtime.runs.start({
        sessionId: session.id,
        prompt: "finish while child remains stuck",
        mode: "managed_task",
      });
      let settled = false;
      void handle.result.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(30_000);
      await expect(handle.result).resolves.toMatchObject({ phase: "unknown" });
      const persisted = await runtime.runs.get(handle.runId);
      expect(persisted).toMatchObject({ phase: "unknown" });
      expect(persisted).not.toHaveProperty("terminal");
    } finally {
      vi.useRealTimers();
      external.finish();
      await flushMicrotasks();
      await runtime.close();
    }
  });

  it("preserves executor payload and queue serialization when external abort races completion", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Completion Abort Queue Race",
    });
    const abortController = new AbortController();
    const starts: string[] = [];
    let firstEvents: KodaXOptions["events"];
    let finishFirst: ((value: KodaXResult) => void) | undefined;
    let finishSecond: ((value: KodaXResult) => void) | undefined;
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions, prompt: string): RunningSession => {
        starts.push(prompt);
        if (prompt === "first") {
          firstEvents = options.events;
          return fakeRunningSession(
            options,
            new Promise<KodaXResult>((resolve) => {
              finishFirst = resolve;
            }),
          );
        }
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>((resolve) => {
            finishSecond = resolve;
          }),
        );
      },
    );

    const first = await runtime.runs.start({
      sessionId: session.id,
      prompt: "first",
      options: { abortSignal: abortController.signal },
    });
    const second = await runtime.runs.start({
      sessionId: session.id,
      prompt: "second",
    });
    firstEvents?.onComplete?.();
    abortController.abort(new Error("abort after completion callback"));

    expect(starts).toEqual(["first"]);
    finishFirst?.({
      success: true,
      lastText: "payload retained",
      messages: [],
      sessionId: session.id,
    });
    await expect(first.result).resolves.toMatchObject({
      phase: "completed",
      result: {
        success: true,
        lastText: "payload retained",
      },
    });
    await flushMicrotasks();
    expect(starts).toEqual(["first", "second"]);

    finishSecond?.({
      success: true,
      lastText: "second completed",
      messages: [],
      sessionId: session.id,
    });
    await expect(second.result).resolves.toMatchObject({ phase: "completed" });
    await runtime.close();
  });

  it("keeps Session mutations fenced until a latched executor settlement finishes", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Terminal Settlement Mutation Fence",
    });
    const abortController = new AbortController();
    let activeEvents: KodaXOptions["events"];
    let finishExecutor: ((value: KodaXResult) => void) | undefined;
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        activeEvents = options.events;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>((resolve) => {
            finishExecutor = resolve;
          }),
        );
      },
    );
    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "settle before Session mutation",
      options: { abortSignal: abortController.signal },
    });

    vi.useFakeTimers({ toFake: ["setImmediate"] });
    try {
      activeEvents?.onComplete?.();
      abortController.abort(new Error("abort after completion callback"));
      await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({
        phase: "completed",
      });
      await expect(runtime.sessions.archive(session.id)).rejects.toMatchObject({
        code: "conflict",
      });
    } finally {
      finishExecutor?.({
        success: true,
        lastText: "executor cleanup finished",
        messages: [],
        sessionId: session.id,
      });
      await expect(run.result).resolves.toMatchObject({ phase: "completed" });
      await vi.runAllTimersAsync();
      vi.useRealTimers();
      await runtime.close();
    }
  });

  it("persists a latched completion before Runtime close releases owner liveness", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const options = {
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    };
    const firstRuntime = await createKodaXRuntime(options);
    const session = await firstRuntime.sessions.create({
      title: "Completion Before Runtime Close",
    });
    let activeEvents: KodaXOptions["events"];
    codingMock.startKodaX.mockImplementation(
      (runOptions: KodaXOptions): RunningSession => {
        activeEvents = runOptions.events;
        return fakeRunningSession(
          runOptions,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );

    const run = await firstRuntime.runs.start({
      sessionId: session.id,
      prompt: "persist completion before owner release",
    });
    activeEvents?.onComplete?.();
    const closeAttempt = firstRuntime.close();
    const persistedAtClose = JSON.parse(readFileSync(path.join(
      tempRoot,
      ".kodax",
      "runtime",
      "runs",
      run.runId,
      "status.json",
    ), "utf-8")) as { readonly phase?: string };
    expect(persistedAtClose.phase).toBe("completed");
    await closeAttempt;

    const secondRuntime = await createKodaXRuntime(options);
    await expect(secondRuntime.runs.get(run.runId)).resolves.toMatchObject({
      phase: "completed",
      terminal: {
        kind: "completed",
        code: "completed",
      },
    });
    await secondRuntime.close();
  });

  it("does not revive an unknown stopped Run from late progress callbacks", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Late Progress After Stop",
    });
    let activeEvents: KodaXOptions["events"];
    codingMock.runManagedTask.mockImplementation((options: KodaXOptions) => {
      activeEvents = options.events;
      return new Promise<KodaXResult>(() => undefined);
    });

    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "remain unknown after Stop",
      mode: "managed_task",
    });
    await runtime.runs.abort(run.runId);

    activeEvents?.onManagedTaskStatus?.({
      agentMode: "ama",
      harnessProfile: "H0_DIRECT",
      phase: "completed",
      persistToHistory: true,
    });
    activeEvents?.onProviderRecovery?.({
      stage: "streaming" as never,
      errorClass: "transient" as never,
      attempt: 1,
      maxAttempts: 3,
      delayMs: 10,
      recoveryAction: "retry" as never,
      ladderStep: 1,
      fallbackUsed: false,
    });

    await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({
      phase: "unknown",
      stage: "unknown",
      error: "stop_outcome_unconfirmed",
      stop: {
        state: "unknown",
        outcome: "unknown",
      },
    });
    await runtime.close();
    await expect(run.result).resolves.toMatchObject({ phase: "unknown" });
  });

  it("settles a coding Run from the executor error signal even if its result promise is lost", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Explicit Failure Boundary",
    });
    let activeEvents: KodaXOptions["events"];
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        activeEvents = options.events;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );

    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "fail through the explicit executor signal",
    });
    activeEvents?.onError?.(new Error("executor failed durably"));

    await expectSettles(run.result, "executor-failed Run").then((result) => {
      expect(result).toMatchObject({ phase: "failed" });
    });
    await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({
      phase: "failed",
      error: "executor failed durably",
      terminal: {
        kind: "failed",
        code: "run_failed",
        effectOutcome: "known",
      },
    });
    await runtime.close();
  });

  it("keeps the first executor terminal signal when callbacks race", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Terminal Callback Race",
    });
    let activeEvents: KodaXOptions["events"];
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        activeEvents = options.events;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );

    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "race terminal callbacks",
    });
    activeEvents?.onError?.(new Error("first terminal signal"));
    activeEvents?.onComplete?.();

    await expectSettles(run.result, "terminal callback race").then((result) => {
      expect(result).toMatchObject({ phase: "failed" });
    });
    const terminalEvents = await runtime.events.replay({
      runId: run.runId,
      type: ["run.failed", "run.completed"],
    });
    expect(terminalEvents.map((event) => event.type)).toEqual(["run.failed"]);
    await runtime.close();
  });

  it("rejects interrupt input after a coding run reports its terminal error", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Failed Interrupt Window Test",
    });
    let activeEvents: KodaXOptions["events"];
    let failCoding: ((error: Error) => void) | undefined;
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        activeEvents = options.events;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>((_resolve, reject) => {
            failCoding = reject;
          }),
        );
      },
    );

    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "coding",
    });
    activeEvents?.onError?.(new Error("provider failed"));

    await expect(
      runtime.runs.submitInput({
        sessionId: session.id,
        afterRunId: run.runId,
        delivery: "interrupt",
        input: { type: "text", text: "arrived after terminal error" },
      }),
    ).resolves.toMatchObject({
      accepted: false,
      reason: "interrupt_window_closed",
    });
    expect(getMessageQueue().size()).toBe(0);

    failCoding?.(new Error("provider failed"));
    await expect(run.result).resolves.toMatchObject({ phase: "failed" });
    await runtime.close();
  });

  it.each([
    ["coding", undefined],
    ["managed task", "managed_task"],
  ] as const)(
    "rejects interrupt input immediately after an external abort closes a %s run",
    async (_label, mode) => {
      const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
      const runtime = await createKodaXRuntime({
        homeDir: tempRoot,
        sessionsDir: path.join(tempRoot, "sessions"),
        defaultProvider: "mock-provider",
      });
      const session = await runtime.sessions.create({
        title: "External Abort Interrupt Window",
      });
      const abortController = new AbortController();
      const neverSettles = new Promise<KodaXResult>(() => undefined);
      codingMock.startKodaX.mockImplementation(
        (options: KodaXOptions): RunningSession =>
          fakeRunningSession(options, neverSettles),
      );
      codingMock.runManagedTask.mockImplementation(() => neverSettles);

      const run = await runtime.runs.start({
        sessionId: session.id,
        prompt: "wait for external abort",
        ...(mode !== undefined ? { mode } : {}),
        options: { abortSignal: abortController.signal },
      });

      try {
        abortController.abort(new Error("host cancelled"));
        await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({
          phase: "unknown",
          stage: "unknown",
          stop: {
            state: "unknown",
            outcome: "unknown",
            reason: "host cancelled",
          },
        });
        await expect(
          runtime.runs.submitInput({
            sessionId: session.id,
            afterRunId: run.runId,
            delivery: "interrupt",
            input: { type: "text", text: "arrived after external abort" },
          }),
        ).resolves.toMatchObject({
          accepted: false,
          reason: "interrupt_window_closed",
        });
        expect(getMessageQueue().size()).toBe(0);
      } finally {
        await runtime.close();
        await expect(run.result).resolves.toMatchObject({ phase: "unknown" });
      }
    },
  );

  it.each([
    ["coding", undefined],
    ["managed task", "managed_task"],
  ] as const)(
    "releases the external abort listener when Runtime aborts a %s run",
    async (_label, mode) => {
      const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
      const runtime = await createKodaXRuntime({
        homeDir: tempRoot,
        sessionsDir: path.join(tempRoot, "sessions"),
        defaultProvider: "mock-provider",
      });
      const session = await runtime.sessions.create({
        title: "Abort Listener Cleanup",
      });
      const abortController = new AbortController();
      const removeAbortListener = vi.spyOn(
        abortController.signal,
        "removeEventListener",
      );
      const neverSettles = new Promise<KodaXResult>(() => undefined);
      codingMock.startKodaX.mockImplementation(
        (options: KodaXOptions): RunningSession =>
          fakeRunningSession(options, neverSettles),
      );
      codingMock.runManagedTask.mockImplementation(() => neverSettles);

      const run = await runtime.runs.start({
        sessionId: session.id,
        prompt: "wait for Runtime abort",
        ...(mode !== undefined ? { mode } : {}),
        options: { abortSignal: abortController.signal },
      });

      await runtime.runs.abort(run.runId);
      expect(removeAbortListener).toHaveBeenCalledWith(
        "abort",
        expect.any(Function),
      );
      await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({
        phase: "unknown",
        stop: {
          state: "unknown",
          outcome: "unknown",
        },
      });
      await runtime.close();
      await expect(run.result).resolves.toMatchObject({ phase: "unknown" });
    },
  );

  it("queues active-run interrupts and reports their FIFO delivery as one batch", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({ title: "Interrupt Test" });
    const starts: string[] = [];
    let activeEvents: KodaXOptions["events"];
    let activeInterruptInput: NonNullable<
      KodaXOptions["context"]
    >["interruptInput"];
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions, prompt: string) => {
        starts.push(prompt);
        activeEvents = options.events;
        activeInterruptInput = options.context?.interruptInput;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );

    const first = await runtime.runs.start({
      sessionId: session.id,
      prompt: "first",
    });
    await vi.waitFor(() => expect(starts).toEqual(["first"]));
    expect(runtime.capabilities).toMatchObject({
      interruptInput: { version: 1, availability: "per_run" },
    });

    const firstInterrupt = await runtime.runs.submitInput({
      sessionId: session.id,
      afterRunId: first.runId,
      delivery: "interrupt",
      input: { type: "text", text: "urgent one" },
    });
    const secondInterrupt = await runtime.runs.submitInput({
      sessionId: session.id,
      afterRunId: first.runId,
      delivery: "interrupt",
      input: { type: "text", text: "urgent two" },
    });

    expect(firstInterrupt).toMatchObject({
      accepted: true,
      delivery: "interrupt",
      runId: first.runId,
      sessionId: session.id,
      afterRunId: first.runId,
    });
    expect(secondInterrupt).toMatchObject({
      accepted: true,
      delivery: "interrupt",
      runId: first.runId,
      sessionId: session.id,
      afterRunId: first.runId,
    });
    expect(starts).toEqual(["first"]);
    expect(activeInterruptInput).toBeDefined();
    activeInterruptInput?.closeInputWindow();
    await expect(
      runtime.runs.submitInput({
        sessionId: session.id,
        afterRunId: first.runId,
        delivery: "interrupt",
        input: { type: "text", text: "too late for this boundary" },
      }),
    ).resolves.toMatchObject({
      accepted: false,
      reason: "interrupt_window_closed",
    });
    activeInterruptInput?.reopenInputWindow();

    const queueAgentId = actorQueueId(session.id, "/root");
    const queued = getMessageQueue().peek({
      agentId: queueAgentId,
      maxPriority: "user",
      mode: "prompt",
    });
    expect(queued.map((message) => message.content)).toEqual([
      "urgent one",
      "urgent two",
    ]);
    await expect(runtime.runs.get(first.runId)).resolves.toMatchObject({
      interruptInputs: [
        expect.objectContaining({ delivery: "interrupt", state: "queued" }),
        expect.objectContaining({ delivery: "interrupt", state: "queued" }),
      ],
    });
    const observation = await runtime.sessions.observe(
      session.id,
      () => undefined,
    );
    expect(observation.snapshot.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: first.runId,
          interruptInputs: [
            expect.objectContaining({ state: "queued" }),
            expect.objectContaining({ state: "queued" }),
          ],
        }),
      ]),
    );
    observation.close();

    const drained = getMessageQueue().dequeue({
      agentId: queueAgentId,
      maxPriority: "user",
      mode: "prompt",
    });
    const firstDrained = drained[0];
    if (firstDrained === undefined) throw new Error("First queued interrupt missing");
    expect(() => activeEvents?.onMidTurnUserMessages?.(
      drained.map((message) => message.content),
      { queuedMessageIds: drained.map((message) => message.id) },
    )).toThrow(/canonical entry reference/i);
    await expect(runtime.runs.get(first.runId)).resolves.toMatchObject({
      interruptInputs: [
        expect.objectContaining({ state: "queued" }),
        expect.objectContaining({ state: "queued" }),
      ],
    });
    expect(() => activeEvents?.onMidTurnUserMessages?.(
      drained.map((message) => message.content),
      {
        queuedMessageIds: drained.map((message) => message.id),
        queuedMessageEntryIds: {
          [firstDrained.id]: "entry_interrupt_partial",
        },
      },
    )).toThrow(/canonical entry reference/i);
    await expect(runtime.runs.get(first.runId)).resolves.toMatchObject({
      interruptInputs: [
        expect.objectContaining({ state: "queued" }),
        expect.objectContaining({ state: "queued" }),
      ],
    });
    await expect(runtime.events.replay({
      runId: first.runId,
      type: "run.input.delivered",
    })).resolves.toEqual([]);
    activeEvents?.onMidTurnUserMessages?.(
      drained.map((message) => message.content),
      {
        queuedMessageIds: drained.map((message) => message.id),
        queuedMessageEntryIds: Object.fromEntries(
          drained.map((message, index) => [message.id, `entry_interrupt_${2 - index}`]),
        ),
      },
    );
    await flushMicrotasks();

    await expect(runtime.runs.get(first.runId)).resolves.toMatchObject({
      interruptInputs: [
        expect.objectContaining({
          state: "delivered",
          entryId: "entry_interrupt_2",
        }),
        expect.objectContaining({
          state: "delivered",
          entryId: "entry_interrupt_1",
        }),
      ],
    });
    const replay = await runtime.events.replay({ runId: first.runId });
    expect(
      replay.filter((event) => event.type === "run.input.queued"),
    ).toHaveLength(2);
    expect(
      replay.filter((event) => event.type === "run.input.delivered"),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          inputs: [
            expect.objectContaining({
              input: { type: "text", text: "urgent one" },
              entryId: "entry_interrupt_2",
            }),
            expect.objectContaining({
              input: { type: "text", text: "urgent two" },
              entryId: "entry_interrupt_1",
            }),
          ],
        }),
      }),
    ]);
    expect(starts).toEqual(["first"]);

    await runtime.runs.abort(first.runId);
    await runtime.close();
    await expect(first.result).resolves.toMatchObject({ phase: "unknown" });
  });

  it("labels rejected submitted input without mutating its run or queue", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Invalid Interrupt Input Test",
    });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions) =>
      fakeRunningSession(options, new Promise<KodaXResult>(() => undefined)),
    );
    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "first",
    });
    const queueSizeBefore = getMessageQueue().size();

    await expect(
      runtime.runs.start({
        sessionId: session.id,
        prompt: "prompt",
        input: { type: "text", text: "text item" },
      }),
    ).rejects.toThrow(
      "runtime.runs.start accepts either prompt or text input, not both",
    );
    await expect(
      runtime.runs.submitInput({
        sessionId: session.id,
        afterRunId: run.runId,
        delivery: "interrupt",
        input: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      }),
    ).rejects.toThrow(
      "runtime.runs.submitInput accepts at most one text input item",
    );
    await expect(
      runtime.runs.submitInput({
        sessionId: session.id,
        afterRunId: run.runId,
        delivery: "interrupt",
        input: [],
      }),
    ).rejects.toThrow("runtime.runs.submitInput requires prompt or text input");
    await expect(
      runtime.runs.submitInput({
        sessionId: session.id,
        afterRunId: run.runId,
        delivery: "after_turn",
        input: [],
      }),
    ).rejects.toThrow("runtime.runs.submitInput requires prompt or text input");

    const status = await runtime.runs.get(run.runId);
    expect(status.interruptInputs).toBeUndefined();
    await expect(
      runtime.runs.list({ sessionId: session.id }),
    ).resolves.toHaveLength(1);
    expect(getMessageQueue().size()).toBe(queueSizeBefore);
    await runtime.runs.abort(run.runId);
    await runtime.close();
    await expect(run.result).resolves.toMatchObject({ phase: "unknown" });
  });

  it("marks only the exact interrupt batch consumed at a safe boundary", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Interrupt Race Test",
    });
    let activeEvents: KodaXOptions["events"];
    codingMock.startKodaX.mockImplementation((options: KodaXOptions) => {
      activeEvents = options.events;
      return fakeRunningSession(
        options,
        new Promise<KodaXResult>(() => undefined),
      );
    });

    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "first",
    });
    await runtime.runs.submitInput({
      sessionId: session.id,
      afterRunId: run.runId,
      delivery: "interrupt",
      input: { type: "text", text: "consumed now" },
    });
    const queueAgentId = actorQueueId(session.id, "/root");
    const consumed = getMessageQueue().dequeue({
      agentId: queueAgentId,
      maxPriority: "user",
      mode: "prompt",
      limit: 1,
    });
    await runtime.runs.submitInput({
      sessionId: session.id,
      afterRunId: run.runId,
      delivery: "interrupt",
      input: { type: "text", text: "arrived during boundary work" },
    });

    activeEvents?.onMidTurnUserMessages?.(
      consumed.map((message) => message.content),
      {
        queuedMessageIds: consumed.map((message) => message.id),
        queuedMessageEntryIds: Object.fromEntries(
          consumed.map((message) => [message.id, "entry_consumed_now"]),
        ),
      },
    );

    await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({
      interruptInputs: [
        expect.objectContaining({ state: "delivered" }),
        expect.objectContaining({ state: "queued" }),
      ],
    });
    const deliveryEvents = await runtime.events.replay({
      runId: run.runId,
      type: "run.input.delivered",
    });
    expect(deliveryEvents).toHaveLength(1);
    expect(deliveryEvents[0]?.payload).toMatchObject({
      inputs: [
        expect.objectContaining({
          input: { type: "text", text: "consumed now" },
          entryId: "entry_consumed_now",
        }),
      ],
    });

    await runtime.runs.abort(run.runId);
    expect(getMessageQueue().size()).toBe(0);
    await runtime.close();
    await expect(run.result).resolves.toMatchObject({ phase: "unknown" });
  });

  it("does not publish delivered state when the durable batch event cannot be written", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Interrupt Persistence Failure Test",
    });
    let activeEvents: KodaXOptions["events"];
    codingMock.startKodaX.mockImplementation((options: KodaXOptions) => {
      activeEvents = options.events;
      return fakeRunningSession(
        options,
        new Promise<KodaXResult>(() => undefined),
      );
    });
    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "first",
    });
    await runtime.runs.submitInput({
      sessionId: session.id,
      afterRunId: run.runId,
      delivery: "interrupt",
      input: { type: "text", text: "must remain unconfirmed" },
    });
    const consumed = getMessageQueue().dequeue({
      agentId: actorQueueId(session.id, "/root"),
      maxPriority: "user",
      mode: "prompt",
    });
    const eventsFile = path.join(
      tempRoot,
      ".kodax",
      "runtime",
      "runs",
      encodeURIComponent(run.runId),
      "events.jsonl",
    );
    const eventsBackup = `${eventsFile}.bak`;
    await fs.rename(eventsFile, eventsBackup);
    await fs.mkdir(eventsFile);

    let deliveryError: unknown;
    try {
      activeEvents?.onMidTurnUserMessages?.(
        consumed.map((message) => message.content),
        {
          queuedMessageIds: consumed.map((message) => message.id),
          queuedMessageEntryIds: Object.fromEntries(
            consumed.map((message) => [message.id, "entry_unconfirmed"]),
          ),
        },
      );
    } catch (error: unknown) {
      deliveryError = error;
    } finally {
      await fs.rm(eventsFile, { recursive: true, force: true });
      await fs.rename(eventsBackup, eventsFile);
    }

    expect(deliveryError).toBeInstanceOf(Error);
    const failedDeliveryStatus = await runtime.runs.get(run.runId);
    expect(failedDeliveryStatus).toMatchObject({
      interruptInputs: [expect.objectContaining({ state: "queued" })],
    });
    expect(failedDeliveryStatus?.interruptInputs?.[0]).not.toHaveProperty("entryId");
    await expect(
      runtime.events.replay({
        runId: run.runId,
        type: "run.input.delivered",
      }),
    ).resolves.toEqual([]);
    const warnings = await runtime.events.replay({
      runId: run.runId,
      type: "runtime.warning",
    });
    expect(
      warnings.some(
        (event) =>
          (event.payload as Record<string, unknown>).source ===
          "run.input.delivered",
      ),
    ).toBe(true);

    await runtime.runs.abort(run.runId);
    await runtime.close();
    await expect(run.result).resolves.toMatchObject({ phase: "unknown" });
  });

  it("rejects interrupt delivery when the active run has no safe Actor boundary", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "SA Interrupt Test",
    });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions) =>
      fakeRunningSession(options, new Promise<KodaXResult>(() => undefined)),
    );

    const first = await runtime.runs.start({
      sessionId: session.id,
      prompt: "first",
      options: { agentMode: "sa" },
    });
    await expect(
      runtime.runs.submitInput({
        sessionId: session.id,
        afterRunId: first.runId,
        delivery: "interrupt",
        input: { type: "text", text: "unsupported here" },
      }),
    ).resolves.toEqual({
      accepted: false,
      delivery: "interrupt",
      sessionId: session.id,
      afterRunId: first.runId,
      reason: "unsupported_capability",
    });
    expect(getMessageQueue().size()).toBe(0);

    await runtime.runs.abort(first.runId);
    await runtime.close();
    await expect(first.result).resolves.toMatchObject({ phase: "unknown" });
  });

  it("does not leave queued input behind when interrupt cloning fails", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Interrupt Clone Failure Test",
    });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions) =>
      fakeRunningSession(options, new Promise<KodaXResult>(() => undefined)),
    );
    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "first",
    });
    const malformed = {
      type: "text",
      text: "must not be queued",
      nonCloneable: () => undefined,
    } as unknown as RuntimeInput;

    await expect(
      runtime.runs.submitInput({
        sessionId: session.id,
        afterRunId: run.runId,
        delivery: "interrupt",
        input: malformed,
      }),
    ).rejects.toThrow();
    expect(getMessageQueue().size()).toBe(0);
    const status = await runtime.runs.get(run.runId);
    expect(status.interruptInputs).toBeUndefined();

    await runtime.runs.abort(run.runId);
    await runtime.close();
    await expect(run.result).resolves.toMatchObject({ phase: "unknown" });
  });

  it("terminalizes and removes an interrupt that the active run never consumes", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Interrupt Cleanup Test",
    });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions) =>
      fakeRunningSession(options, new Promise<KodaXResult>(() => undefined)),
    );

    const first = await runtime.runs.start({
      sessionId: session.id,
      prompt: "first",
    });
    const submitted = await runtime.runs.submitInput({
      sessionId: session.id,
      afterRunId: first.runId,
      delivery: "interrupt",
      input: { type: "text", text: "never delivered" },
    });
    expect(submitted).toMatchObject({ accepted: true, delivery: "interrupt" });
    expect(getMessageQueue().size()).toBe(1);

    await runtime.runs.abort(first.runId);

    expect(getMessageQueue().size()).toBe(0);
    await expect(runtime.runs.get(first.runId)).resolves.toMatchObject({
      phase: "unknown",
      interruptInputs: [expect.objectContaining({ state: "terminal" })],
    });
    await expect(
      runtime.events.replay({
        runId: first.runId,
        type: "run.input.delivered",
      }),
    ).resolves.toEqual([]);
    await expect(
      runtime.runs.submitInput({
        sessionId: session.id,
        afterRunId: first.runId,
        delivery: "interrupt",
        input: { type: "text", text: "too late" },
      }),
    ).resolves.toMatchObject({
      accepted: false,
      reason: "interrupt_window_closed",
    });
    await runtime.close();
    await expect(first.result).resolves.toMatchObject({ phase: "unknown" });
  });

  it("fails closed when a run-scoped credential is bound to another provider", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Credential Scope",
    });
    const trustedInput = {
      sessionId: session.id,
      prompt: "must not run",
      providerCredential: "leased-secret",
      providerCredentialProvider: "another-provider",
    } as RuntimeStartRunInput & {
      readonly providerCredential: string;
      readonly providerCredentialProvider: string;
    };

    await expect(runtime.runs.start(trustedInput)).rejects.toMatchObject({
      code: "credential_unavailable",
    });
    expect(codingMock.startKodaX).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("never persists a provider error that may echo a run-scoped credential", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const secret = "F269_PROVIDER_ERROR_SECRET";
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Credential Error Redaction",
    });
    codingMock.startKodaX.mockImplementation((options: KodaXOptions) => {
      options.events?.onRetry?.(`provider echoed ${secret}`, 1, 1);
      options.events?.onError?.(new Error(`provider emitted ${secret}`));
      return fakeRunningSession(
        options,
        Promise.reject(new Error(`provider rejected ${secret}`)),
      );
    });
    const trustedInput = {
      sessionId: session.id,
      prompt: "fail safely",
      providerCredential: secret,
      providerCredentialProvider: "mock-provider",
    } as RuntimeStartRunInput & {
      readonly providerCredential: string;
      readonly providerCredentialProvider: string;
    };

    const handle = await runtime.runs.start(trustedInput);
    await expect(handle.result).resolves.toMatchObject({
      phase: "failed",
      error: {
        message: "Provider run failed while using a run-scoped credential.",
      },
    });
    expect(JSON.stringify(await runtime.runs.get(handle.runId))).not.toContain(
      secret,
    );
    expect(
      JSON.stringify(await runtime.events.replay({ runId: handle.runId })),
    ).not.toContain(secret);
    await runtime.close();
    expect(await readDirectoryText(tempRoot)).not.toContain(secret);
  });

  it("preserves trusted managed Stop causality before run-scoped credential redaction", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const secret = "F280_ABORT_CREDENTIAL_SECRET";
    const originalToolHook = vi.fn(async () => true);
    let managedOptions: KodaXOptions | undefined;
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "managed-abort-credential-sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Managed Abort Credential Causality",
    });
    codingMock.runManagedTask.mockImplementation((options: KodaXOptions) => {
      managedOptions = options;
      return new Promise<KodaXResult>((_resolve, reject) => {
        const rejectFromAbort = (): void => {
          const error = new Error(`Provider observed AbortSignal with ${secret}`);
          error.name = "AbortError";
          options.events?.onError?.(error);
          reject(error);
        };
        options.abortSignal?.addEventListener("abort", rejectFromAbort, {
          once: true,
        });
        if (options.abortSignal?.aborted) rejectFromAbort();
      });
    });
    const trustedInput = {
      sessionId: session.id,
      prompt: "stop without losing trusted causality",
      mode: "managed_task",
      options: { events: { beforeToolExecute: originalToolHook } },
      providerCredential: secret,
      providerCredentialProvider: "mock-provider",
    } as RuntimeStartRunInput & {
      readonly providerCredential: string;
      readonly providerCredentialProvider: string;
    };

    const handle = await runtime.runs.start(trustedInput);
    const receipt = await runtime.runs.abort(handle.runId);
    expect(receipt).toMatchObject({
      accepted: true,
      phase: "unknown",
      state: "unknown",
      outcome: "unknown",
    });
    await expect(managedOptions?.events?.beforeToolExecute?.(
      "bash",
      { command: "must not execute" },
    )).resolves.toBe("runtime run aborted");
    expect(originalToolHook).not.toHaveBeenCalled();

    const result = await handle.result;
    expect(result).toMatchObject({
      phase: "interrupted",
      terminal: {
        kind: "interrupted",
        code: "interrupted",
        effectOutcome: "unknown",
      },
      stop: { state: "confirmed", outcome: "interrupted" },
    });
    expect(result).not.toHaveProperty("error");
    await expect(runtime.runs.await(handle.runId)).resolves.toEqual(result);
    await expect(runtime.runs.get(handle.runId)).resolves.toMatchObject({
      phase: "interrupted",
      terminal: { kind: "interrupted", code: "interrupted" },
      stop: { state: "confirmed", outcome: "interrupted" },
    });
    const terminalEvents = await runtime.events.replay({
      runId: handle.runId,
      type: ["run.interrupted", "run.failed"],
    });
    expect(terminalEvents.map((event) => event.type)).toEqual(["run.interrupted"]);
    expect(JSON.stringify({ result, terminalEvents })).not.toContain(secret);

    await runtime.close();
    const persisted = await readDirectoryText(tempRoot);
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain(
      "Provider run failed while using a run-scoped credential.",
    );
  });

  it("keeps an independent managed failure after Stop on the credential-safe failed path", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const secret = "F280_INDEPENDENT_FAILURE_SECRET";
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "managed-stop-failure-sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Managed Stop Independent Failure",
    });
    codingMock.runManagedTask.mockImplementation((options: KodaXOptions) =>
      new Promise<KodaXResult>((_resolve, reject) => {
        const fail = (): void => {
          const error = new Error(`Independent finalizer failure ${secret}`);
          options.events?.onError?.(error);
          reject(error);
        };
        options.abortSignal?.addEventListener("abort", fail, { once: true });
        if (options.abortSignal?.aborted) fail();
      }),
    );
    const trustedInput = {
      sessionId: session.id,
      prompt: "fail independently after Stop",
      mode: "managed_task",
      providerCredential: secret,
      providerCredentialProvider: "mock-provider",
    } as RuntimeStartRunInput & {
      readonly providerCredential: string;
      readonly providerCredentialProvider: string;
    };

    const handle = await runtime.runs.start(trustedInput);
    await runtime.runs.abort(handle.runId);
    await expect(handle.result).resolves.toMatchObject({
      phase: "failed",
      error: {
        message: "Provider run failed while using a run-scoped credential.",
      },
      terminal: { kind: "failed", code: "run_failed" },
      stop: { state: "confirmed", outcome: "failed" },
    });
    const persisted = JSON.stringify(await runtime.runs.get(handle.runId));
    expect(persisted).not.toContain(secret);
    await runtime.close();
  });

  it("keeps an unrequested managed AbortError on the failed path", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "unrequested-abort-error-sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Unrequested AbortError",
    });
    codingMock.runManagedTask.mockImplementation((options: KodaXOptions) => {
      const error = new Error("synthetic provider AbortError");
      error.name = "AbortError";
      options.events?.onError?.(error);
      return Promise.reject(error);
    });

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "fail without Stop",
      mode: "managed_task",
    });

    await expect(handle.result).resolves.toMatchObject({
      phase: "failed",
      terminal: { kind: "failed", code: "run_failed" },
      error: { name: "AbortError", message: "synthetic provider AbortError" },
    });
    await runtime.close();
  });

  it("keeps queued runs on the session settings snapshot captured at queue time", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
    });
    const session = await runtime.sessions.create({
      title: "Queued Settings Snapshot",
    });
    await runtime.sessions.updateSettings(session.id, {
      provider: "settings-provider-a",
      model: "settings-model-a",
    });

    const starts: Array<{
      readonly prompt: string;
      readonly provider?: string;
      readonly model?: string;
    }> = [];
    let finishFirst: ((value: KodaXResult) => void) | undefined;
    let finishSecond: ((value: KodaXResult) => void) | undefined;
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions, prompt: string): RunningSession => {
        starts.push({
          prompt,
          provider: options.provider,
          model: options.modelOverride,
        });
        if (prompt === "first") {
          return fakeRunningSession(
            options,
            new Promise<KodaXResult>((resolve) => {
              finishFirst = resolve;
            }),
          );
        }
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>((resolve) => {
            finishSecond = resolve;
          }),
        );
      },
    );

    const first = await runtime.runs.start({
      sessionId: session.id,
      prompt: "first",
    });
    const second = await runtime.runs.start({
      sessionId: session.id,
      prompt: "second",
    });
    await runtime.sessions.updateSettings(session.id, {
      provider: "settings-provider-b",
      model: "settings-model-b",
    });

    expect((await runtime.runs.get(second.runId)).phase).toBe("queued");
    expect(starts).toEqual([
      {
        prompt: "first",
        provider: "settings-provider-a",
        model: "settings-model-a",
      },
    ]);

    finishFirst?.({
      success: true,
      lastText: "first done",
      messages: [],
      sessionId: session.id,
    });
    await first.result;
    await flushMicrotasks();

    expect(starts).toEqual([
      {
        prompt: "first",
        provider: "settings-provider-a",
        model: "settings-model-a",
      },
      {
        prompt: "second",
        provider: "settings-provider-a",
        model: "settings-model-a",
      },
    ]);

    finishSecond?.({
      success: true,
      lastText: "second done",
      messages: [],
      sessionId: session.id,
    });
    await expect(second.result).resolves.toMatchObject({ phase: "completed" });

    await runtime.close();
  });

  it("allows different sessions to run concurrently without cross-queueing", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const firstSession = await runtime.sessions.create({
      title: "Concurrent A",
    });
    const secondSession = await runtime.sessions.create({
      title: "Concurrent B",
    });
    const starts: string[] = [];
    let finishFirst: ((value: KodaXResult) => void) | undefined;
    let finishSecond: ((value: KodaXResult) => void) | undefined;

    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions, prompt: string): RunningSession => {
        starts.push(`${options.session?.id ?? "missing"}:${prompt}`);
        if (prompt === "first-session") {
          return fakeRunningSession(
            options,
            new Promise<KodaXResult>((resolve) => {
              finishFirst = resolve;
            }),
          );
        }
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>((resolve) => {
            finishSecond = resolve;
          }),
        );
      },
    );

    const first = await runtime.runs.start({
      sessionId: firstSession.id,
      prompt: "first-session",
    });
    const second = await runtime.runs.start({
      sessionId: secondSession.id,
      prompt: "second-session",
    });

    expect(starts).toEqual([
      `${firstSession.id}:first-session`,
      `${secondSession.id}:second-session`,
    ]);
    expect((await runtime.runs.get(first.runId)).phase).toBe("running");
    expect((await runtime.runs.get(second.runId)).phase).toBe("running");
    await expect(
      runtime.events.replay({ type: "run.queued" }),
    ).resolves.toEqual([]);

    finishFirst?.({
      success: true,
      lastText: "first done",
      messages: [],
      sessionId: firstSession.id,
    });
    finishSecond?.({
      success: true,
      lastText: "second done",
      messages: [],
      sessionId: secondSession.id,
    });

    await expect(first.result).resolves.toMatchObject({
      phase: "completed",
      sessionId: firstSession.id,
    });
    await expect(second.result).resolves.toMatchObject({
      phase: "completed",
      sessionId: secondSession.id,
    });

    await runtime.close();
  });

  it("persists runtime replay and terminal run status across runtime recreation", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const sessionsDir = path.join(tempRoot, "sessions");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Persistence Test",
    });

    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        const sessionId = options.session?.id ?? session.id;
        queueMicrotask(() => {
          options.events?.onTextDelta?.("persist me", {
            sessionId,
            seq: 1,
            timestamp: new Date().toISOString(),
          });
        });
        return fakeRunningSession(
          options,
          Promise.resolve({
            success: true,
            lastText: "persisted",
            messages: [],
            sessionId,
          }),
        );
      },
    );

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "persist",
    });
    await handle.result;
    const snapshot = await runtime.status.snapshot();
    expect(snapshot.runs).toContainEqual(
      expect.objectContaining({
        runId: handle.runId,
        phase: "completed",
      }),
    );
    await runtime.close();

    const recreated = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: "mock-provider",
    });
    const replay = await recreated.events.replay({ runId: handle.runId });
    const restoredStatus = await recreated.runs.get(handle.runId);

    expect(replay.map((event) => event.type)).toEqual([
      "run.started",
      "config.effective",
      "assistant.delta",
      "run.completed",
    ]);
    expect(restoredStatus).toMatchObject({
      runId: handle.runId,
      sessionId: session.id,
      phase: "completed",
    });

    await recreated.close();
  });

  it("keeps event sequences monotonic across runtime recreation and honors sinceSeq", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const sessionsDir = path.join(tempRoot, "sessions");
    const first = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir });
    const firstSession = await first.sessions.create({
      sessionId: "sequence-first",
    });
    const firstEvents = await first.events.replay({
      sessionId: firstSession.id,
    });
    const lastFirstSeq = firstEvents.at(-1)?.seq;
    expect(lastFirstSeq).toBeDefined();
    await first.close();

    const second = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir });
    const secondSession = await second.sessions.create({
      sessionId: "sequence-second",
    });
    const allEvents = await second.events.replay();
    const afterFirst = await second.events.replay({ sinceSeq: lastFirstSeq });

    expect(allEvents.map((event) => event.seq)).toEqual(
      [...allEvents.map((event) => event.seq)].sort((a, b) => a - b),
    );
    expect(new Set(allEvents.map((event) => event.seq)).size).toBe(
      allEvents.length,
    );
    expect(afterFirst).toEqual([
      expect.objectContaining({
        sessionId: secondSession.id,
        type: "session.created",
      }),
    ]);
    expect(afterFirst[0]?.seq).toBeGreaterThan(lastFirstSeq!);
    await second.close();
  });

  it("recovers event sequence after cursor loss when the last event exceeds the tail window", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const sessionsDir = path.join(tempRoot, "sessions");
    const first = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir });
    const source = await first.sessions.create({
      sessionId: "large-sequence-source",
    });
    await first.sessions.appendNotice({
      sessionId: source.id,
      source: "sequence-recovery",
      content: "n".repeat(256 * 1024),
    });
    const priorEvents = await first.events.replay();
    const priorMax = Math.max(...priorEvents.map((event) => event.seq));
    await first.close();

    await fs.rm(
      path.join(tempRoot, ".kodax", "runtime", "event-sequence"),
    );
    const second = await createKodaXRuntime({ homeDir: tempRoot, sessionsDir });
    const observation = await second.sessions.observe(
      source.id,
      () => undefined,
    );
    expect(observation.snapshot.cursor).toBeGreaterThanOrEqual(priorMax);
    observation.close();
    const created = await second.sessions.create({
      sessionId: "after-sequence-cursor-loss",
    });
    const createdEvent = (await second.events.replay({
      sessionId: created.id,
    })).find((event) => event.type === "session.created");

    expect(createdEvent?.seq).toBeGreaterThan(priorMax);
    await second.close();
  });

  it("caps in-memory terminal run records while keeping persisted run lookup available", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Run Retention Test",
    });
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions, prompt: string): RunningSession =>
        fakeRunningSession(
          options,
          Promise.resolve({
            success: true,
            lastText: prompt,
            messages: [],
            sessionId: session.id,
          }),
        ),
    );

    const runsDir = path.join(tempRoot, ".kodax", "runtime", "runs");
    const readdirSync = mutableNodeFs.readdirSync;
    let runsDirectoryReads = 0;
    let firstRunId = "";
    try {
      mutableNodeFs.readdirSync = ((directory, options) => {
        if (String(directory) === runsDir) runsDirectoryReads += 1;
        return readdirSync(directory, options);
      }) as typeof nodeFs.readdirSync;
      syncBuiltinESMExports();
      try {
        for (let i = 0; i < 1_005; i += 1) {
          const handle = await runtime.runs.start({
            sessionId: session.id,
            prompt: `retained-${i}`,
          });
          if (i === 0) firstRunId = handle.runId;
          await handle.result;
        }
      } finally {
        mutableNodeFs.readdirSync = readdirSync;
        syncBuiltinESMExports();
      }

      expect(runsDirectoryReads).toBeLessThanOrEqual(2);
      const snapshot = await runtime.status.snapshot();
      expect(snapshot.runs.length).toBeLessThanOrEqual(1_000);
      expect(snapshot.runs.some((run) => run.runId === firstRunId)).toBe(false);
      await expect(runtime.runs.get(firstRunId)).resolves.toMatchObject({
        runId: firstRunId,
        phase: "completed",
      });
    } finally {
      mutableNodeFs.readdirSync = readdirSync;
      syncBuiltinESMExports();
      await runtime.close();
    }
  }, 150_000);

  it("rejects runs for missing sessions before calling the coding layer", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: "mock-provider",
    });

    await expect(
      runtime.runs.start({
        sessionId: "missing-session",
        prompt: "should not start",
      }),
    ).rejects.toThrow("Session not found: missing-session");
    expect(codingMock.startKodaX).not.toHaveBeenCalled();

    await runtime.close();
  });

  it("reports the executor's late success instead of fabricating Stop success", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({ title: "Abort Race Test" });
    let finishRun: ((value: KodaXResult) => void) | undefined;

    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession =>
        fakeRunningSession(
          options,
          new Promise<KodaXResult>((resolve) => {
            finishRun = resolve;
          }),
        ),
    );

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "abort me",
    });
    const receipt = await runtime.runs.abort(handle.runId);
    expect(receipt).toMatchObject({
      runId: handle.runId,
      sessionId: session.id,
      accepted: true,
      phase: "unknown",
      state: "unknown",
      outcome: "unknown",
      revision: expect.any(Number),
    });
    await expect(runtime.runs.abort(handle.runId)).resolves.toEqual({
      ...receipt,
      accepted: false,
    });
    finishRun?.({
      success: true,
      lastText: "late success",
      messages: [],
      sessionId: session.id,
    });

    const result = await handle.result;
    const status = await runtime.runs.get(handle.runId);
    const terminalEvents = await runtime.events.replay({
      runId: handle.runId,
      type: ["run.completed", "run.cancelled"],
    });

    expect(result.phase).toBe("completed");
    expect(status).toMatchObject({
      phase: "completed",
      stop: {
        state: "confirmed",
        outcome: "completed",
        reason: "runtime run aborted",
      },
    });
    expect(terminalEvents.map((event) => event.type)).toEqual([
      "run.completed",
    ]);

    await runtime.close();
  });

  it("does not fabricate a terminal result when an active executor ignores Stop", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Abort Settle Test",
    });

    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession =>
        fakeRunningSession(options, new Promise<KodaXResult>(() => undefined)),
    );

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "abort me",
    });
    await runtime.runs.abort(handle.runId);

    let settled = false;
    void handle.result.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);
    await expect(runtime.runs.get(handle.runId)).resolves.toMatchObject({
      phase: "unknown",
      stop: {
        state: "unknown",
        outcome: "unknown",
      },
    });
    await runtime.close();
    await expect(handle.result).resolves.toMatchObject({ phase: "unknown" });
  });

  it("returns an idempotent no-op Stop receipt for a completed run", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Terminal Stop Receipt",
    });
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession =>
        fakeRunningSession(
          options,
          Promise.resolve({
            success: true,
            lastText: "done",
            messages: [],
            sessionId: session.id,
          }),
        ),
    );
    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "finish before Stop",
    });
    await handle.result;

    await expect(runtime.runs.abort(handle.runId)).resolves.toMatchObject({
      runId: handle.runId,
      accepted: false,
      phase: "completed",
      state: "confirmed",
      outcome: "completed",
      revision: expect.any(Number),
    });
    await runtime.close();
  });

  it("atomically cancels a queued run and returns an idempotent Stop receipt", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Queued Stop Receipt",
    });
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession =>
        fakeRunningSession(options, new Promise<KodaXResult>(() => undefined)),
    );
    const active = await runtime.runs.start({
      sessionId: session.id,
      prompt: "stay active",
    });
    const queued = await runtime.runs.start({
      sessionId: session.id,
      prompt: "cancel while queued",
    });

    const receipt = await runtime.runs.abort(queued.runId);
    expect(receipt).toMatchObject({
      runId: queued.runId,
      sessionId: session.id,
      accepted: true,
      phase: "cancelled",
      state: "confirmed",
      outcome: "cancelled",
      revision: expect.any(Number),
    });
    await expect(runtime.runs.abort(queued.runId)).resolves.toEqual({
      ...receipt,
      accepted: false,
    });
    await expect(queued.result).resolves.toMatchObject({ phase: "cancelled" });
    await runtime.close();
    await expect(active.result).resolves.toMatchObject({ phase: "unknown" });
  });

  it("returns a committed queued Stop when its derived index update fails", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Queued Stop Index Failure",
    });
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession =>
        fakeRunningSession(options, new Promise<KodaXResult>(() => undefined)),
    );
    const active = await runtime.runs.start({
      sessionId: session.id,
      prompt: "stay active while index fails",
    });
    const queued = await runtime.runs.start({
      sessionId: session.id,
      prompt: "cancel despite derived index failure",
    });
    const runStatusIndexLockCandidate = `${path.join(
      tempRoot,
      ".kodax",
      "runtime",
      "run-status-index.json.lock",
    )}.candidate.`;
    const openSync = mutableNodeFs.openSync;
    let indexLockFailures = 0;
    try {
      mutableNodeFs.openSync = ((file, flags, mode) => {
        if (String(file).startsWith(runStatusIndexLockCandidate)) {
          indexLockFailures += 1;
          throw Object.assign(new Error("synthetic index lock failure"), {
            code: "EIO",
          });
        }
        return openSync(file, flags, mode);
      }) as typeof nodeFs.openSync;
      syncBuiltinESMExports();

      await expect(runtime.runs.abort(queued.runId)).resolves.toMatchObject({
        runId: queued.runId,
        accepted: true,
        phase: "cancelled",
        state: "confirmed",
        outcome: "cancelled",
      });
      expect(indexLockFailures).toBeGreaterThan(0);
      await expect(runtime.runs.get(queued.runId)).resolves.toMatchObject({
        runId: queued.runId,
        phase: "cancelled",
      });
      await expect(queued.result).resolves.toMatchObject({
        phase: "cancelled",
      });
    } finally {
      mutableNodeFs.openSync = openSync;
      syncBuiltinESMExports();
      await runtime.close();
      await expect(active.result).resolves.toMatchObject({ phase: "unknown" });
    }
  });

  it("reports an unconfirmed Stop as unknown until the executor settles", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Unconfirmed Stop Test",
    });

    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession =>
        fakeRunningSession(options, new Promise<KodaXResult>(() => undefined)),
    );

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "ignore cooperative abort",
    });
    await runtime.runs.abort(handle.runId);

    await expect(runtime.runs.get(handle.runId)).resolves.toMatchObject({
      phase: "unknown",
      stage: "unknown",
      stop: {
        state: "unknown",
        outcome: "unknown",
        reason: "runtime run aborted",
      },
    });
    await expect(runtime.sessions.status(session.id)).resolves.toMatchObject({
      runId: handle.runId,
      phase: "unknown",
    });
    await expect(runtime.status.preflight()).resolves.toMatchObject({
      canStop: false,
      activeRuns: [expect.objectContaining({
        runId: handle.runId,
        phase: "unknown",
      })],
    });

    await runtime.close();
  });

  it("rejects Session archive and deletion while the same Runtime has an active root Run", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Active Run Session Mutation Fence",
    });
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession =>
        fakeRunningSession(options, new Promise<KodaXResult>(() => undefined)),
    );
    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "keep running",
    });

    await expect(runtime.sessions.archive(session.id)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(runtime.sessions.delete(session.id)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(runtime.sessions.load(session.id)).resolves.toMatchObject({
      id: session.id,
    });

    await runtime.runs.abort(handle.runId);
    await runtime.close();
    await expect(handle.result).resolves.toMatchObject({ phase: "unknown" });
  });

  it("serializes Run admission with destructive Session operations", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Run Admission Mutation Gate",
    });
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession =>
        fakeRunningSession(options, new Promise<KodaXResult>(() => undefined)),
    );

    let releaseAdmission: (() => void) | undefined;
    let markAdmissionEntered: (() => void) | undefined;
    const admissionEntered = new Promise<void>((resolve) => {
      markAdmissionEntered = resolve;
    });
    const blockedLoad = replMock.loadSessionCalls + 1;
    replMock.beforeLoadSession = async (call) => {
      if (call !== blockedLoad) return;
      markAdmissionEntered?.();
      await new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
    };

    const starting = runtime.runs.start({
      sessionId: session.id,
      prompt: "hold before the Run is registered",
    });
    await admissionEntered;
    let archiveSettled = false;
    const archiving = runtime.sessions.archive(session.id).finally(() => {
      archiveSettled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(archiveSettled).toBe(false);

    releaseAdmission?.();
    const handle = await starting;
    await expect(archiving).rejects.toMatchObject({ code: "conflict" });
    await runtime.runs.abort(handle.runId);
    await runtime.close();
    await expect(handle.result).resolves.toMatchObject({ phase: "unknown" });
  });

  it("drains in-flight Run admission before closing the Actor registry", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Runtime Close Admission Drain",
    });

    let releaseAdmission: (() => void) | undefined;
    let markAdmissionEntered: (() => void) | undefined;
    const admissionEntered = new Promise<void>((resolve) => {
      markAdmissionEntered = resolve;
    });
    const blockedLoad = replMock.loadSessionCalls + 1;
    replMock.beforeLoadSession = async (call) => {
      if (call !== blockedLoad) return;
      markAdmissionEntered?.();
      await new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
    };

    const starting = runtime.runs.start({
      sessionId: session.id,
      prompt: "close while admission is paused",
    });
    await admissionEntered;
    let closeSettled = false;
    const closing = runtime.close();
    const concurrentClose = runtime.close();
    expect(concurrentClose).toBe(closing);
    void closing.finally(() => {
      closeSettled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(closeSettled).toBe(false);

    releaseAdmission?.();
    const handle = await starting;
    await closing;
    await expect(handle.result).resolves.toMatchObject({
      phase: "unknown",
    });

    const restarted = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    await expect(restarted.agents.tree(session.id)).resolves.toMatchObject({
      actors: [expect.objectContaining({ path: "/root" })],
    });
    await restarted.close();
  });

  it("uses the Actor owner fence for SA root Runs across Runtimes", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const sessionsDir = path.join(tempRoot, "sa-owner-sessions");
    const owner = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: "mock-provider",
    });
    const contender = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: "mock-provider",
    });
    const session = await owner.sessions.create({
      title: "SA Root Run Owner",
    });
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession =>
        fakeRunningSession(options, new Promise<KodaXResult>(() => undefined)),
    );
    const handle = await owner.runs.start({
      sessionId: session.id,
      prompt: "keep the SA root Run active",
      options: { agentMode: "sa" },
    });

    await expect(contender.sessions.archive(session.id)).rejects.toMatchObject({
      code: "actor_owner_conflict",
    });

    await owner.runs.abort(handle.runId);
    await expect(owner.runs.get(handle.runId)).resolves.toMatchObject({
      phase: "unknown",
    });
    await owner.close();
    await expect(handle.result).resolves.toMatchObject({ phase: "unknown" });
    await expect(contender.sessions.archive(session.id)).rejects.toMatchObject({
      code: "actor_owner_conflict",
    });
    await contender.close();
  });

  it("resolves running and queued run results when the runtime closes", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Close Settle Test",
    });

    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession =>
        fakeRunningSession(options, new Promise<KodaXResult>(() => undefined)),
    );

    const first = await runtime.runs.start({
      sessionId: session.id,
      prompt: "first",
    });
    const second = await runtime.runs.start({
      sessionId: session.id,
      prompt: "second",
    });
    expect((await runtime.runs.get(second.runId)).phase).toBe("queued");

    await runtime.close();

    await expect(
      expectSettles(first.result, "closed running run result"),
    ).resolves.toMatchObject({
      phase: "unknown",
    });
    await expect(
      expectSettles(second.result, "closed queued run result"),
    ).resolves.toMatchObject({
      phase: "cancelled",
    });
  });

  it("routes legacy media follow-up helpers to the active SDK Actor session", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Queue Route Test",
    });
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession =>
        fakeRunningSession(options, new Promise<KodaXResult>(() => undefined)),
    );

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "stay active",
    });
    enqueueWithArtifacts({
      provider: "mock-provider",
      content: "queued follow-up",
    });

    const queueAgentId = actorQueueId(session.id, "/root");
    expect(resolveActiveRootQueueRoute()).toBe(queueAgentId);
    expect(
      getMessageQueue().dequeue({
        agentId: queueAgentId,
        maxPriority: "user",
        mode: "prompt",
      }),
    ).toHaveLength(1);

    await runtime.runs.abort(handle.runId);
    expect(resolveActiveRootQueueRoute()).toBe(actorQueueId(session.id, "/root"));
    await runtime.close();
    await expect(handle.result).resolves.toMatchObject({ phase: "unknown" });
    expect(resolveActiveRootQueueRoute()).toBeUndefined();
  });

  it.each([
    ["coding", undefined],
    ["managed task", "managed_task"],
  ] as const)(
    "terminalizes a %s run when SDK launch throws synchronously",
    async (_label, mode) => {
      const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
      const runtime = await createKodaXRuntime({
        sessionsDir: tempRoot,
        defaultProvider: "mock-provider",
      });
      const session = await runtime.sessions.create({
        title: "Queue Route Launch Failure",
      });
      const throwLaunchError = (): never => {
        throw new Error("synchronous launch failure");
      };
      codingMock.startKodaX.mockImplementation(throwLaunchError);
      codingMock.runManagedTask.mockImplementation(throwLaunchError);

      await expect(
        runtime.runs.start({
          sessionId: session.id,
          prompt: "fail before launch",
          ...(mode !== undefined ? { mode } : {}),
        }),
      ).rejects.toThrow("synchronous launch failure");

      const [failedRun] = await runtime.runs.list({ sessionId: session.id });
      expect(failedRun).toMatchObject({
        phase: "failed",
        error: "synchronous launch failure",
      });
      await expect(
        runtime.runs.submitInput({
          sessionId: session.id,
          afterRunId: failedRun!.runId,
          delivery: "interrupt",
          input: { type: "text", text: "must not enter failed run" },
        }),
      ).resolves.toMatchObject({
        accepted: false,
        reason: "interrupt_window_closed",
      });
      expect(resolveActiveRootQueueRoute()).toBeUndefined();

      await runtime.close();
    },
  );

  it("does not terminalize a synchronous launch failure over a queued Actor settlement", async () => {
    vi.useFakeTimers();
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const external = deferredExternalAgentFixture("launch-race");
    const originalSave = FileSessionStorage.prototype.saveActorSnapshot;
    const save = vi.spyOn(
      FileSessionStorage.prototype,
      "saveActorSnapshot",
    ).mockImplementation(async function (
      this: FileSessionStorage,
      id: string,
      snapshot: AgentActorSnapshot,
      expectedRevision: number,
    ) {
      if (snapshot.turns.some(
        (turn) =>
          turn.actorPath === "/root/deferred"
          && turn.state === "completed",
      )) {
        throw new Error("launch-race Actor storage unavailable");
      }
      await originalSave.call(this, id, snapshot, expectedRevision);
    });
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "launch-race-sessions"),
      defaultProvider: "mock-provider",
      externalAgents: {
        factories: [external.factory],
        policy: async () => ({ allowed: true }),
        defaultContext: { actorId: "launch-race-host" },
      },
    });
    try {
      await runtime.admin.agentRegistrations.upsert(external.registration);
      const session = await runtime.sessions.create({
        sessionId: "launch-race",
      });
      await runtime.agents.spawn(session.id, {
        taskName: "deferred",
        kind: "external",
        objective: "Settle while SDK launch throws.",
        metadata: { agentId: external.registration.agentId },
      });
      codingMock.startKodaX.mockImplementation((): never => {
        external.finish();
        throw new Error("synchronous launch failure");
      });

      await expect(runtime.runs.start({
        sessionId: session.id,
        prompt: "do not persist a false terminal",
      })).rejects.toThrow("synchronous launch failure");
      await vi.advanceTimersByTimeAsync(6_000);

      const [run] = await runtime.runs.list({ sessionId: session.id });
      expect(run).toMatchObject({
        phase: "unknown",
        lifecycleError: {
          code: "actor_settlement_not_persisted",
          retryable: false,
        },
      });
      expect(run).not.toHaveProperty("terminal");
    } finally {
      external.finish();
      vi.useRealTimers();
      save.mockRestore();
      await expect(runtime.close()).rejects.toMatchObject({
        code: "actor_shutdown_not_persisted",
      });
    }
  });

  it("rejects pending permissions when aborting a run", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Abort Permission Test",
    });
    let approvalDone: Promise<boolean | string> | undefined;

    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        queueMicrotask(() => {
          approvalDone = options.events?.beforeToolExecute?.(
            "bash",
            { command: "npm test" },
            {
              sessionId: options.session?.id ?? session.id,
              seq: 1,
              turnId: "turn-abort-permission",
              toolId: "tool-abort-permission",
            },
          );
        });
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "needs permission",
    });
    await flushMicrotasks();

    expect(
      await runtime.permissions.listPending({ runId: handle.runId }),
    ).toHaveLength(1);
    await runtime.runs.abort(handle.runId);

    expect(approvalDone).toBeDefined();
    await expect(
      expectSettles(approvalDone!, "aborted permission"),
    ).resolves.toBe("runtime run aborted");
    expect(
      await runtime.permissions.listPending({ runId: handle.runId }),
    ).toEqual([]);
    await expect(runtime.runs.get(handle.runId)).resolves.toMatchObject({
      phase: "unknown",
    });

    await runtime.close();
    await expect(handle.result).resolves.toMatchObject({ phase: "unknown" });
  });

  it("expires runtime permission requests using expiresAt", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      permissionTimeoutMs: 60_000,
    });

    const decision = runtime.permissions.request({
      sessionId: "permission-expiry-session",
      runId: "permission-expiry-run",
      toolName: "bash",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    await expect(
      expectSettles(decision, "expired permission decision"),
    ).resolves.toEqual({
      type: "reject",
      reason: "permission request timed out",
      cause: "approval_timeout",
    });
    await expect(
      runtime.permissions.listPending({
        runId: "permission-expiry-run",
      }),
    ).resolves.toEqual([]);

    await runtime.close();
  });

  it("runs managed_task mode through runManagedTask and settles on abort", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Managed Task Test",
    });
    let signal: AbortSignal | undefined;

    codingMock.runManagedTask.mockImplementation((options: KodaXOptions) => {
      signal = options.abortSignal;
      options.events?.onManagedTaskStatus?.({
        agentMode: "ama",
        harnessProfile: "standard" as never,
        phase: "worker",
        activeWorkerId: "worker-1",
        activeWorkerTitle: "Implementing",
        currentRound: 2,
        maxRounds: 4,
      });
      return new Promise<KodaXResult>(() => undefined);
    });

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "managed",
      mode: "managed_task",
    });
    expect(codingMock.runManagedTask).toHaveBeenCalledOnce();
    expect(codingMock.startKodaX).not.toHaveBeenCalled();
    const observation = await runtime.sessions.observe(
      session.id,
      () => undefined,
    );
    expect(observation.snapshot.live.managedTasks).toEqual([
      expect.objectContaining({
        runId: handle.runId,
        status: expect.objectContaining({
          phase: "worker",
          activeWorkerId: "worker-1",
          currentRound: 2,
        }),
      }),
    ]);
    observation.close();

    await runtime.runs.abort(handle.runId);

    expect(signal?.aborted).toBe(true);
    await expect(runtime.runs.get(handle.runId)).resolves.toMatchObject({
      phase: "unknown",
      stop: {
        state: "unknown",
        outcome: "unknown",
      },
    });

    await runtime.close();
    await expect(handle.result).resolves.toMatchObject({ phase: "unknown" });
  });

  it("advertises and negotiates the complete Skill Learning Loop contract inline", async () => {
    const { createKodaXRuntime } = await import("./sdk-runtime.js");
    const runtime = await createKodaXRuntime({
      mode: "embedded",
      homeDir: tempRoot,
      requirements: { skillLearningLoop: 1 },
    });

    expect(runtime.capabilities.skillLearningLoop).toEqual({
      version: 1,
      activation: "project_scoped_canary",
      immutableDecisions: true,
      recordGatedDiscovery: true,
      exactUseAttribution: true,
      rollback: true,
    });
    await runtime.close();
  });

  it("fails closed when a connected Runtime lacks the complete Skill Learning Loop", async () => {
    const { connectKodaXRuntime } = await import("./sdk-runtime.js");
    const transport: RuntimeDaemonClientTransport = {
      async request(method) {
        if (method !== "initialize") return null;
        return {
          identity: {
            runtimeId: "daemon-with-learning-center-only",
            mode: "daemon",
            profile: "default",
            startedAt: "2026-07-27T00:00:00.000Z",
            version: "0.7.77",
          },
          capabilities: { learningCenter: { version: 1 } },
        };
      },
      subscribe() {
        return { close() {} };
      },
    };

    await expect(
      connectKodaXRuntime({
        transport,
        requirements: { skillLearningLoop: 1 },
      }),
    ).rejects.toThrow(/does not support.*skillLearningLoop/i);
  });

  it("keeps managed prompt-cache affinity stable after Runtime reconnect without crossing Sessions", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const sessionsDir = path.join(tempRoot, "affinity-sessions");
    const capturedOptions: KodaXOptions[] = [];
    codingMock.runManagedTask.mockImplementation(
      async (options: KodaXOptions) => {
        capturedOptions.push(options);
        return {
          success: true,
          lastText: "done",
          messages: [],
          sessionId: options.session?.id,
        };
      },
    );

    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: "mock-provider",
    });
    const firstSession = await runtime.sessions.create({
      title: "Affinity Resume A",
    });
    const secondSession = await runtime.sessions.create({
      title: "Affinity Resume B",
    });
    await (
      await runtime.runs.start({
        sessionId: firstSession.id,
        prompt: "first",
        mode: "managed_task",
      })
    ).result;
    await (
      await runtime.runs.start({
        sessionId: secondSession.id,
        prompt: "second",
        mode: "managed_task",
      })
    ).result;
    await runtime.close();

    const recreated = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: "mock-provider",
    });
    await (
      await recreated.runs.start({
        sessionId: firstSession.id,
        prompt: "resumed",
        mode: "managed_task",
      })
    ).result;
    await recreated.close();

    const affinityKeys = capturedOptions.map((options) =>
      derivePromptCacheAffinityKey({
        logicalSessionId:
          options.context?.contextIdentitySessionId ?? options.session?.id,
        ...(options.context?.currentAgentId !== undefined
          ? { agentId: options.context.currentAgentId }
          : {}),
      }),
    );
    expect(capturedOptions.map((options) => options.session?.id)).toEqual([
      firstSession.id,
      secondSession.id,
      firstSession.id,
    ]);
    expect(affinityKeys[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(affinityKeys[2]).toBe(affinityKeys[0]);
    expect(affinityKeys[1]).not.toBe(affinityKeys[0]);
  });

  it("retains the latest managed_task context budget and cache diagnostics", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Managed Diagnostics Test",
    });

    codingMock.runManagedTask.mockImplementation(
      async (options: KodaXOptions) => {
        options.events?.onContextBudgetSnapshot?.({
          sessionId: session.id,
          turnId: "turn-managed-diagnostics",
          profile: "report_only",
          contextWindow: 32_000,
          smallWindow: true,
          pressure: "low",
          tokenBreakdown: {
            systemPrompt: 10,
            toolSchemas: 20,
            skillCatalog: 0,
            mcpCatalog: 0,
            transcript: 30,
            pendingInput: 5,
            recentToolResults: 0,
            reservedResponse: 1_000,
            total: 1_065,
          },
          usedTokens: 1_065,
          availableTokens: 30_935,
          usedRatio: 1_065 / 32_000,
          toolSchemaRatio: 20 / 32_000,
          recommendations: [],
          createdAt: "2026-07-26T00:00:00.000Z",
        });
        options.events?.onPromptCacheDiagnostics?.({
          phase: "response",
          transport: "stream",
          requestId: "managed-cache-zero",
          requestedAt: "2026-07-26T00:00:00.000Z",
          completedAt: "2026-07-26T00:00:01.000Z",
          provider: "mock-provider",
          model: "mock-model",
          wireModel: "wire-model",
          attempt: 1,
          systemPromptHash: "a".repeat(64),
          toolSchemaHash: "b".repeat(64),
          messagePrefixHash: "c".repeat(64),
          messagePrefixCount: 2,
          requestMessagesHash: "d".repeat(64),
          requestEnvelopeHash: "e".repeat(64),
          messageCount: 3,
          toolCount: 4,
          cachedReadTokens: 0,
        });
        options.events?.onPromptCacheDiagnostics?.({
          phase: "response",
          transport: "stream",
          requestId: "managed-cache-unreported",
          requestedAt: "2026-07-26T00:00:02.000Z",
          completedAt: "2026-07-26T00:00:03.000Z",
          provider: "mock-provider",
          model: "mock-model",
          wireModel: "wire-model",
          attempt: 1,
          systemPromptHash: "a".repeat(64),
          toolSchemaHash: "b".repeat(64),
          messagePrefixHash: "c".repeat(64),
          messagePrefixCount: 2,
          requestMessagesHash: "d".repeat(64),
          requestEnvelopeHash: "e".repeat(64),
          messageCount: 3,
          toolCount: 4,
        });
        return {
          success: true,
          lastText: "managed diagnostics complete",
          messages: [],
          sessionId: session.id,
        };
      },
    );

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "managed diagnostics",
      mode: "managed_task",
      options: { context: { contextDiagnostics: true } },
    });
    await handle.result;
    const latestBudget = await runtime.diagnostics.latestContextBudget({
      runId: handle.runId,
    });
    const latestCache = await runtime.diagnostics.latestProviderCacheDiagnostic(
      {
        runId: handle.runId,
      },
    );
    const cacheEvents = await runtime.events.replay({
      runId: handle.runId,
      type: "provider.cache.diagnostics",
    });

    expect(latestBudget).toMatchObject({
      turnId: "turn-managed-diagnostics",
      usedTokens: 1_065,
    });
    expect(latestBudget?.tokenBreakdown.total).toBe(latestBudget?.usedTokens);
    expect(latestCache).toMatchObject({
      contextId: session.id,
      contextKind: "root",
      requestId: "managed-cache-unreported",
    });
    expect(latestCache).not.toHaveProperty("cachedReadTokens");
    expect(cacheEvents).toHaveLength(2);
    expect(cacheEvents[0]?.payload).toMatchObject({
      requestId: "managed-cache-zero",
      cachedReadTokens: 0,
    });
    expect(cacheEvents[1]?.payload).toMatchObject({
      requestId: "managed-cache-unreported",
    });
    expect(cacheEvents[1]?.payload).not.toHaveProperty("cachedReadTokens");

    await runtime.close();

    const reconnectedRuntime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    await expect(
      reconnectedRuntime.diagnostics.latestProviderCacheDiagnostic({
        sessionId: session.id,
      }),
    ).resolves.toMatchObject({
      contextId: session.id,
      contextKind: "root",
      requestId: "managed-cache-unreported",
    });
    const reconnectedLatest =
      await reconnectedRuntime.diagnostics.latestProviderCacheDiagnostic({
        sessionId: session.id,
      });
    expect(reconnectedLatest).not.toHaveProperty("cachedReadTokens");
    await reconnectedRuntime.close();
  });

  it("reports failed run status when the coding layer rejects", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({ title: "Failure Test" });

    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession =>
        fakeRunningSession(
          options,
          Promise.reject(new Error("provider exploded")),
        ),
    );

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "fail",
    });
    const result = await handle.result;
    const status = await runtime.runs.get(handle.runId);
    const failedEvents = await runtime.events.replay({
      runId: handle.runId,
      type: "run.failed",
    });

    expect(result.phase).toBe("failed");
    expect(result.error?.message).toBe("provider exploded");
    expect(status).toMatchObject({
      phase: "failed",
      error: "provider exploded",
    });
    expect(failedEvents).toHaveLength(1);

    await runtime.close();
  });

  it("preserves a managed-task blocked reason as a structured terminal fact", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Blocked Task Test",
    });
    codingMock.runManagedTask.mockResolvedValue({
      success: false,
      lastText: "I need the target API version before continuing.",
      signal: "BLOCKED",
      signalReason: "Choose the target API version.",
      messages: [],
      sessionId: session.id,
    } satisfies KodaXResult);

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "Update the API integration.",
      mode: "managed_task",
    });
    const result = await handle.result;
    const status = await runtime.runs.get(handle.runId);
    const failedEvents = await runtime.events.replay({
      runId: handle.runId,
      type: "run.failed",
    });

    expect(result).toMatchObject({
      phase: "failed",
      terminal: {
        kind: "failed",
        code: "blocked",
        message: "Choose the target API version.",
      },
      result: {
        signal: "BLOCKED",
        signalReason: "Choose the target API version.",
      },
    });
    expect(status).toMatchObject({
      phase: "failed",
      terminal: {
        kind: "failed",
        code: "blocked",
        message: "Choose the target API version.",
      },
    });
    expect(failedEvents.at(-1)?.payload).toMatchObject({
      terminal: {
        code: "blocked",
        message: "Choose the target API version.",
      },
    });

    const runId = handle.runId;
    await runtime.close();
    const restoredRuntime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    await expect(restoredRuntime.runs.await(runId)).resolves.toMatchObject({
      phase: "failed",
      terminal: {
        code: "blocked",
        message: "Choose the target API version.",
      },
    });
    await restoredRuntime.close();
  }, 60_000);

  it("does not emit a blocked terminal for a successful managed task with a stale signal", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Successful Task Test",
    });
    codingMock.runManagedTask.mockResolvedValue({
      success: true,
      lastText: "The requested analysis is complete.",
      signal: "BLOCKED",
      signalReason: "Stale verifier metadata.",
      messages: [],
      sessionId: session.id,
    } satisfies KodaXResult);

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "Analyze the integration boundary.",
      mode: "managed_task",
    });
    const result = await handle.result;
    const failedEvents = await runtime.events.replay({
      runId: handle.runId,
      type: "run.failed",
    });

    expect(result).toMatchObject({
      phase: "completed",
      terminal: {
        kind: "completed",
        code: "completed",
      },
    });
    expect(failedEvents).toHaveLength(0);
    await runtime.close();
  }, 60_000);

  it("applies permissionMode policy and skips bridge meta-tool prompts", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Permission Policy Test",
    });
    const decisions = new Map<string, boolean | string>();
    const requestedTools: string[] = [];
    const toolByPrompt: Readonly<
      Record<
        string,
        { readonly name: string; readonly input: Record<string, unknown> }
      >
    > = {
      "accept-edit": {
        name: "edit",
        input: { path: "file.ts", old_string: "a", new_string: "b" },
      },
      "runtime-write": {
        name: "write",
        input: { path: "runtime.txt", content: "runtime" },
      },
      "client-write": {
        name: "write",
        input: { path: "client.txt", content: "client" },
      },
      "client-skill": {
        name: "skill",
        input: { skill: "known-issues-tracker" },
      },
      "protected-write": {
        name: "write",
        input: { path: ".kodax/config.json", content: "{}" },
      },
      "accept-bash": { name: "bash", input: { command: "npm test" } },
      "plan-edit": {
        name: "edit",
        input: { path: "file.ts", old_string: "a", new_string: "b" },
      },
      "plan-skill": {
        name: "skill",
        input: { skill: "known-issues-tracker" },
      },
      bridge: {
        name: "tool_call",
        input: { name: "edit", arguments: { path: "file.ts" } },
      },
    };
    runtime.events.subscribe({ type: "permission.requested" }, (event) => {
      const request = event.payload as {
        readonly id?: unknown;
        readonly toolName?: unknown;
      };
      if (typeof request.toolName === "string")
        requestedTools.push(request.toolName);
      if (typeof request.id === "string") {
        void runtime.permissions.respond(request.id, { type: "allow_once" });
      }
    });
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions, prompt: string): RunningSession => {
        const tool = toolByPrompt[prompt];
        if (!tool)
          throw new Error(`missing permission test tool for ${prompt}`);
        const result = Promise.resolve(
          options.events?.beforeToolExecute?.(tool.name, tool.input, {
            sessionId: session.id,
            toolId: `tool-${prompt}`,
          }),
        ).then((decision) => {
          if (decision === undefined)
            throw new Error("missing runtime permission hook");
          decisions.set(prompt, decision);
          return {
            success: true,
            lastText: String(decision),
            messages: [],
            sessionId: session.id,
          } satisfies KodaXResult;
        });
        return fakeRunningSession(options, result);
      },
    );

    await runtime.sessions.updateSettings(session.id, {
      permissionMode: "accept-edits",
      executionCwd: path.join(process.cwd(), "permission-policy-project"),
    });
    await (
      await runtime.runs.start({ sessionId: session.id, prompt: "accept-edit" })
    ).result;
    await (
      await runtime.runs.start({
        sessionId: session.id,
        prompt: "runtime-write",
      })
    ).result;
    await (
      await runtime.runs.start({
        sessionId: session.id,
        prompt: "client-write",
        permissionBroker: "client",
      })
    ).result;
    await (
      await runtime.runs.start({
        sessionId: session.id,
        prompt: "client-skill",
        permissionBroker: "client",
      })
    ).result;
    await (
      await runtime.runs.start({
        sessionId: session.id,
        prompt: "protected-write",
        permissionBroker: "client",
      })
    ).result;
    await (
      await runtime.runs.start({
        sessionId: session.id,
        prompt: "accept-bash",
        permissionBroker: "client",
      })
    ).result;
    await (
      await runtime.runs.start({ sessionId: session.id, prompt: "bridge" })
    ).result;
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: "plan",
    });
    await (
      await runtime.runs.start({ sessionId: session.id, prompt: "plan-edit" })
    ).result;
    await (
      await runtime.runs.start({ sessionId: session.id, prompt: "plan-skill" })
    ).result;

    expect(decisions.get("accept-edit")).toBe(true);
    expect(decisions.get("runtime-write")).toBe(true);
    expect(decisions.get("client-write")).toBe(true);
    expect(decisions.get("client-skill")).toBe(true);
    expect(decisions.get("protected-write")).toBe(true);
    expect(decisions.get("accept-bash")).toBe(true);
    expect(decisions.get("bridge")).toBe(true);
    expect(decisions.get("plan-edit")).toContain("[Blocked]");
    expect(decisions.get("plan-skill")).toBe(true);
    expect(requestedTools).toEqual(["write", "bash"]);
    expect(await runtime.permissions.listPending()).toEqual([]);
    await runtime.close();
  });

  it("loads a Skill in Plan mode without executing its inline dynamic command", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const projectRoot = path.join(tempRoot, "plan-skill-project");
    const skillRoot = path.join(projectRoot, ".kodax", "skills", "plan-safe-skill");
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(
      path.join(skillRoot, "SKILL.md"),
      [
        "---",
        "name: plan-safe-skill",
        "description: Plan-safe Skill fixture",
        "---",
        "",
        "Static instructions remain available.",
        "",
        "Result: !`git branch -D plan-dynamic-victim`",
        "",
      ].join("\n"),
      "utf8",
    );
    execFileSync("git", ["init"], {
      cwd: projectRoot,
      stdio: "ignore",
      windowsHide: true,
    });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=KodaX Test",
        "-c",
        "user.email=kodax-test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "test fixture",
      ],
      { cwd: projectRoot, stdio: "ignore", windowsHide: true },
    );
    execFileSync("git", ["branch", "plan-dynamic-victim"], {
      cwd: projectRoot,
      stdio: "ignore",
      windowsHide: true,
    });

    const skillRegistry = new SkillRegistry(projectRoot, {
      projectPaths: [path.join(projectRoot, ".kodax", "skills")],
      userPaths: [],
      pluginPaths: [],
      builtinPath: path.join(projectRoot, "builtin-skills"),
    });
    await skillRegistry.discover();

    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Plan Skill Dynamic Context Test",
    });
    let expandedSkill = "";
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        const result = Promise.resolve(
          options.events?.beforeToolExecute?.(
            "skill",
            { skill: "plan-safe-skill" },
            { sessionId: session.id, toolId: "tool-plan-safe-skill" },
          ),
        ).then(async (decision) => {
          expect(decision).toBe(true);
          expandedSkill = await toolSkill(
            { skill: "plan-safe-skill" },
            {
              backups: new Map(),
              executionCwd: projectRoot,
              gitRoot: projectRoot,
              skillRegistry,
              skillDynamicContext: options.skillDynamicContext,
            },
          );
          return {
            success: true,
            lastText: expandedSkill,
            messages: [],
            sessionId: session.id,
          } satisfies KodaXResult;
        });
        return fakeRunningSession(options, result);
      },
    );

    await runtime.sessions.updateSettings(session.id, {
      permissionMode: "plan",
      executionCwd: projectRoot,
    });
    await (
      await runtime.runs.start({
        sessionId: session.id,
        prompt: "Load the plan-safe Skill.",
        permissionBroker: "client",
      })
    ).result;

    expect(expandedSkill).toContain("Static instructions remain available.");
    expect(expandedSkill).toContain("[Error: Dynamic context disabled by host.");
    expect(
      execFileSync("git", ["branch", "--list", "plan-dynamic-victim"], {
        cwd: projectRoot,
        encoding: "utf8",
        windowsHide: true,
      }).trim(),
    ).toBe("plan-dynamic-victim");
    await runtime.close();
  });

  it("rechecks live permission mode before a mediated Skill dynamic command", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const projectRoot = path.join(tempRoot, "live-mode-skill-project");
    const skillRoot = path.join(projectRoot, ".kodax", "skills", "live-mode-skill");
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(
      path.join(skillRoot, "SKILL.md"),
      [
        "---",
        "name: live-mode-skill",
        "description: Live permission mode Skill fixture",
        "---",
        "",
        "Static live-mode instructions.",
        "",
        "Result: !`git branch -D live-dynamic-victim`",
        "",
      ].join("\n"),
      "utf8",
    );
    const skillRegistry = new SkillRegistry(projectRoot, {
      projectPaths: [path.join(projectRoot, ".kodax", "skills")],
      userPaths: [],
      pluginPaths: [],
      builtinPath: path.join(projectRoot, "builtin-skills"),
    });
    await skillRegistry.discover();

    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const capturedOptions = new Map<string, KodaXOptions>();
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        const sessionId = options.session?.id;
        if (sessionId) capturedOptions.set(sessionId, options);
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );
    const hostExecute = vi.fn(
      async (command: string): Promise<string> => `HOST:${command}`,
    );
    const invokeSkill = async (
      options: KodaXOptions,
      sessionId: string,
      toolId: string,
    ): Promise<string> => {
      await expect(
        options.events?.beforeToolExecute?.(
          "skill",
          { skill: "live-mode-skill" },
          { sessionId, toolId },
        ),
      ).resolves.toBe(true);
      return toolSkill(
        { skill: "live-mode-skill" },
        {
          backups: new Map(),
          executionCwd: projectRoot,
          gitRoot: projectRoot,
          skillRegistry,
          skillDynamicContext: options.skillDynamicContext,
        },
      );
    };

    const editFirst = await runtime.sessions.create({
      title: "Live Skill Edit First",
    });
    await runtime.sessions.updateSettings(editFirst.id, {
      permissionMode: "accept-edits",
      executionCwd: projectRoot,
    });
    const editFirstRun = await runtime.runs.start({
      sessionId: editFirst.id,
      prompt: "wait",
      options: { skillDynamicContext: { execute: hostExecute } },
    });
    const editFirstOptions = capturedOptions.get(editFirst.id);
    if (!editFirstOptions) throw new Error("expected edit-first run options");

    await runtime.sessions.updateSettings(editFirst.id, {
      permissionMode: "plan",
    });
    const blockedAfterPlanSwitch = await invokeSkill(
      editFirstOptions,
      editFirst.id,
      "live-skill-plan",
    );
    expect(blockedAfterPlanSwitch).toContain(
      "[Error: Dynamic context disabled by host.",
    );
    expect(hostExecute).not.toHaveBeenCalled();

    await runtime.sessions.updateSettings(editFirst.id, {
      permissionMode: "accept-edits",
    });
    const restoredAfterEditSwitch = await invokeSkill(
      editFirstOptions,
      editFirst.id,
      "live-skill-edit",
    );
    expect(restoredAfterEditSwitch).toContain(
      "HOST:git branch -D live-dynamic-victim",
    );
    expect(hostExecute).toHaveBeenCalledTimes(1);
    await runtime.runs.abort(editFirstRun.runId);

    const planFirst = await runtime.sessions.create({
      title: "Live Skill Plan First",
    });
    await runtime.sessions.updateSettings(planFirst.id, {
      permissionMode: "plan",
      executionCwd: projectRoot,
    });
    const planFirstRun = await runtime.runs.start({
      sessionId: planFirst.id,
      prompt: "wait",
      options: { skillDynamicContext: { execute: hostExecute } },
    });
    const planFirstOptions = capturedOptions.get(planFirst.id);
    if (!planFirstOptions) throw new Error("expected plan-first run options");

    await runtime.sessions.updateSettings(planFirst.id, {
      permissionMode: "accept-edits",
    });
    const restoredFromInitialPlan = await invokeSkill(
      planFirstOptions,
      planFirst.id,
      "initial-plan-to-edit",
    );
    expect(restoredFromInitialPlan).toContain(
      "HOST:git branch -D live-dynamic-victim",
    );
    expect(hostExecute).toHaveBeenCalledTimes(2);

    await runtime.runs.abort(planFirstRun.runId);
    await runtime.close();
  });

  it("keeps shared Runtime preflight readable while Session persistence is active", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const sessionsDir = path.join(tempRoot, "sessions");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
      defaultProvider: "mock-provider",
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({
      title: "Shared preflight during persistence",
    });
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession =>
        fakeRunningSession(options, new Promise<KodaXResult>(() => undefined)),
    );
    const run = await runtime.runs.start({
      sessionId: session.id,
      prompt: "keep the run active",
    });
    const lockKey = createHash("sha256").update(session.id, "utf8").digest("hex");
    const lockDir = path.join(sessionsDir, ".write-locks");
    const lockPath = path.join(lockDir, `${lockKey}.lock`);
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(lockPath, `${process.pid} active-test-lock\n`, "utf8");

    try {
      await expect(runtime.status.preflight()).resolves.toMatchObject({
        activeRuns: [expect.objectContaining({ runId: run.runId })],
      });
    } finally {
      await fs.rm(lockPath, { force: true });
      await runtime.close();
    }
  });

  it("runs explicit auto engines inside Runtime and brokers only guardrail escalation", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
      defaultModel: "mock-model",
      sharedDaemonHost: true,
      permissionTimeoutMs: 1_000,
    });
    const gitRoot = path.join(tempRoot, "project");
    const executionCwd = path.join(gitRoot, "packages", "app");
    const callerObservation = {
      version: 1 as const,
      state: "applied" as const,
      backend: "windows-restricted-user" as const,
      policyId: "kodax-workspace-shell-v1" as const,
    };
    const callerShellSandboxPrepare = vi.fn(async (
      request: Parameters<KodaXShellSandbox["prepare"]>[0],
    ) => {
      request.reportObservation?.(callerObservation);
      return {
        executable: process.execPath,
        args: ["--version"],
        env: process.env,
        cleanup: async () => callerObservation,
      };
    });
    const session = await runtime.sessions.create({
      title: "Daemon Auto Mode",
    });
    const fakeGuardrail = {
      kind: "tool",
      name: "auto-mode",
      beforeTool: async () => ({ action: "allow" as const }),
      getEngine: () => "llm" as const,
      getStats: () => ({ engine: "llm" as const, denials: {}, breaker: {} }),
      setEngine: () => undefined,
      getEngineForTest: () => "llm" as const,
      getStatsForTest: () => ({
        engine: "llm" as const,
        denials: {},
        breaker: {},
      }),
      setProviderForTest: () => undefined,
    } as unknown as AutoModeToolGuardrail;
    replMock.bootstrapAutoMode.mockResolvedValue({
      getGuardrail: () => fakeGuardrail,
      rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
    });
    let runOptions: KodaXOptions | undefined;
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        runOptions = options;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: "auto",
      autoModeEngine: "llm",
      autoModeClassifierModel: "mock-provider:classifier-model",
      autoModeTimeoutMs: 20_000,
      executionCwd,
    });

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "inspect Python",
      permissionBroker: "client",
      options: {
        context: {
          gitRoot,
          executionCwd,
          shellSandbox: { prepare: callerShellSandboxPrepare },
        },
      },
    });
    await flushMicrotasks();

    const bootstrap = replMock.bootstrapAutoMode.mock.calls[0]?.[0] as
      AutoModeBootstrapDeps | undefined;
    expect(bootstrap).toMatchObject({ projectRoot: gitRoot, executionCwd });
    expect(bootstrap?.autoModeSettings).toMatchObject({
      engine: "llm",
      classifierModel: "mock-provider:classifier-model",
      timeoutMs: 20_000,
    });
    if (!runOptions) throw new Error("expected Runtime run options");
    const runtimeGuardrail = runtimeAutoGuardrail(runOptions);
    expect(runtimeGuardrail).not.toBe(fakeGuardrail);
    const sandboxObservations = vi.fn();
    const callerInvocation = await runOptions.context?.shellSandbox?.prepare({
      toolCallId: "bash_not_admitted",
      toolInput: { command: "echo outside" },
      command: "echo outside",
      cwd: executionCwd,
      env: process.env,
      reportObservation: sandboxObservations,
    });
    expect(callerShellSandboxPrepare).toHaveBeenCalledOnce();
    expect(sandboxObservations).not.toHaveBeenCalled();
    await expect(callerInvocation?.cleanup()).resolves.toEqual(callerObservation);

    const command =
      'python -c "import sys; print(sys.executable); print(sys.version)"';
    await authorizeRuntimeAutoCall(runOptions, {
      id: "bash_python",
      name: "bash",
      input: { command, description: "Check Python environment" },
    });
    await expect(
      runOptions.events?.beforeToolExecute?.(
        "bash",
        { command, description: "Check Python environment" },
        { sessionId: session.id, toolId: "bash_python" },
      ),
    ).resolves.toBe(true);
    await expect(
      runtime.permissions.listPending({ runId: handle.runId }),
    ).resolves.toEqual([]);

    const escalation = bootstrap?.askUser(
      {
        id: "bash_python",
        name: "bash",
        input: {
          command: `${command} # Authorization: Bearer private-value`,
          description: "Check Python environment",
          apiKey: "private-value",
        },
      },
      "Auto[LLM] classifier requested user confirmation.",
      [{ kind: "outside_project", path: "C:\\outside\\input.pdf" }],
      {
        source: "classifier_confirm",
        classifierAttempts: [
          {
            attempt: 1,
            outcome: "confirm",
            observedProtocol: "structured_v2",
            outputWarnings: ["missing_hazard", "missing_reason"],
            diagnostics: {
              provider: "mock-provider",
              model: "classifier-model",
              timeoutMs: 20_000,
              elapsedMs: 20_002,
              systemBytes: 64,
              messageBytes: 128,
              promptBytes: 192,
              retryCount: 0,
              retryWaitMs: 0,
              stopReason: "end_turn",
              responseBytes: 74,
              textBlockCount: 1,
              terminalPhase: "completed",
            },
          },
        ],
      },
    );
    await flushMicrotasks();
    const [pending] = await runtime.permissions.listPending({
      runId: handle.runId,
    });
    expect(pending).toMatchObject({
      toolName: "bash",
      reason:
        "Auto[LLM] classifier requested user confirmation.",
      risk: "medium",
      executionCwd,
      autoModeDiagnostics: {
        source: "classifier_confirm",
        classifierAttempts: [
          expect.objectContaining({
            attempt: 1,
            outcome: "confirm",
            observedProtocol: "structured_v2",
            outputWarnings: ["missing_hazard", "missing_reason"],
            diagnostics: expect.objectContaining({
              promptBytes: 192,
              stopReason: "end_turn",
              responseBytes: 74,
              textBlockCount: 1,
              terminalPhase: "completed",
            }),
          }),
        ],
      },
    });
    expect(pending?.autoModeDiagnostics?.classifierFailureKind).toBeUndefined();
    expect(Date.parse(pending?.expiresAt ?? "")).toBe(
      Date.parse(pending?.createdAt ?? "") + 1_000,
    );
    expect(JSON.parse(pending?.inputPreview ?? "{}")).toMatchObject({
      command: `${command} # Authorization: [REDACTED]`,
      description: "Check Python environment",
      __truncated: true,
    });
    expect(pending?.inputPreview).not.toContain("private-value");
    if (!pending) throw new Error("expected guardrail escalation permission");
    await runtime.permissions.respond(
      pending.id,
      { type: "allow_once" },
      { runId: handle.runId },
    );
    await expect(escalation).resolves.toBe("allow");

    const ordinaryRejection = bootstrap?.askUser(
      {
        id: "bash_rejected",
        name: "bash",
        input: { command: "git push origin main" },
      },
      "Push requires confirmation.",
    );
    await flushMicrotasks();
    const [rejectedPending] = await runtime.permissions.listPending({
      runId: handle.runId,
    });
    if (!rejectedPending) throw new Error("expected rejected guardrail permission");
    await runtime.permissions.respond(
      rejectedPending.id,
      {
        type: "reject",
        reason: "The earlier discussion timed out; do not run this.",
      },
      { runId: handle.runId },
    );
    await expect(ordinaryRejection).resolves.toBe("block");

    const timeoutEscalation = bootstrap?.askUser(
      {
        id: "bash_timeout",
        name: "bash",
        input: { command: "git push --force origin main" },
      },
      "Force push requires confirmation.",
    );
    await expect(timeoutEscalation).resolves.toBe("timeout");
    await expect(
      runtime.permissions.listPending({ runId: handle.runId }),
    ).resolves.toEqual([]);

    await runtime.runs.abort(handle.runId);
    await runtime.close();
  }, 60_000);

  it("fails Auto LLM before provider or permission work when no classifier model exists", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({
      title: "Missing Auto Model",
    });
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: "auto",
      autoModeEngine: "llm",
    });

    await expect(
      runtime.runs.start({
        sessionId: session.id,
        prompt: "inspect the workspace",
      }),
    ).rejects.toMatchObject({
      code: "auto_mode_classifier_model_required",
      recoverable: true,
    });
    expect(replMock.bootstrapAutoMode).not.toHaveBeenCalled();
    expect(codingMock.startKodaX).not.toHaveBeenCalled();
    await expect(
      runtime.permissions.listPending({ sessionId: session.id }),
    ).resolves.toEqual([]);

    await runtime.close();
  });

  it("resolves a selected provider default before Auto LLM model preflight", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({
      title: "Provider Default Auto Model",
    });
    const fakeGuardrail = {
      kind: "tool",
      name: "auto-mode",
      beforeTool: async () => ({ action: "allow" as const }),
      getEngine: () => "llm" as const,
      getStats: () => ({ engine: "llm" as const, denials: {}, breaker: {} }),
      setEngine: () => undefined,
      getEngineForTest: () => "llm" as const,
      getStatsForTest: () => ({
        engine: "llm" as const,
        denials: {},
        breaker: {},
      }),
      setProviderForTest: () => undefined,
    } as unknown as AutoModeToolGuardrail;
    replMock.bootstrapAutoMode.mockResolvedValue({
      getGuardrail: () => fakeGuardrail,
      rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
    });
    let runOptions: KodaXOptions | undefined;
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        runOptions = options;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: "auto",
      autoModeEngine: "llm",
      executionCwd: tempRoot,
    });

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "inspect the workspace",
      options: { provider: "zai-coding" },
    });
    await flushMicrotasks();
    if (!runOptions) throw new Error("expected Runtime run options");
    const providerDefault =
      resolveProviderModelDescriptors("zai-coding")[0]?.id;
    expect(providerDefault).toBe("glm-5.2");
    expect(runOptions.provider).toBe("zai-coding");
    expect(runOptions.modelOverride).toBe(providerDefault);

    await runtime.runs.abort(handle.runId);
    await runtime.close();
  }, 60_000);

  it("treats an omitted Auto engine as the default LLM engine during model preflight", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({
      title: "Implicit Auto LLM Model",
    });
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: "auto",
    });

    await expect(
      runtime.runs.start({
        sessionId: session.id,
        prompt: "inspect the workspace",
      }),
    ).rejects.toMatchObject({
      code: "auto_mode_classifier_model_required",
      recoverable: true,
    });
    expect(replMock.bootstrapAutoMode).not.toHaveBeenCalled();
    expect(codingMock.startKodaX).not.toHaveBeenCalled();

    await runtime.close();
  });

  it("owns the default LLM guardrail when Auto engine is omitted", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
      defaultModel: "mock-model",
      sharedDaemonHost: false,
    });
    const session = await runtime.sessions.create({
      title: "Implicit Auto LLM Guardrail",
    });
    const fakeGuardrail = {
      kind: "tool",
      name: "auto-mode",
      beforeTool: async () => ({ action: "allow" as const }),
      getEngine: () => "llm" as const,
      getStats: () => ({ engine: "llm" as const, denials: {}, breaker: {} }),
      setEngine: () => undefined,
      getEngineForTest: () => "llm" as const,
      getStatsForTest: () => ({
        engine: "llm" as const,
        denials: {},
        breaker: {},
      }),
      setProviderForTest: () => undefined,
    } as unknown as AutoModeToolGuardrail;
    replMock.bootstrapAutoMode.mockResolvedValue({
      getGuardrail: () => fakeGuardrail,
      rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
    });
    let runOptions: KodaXOptions | undefined;
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        runOptions = options;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: "auto",
      executionCwd: tempRoot,
    });

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "verify",
    });
    await flushMicrotasks();
    if (!runOptions) throw new Error("expected Runtime run options");
    expect(replMock.bootstrapAutoMode).toHaveBeenCalledWith(
      expect.objectContaining({
        autoModeSettings: expect.objectContaining({ engine: "llm" }),
      }),
    );
    const call = {
      id: "bash_implicit_llm",
      name: "bash",
      input: { command: "node --version" },
    };
    await authorizeRuntimeAutoCall(runOptions, call);
    await expect(
      runOptions.events?.beforeToolExecute?.(call.name, call.input, {
        sessionId: session.id,
        toolId: call.id,
      }),
    ).resolves.toBe(true);
    await expect(
      runtime.permissions.listPending({ runId: handle.runId }),
    ).resolves.toEqual([]);

    await runtime.runs.abort(handle.runId);
    await runtime.close();
  }, 60_000);

  it("rejects blank and malformed Runtime Auto LLM classifier-model settings", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
    });
    const session = await runtime.sessions.create({
      title: "Invalid Auto Model",
    });

    await expect(
      runtime.sessions.updateSettings(session.id, {
        autoModeClassifierModel: "   ",
      }),
    ).rejects.toThrow(/autoModeClassifierModel.*non-empty/i);
    await expect(
      runtime.sessions.updateSettings(session.id, {
        autoModeClassifierModel: "mock-provider:",
      }),
    ).rejects.toThrow(/autoModeClassifierModel.*model spec/i);

    await runtime.close();
  });

  it("blocks a live rules-to-LLM switch with no classifier model without brokering permission", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({
      title: "Live Auto Model Switch",
    });
    const fakeGuardrail = {
      kind: "tool",
      name: "auto-mode",
      beforeTool: async () => ({ action: "allow" as const }),
      getEngine: () => "rules" as const,
      getStats: () => ({ engine: "rules" as const, denials: {}, breaker: {} }),
      setEngine: () => undefined,
      getEngineForTest: () => "rules" as const,
      getStatsForTest: () => ({
        engine: "rules" as const,
        denials: {},
        breaker: {},
      }),
      setProviderForTest: () => undefined,
    } as unknown as AutoModeToolGuardrail;
    replMock.bootstrapAutoMode.mockResolvedValue({
      getGuardrail: () => fakeGuardrail,
      rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
    });
    let runOptions: KodaXOptions | undefined;
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        runOptions = options;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: "auto",
      autoModeEngine: "rules",
      executionCwd: tempRoot,
    });
    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "verify",
    });
    await flushMicrotasks();
    if (!runOptions) throw new Error("expected Runtime run options");

    await runtime.sessions.updateSettings(session.id, {
      autoModeEngine: "llm",
    });
    const verdict = await runtimeAutoGuardrail(runOptions).beforeTool?.(
      { id: "bash_1", name: "bash", input: { command: "npm test" } },
      {
        agent: createAgent({
          name: "runtime-auto-test",
          instructions: "Test runtime Auto LLM validation.",
        }),
        messages: [],
      },
    );
    expect(verdict).toMatchObject({
      action: "block",
      reason: expect.stringMatching(/classifier model/i),
    });
    await expect(
      runtime.permissions.listPending({ runId: handle.runId }),
    ).resolves.toEqual([]);

    await runtime.runs.abort(handle.runId);
    await runtime.close();
  }, 60_000);

  it("blocks Runtime auto tool hooks that lack a matching guardrail decision", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
      defaultModel: "mock-model",
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({
      title: "Auto Decision Receipt",
    });
    const fakeGuardrail = {
      kind: "tool",
      name: "auto-mode",
      beforeTool: async () => ({ action: "allow" as const }),
      getEngine: () => "llm" as const,
      getStats: () => ({ engine: "llm" as const, denials: {}, breaker: {} }),
      setEngine: () => undefined,
      getEngineForTest: () => "llm" as const,
      getStatsForTest: () => ({
        engine: "llm" as const,
        denials: {},
        breaker: {},
      }),
      setProviderForTest: () => undefined,
    } as unknown as AutoModeToolGuardrail;
    replMock.bootstrapAutoMode.mockResolvedValue({
      getGuardrail: () => fakeGuardrail,
      rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
    });
    let runOptions: KodaXOptions | undefined;
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        runOptions = options;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: "auto",
      autoModeEngine: "llm",
      executionCwd: tempRoot,
      autoModeSpeculativeWindowMs: 1_200,
    });

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "verify",
    });
    await flushMicrotasks();
    if (!runOptions) throw new Error("expected Runtime run options");
    await expect(
      runOptions.events?.beforeToolExecute?.(
        "bash",
        { command: "npm test" },
        { sessionId: session.id, toolId: "bash_test" },
      ),
    ).resolves.toContain("[Blocked]");
    await expect(
      runtime.permissions.listPending({ runId: handle.runId }),
    ).resolves.toEqual([]);

    await runtime.runs.abort(handle.runId);
    await runtime.close();
  }, 60_000);

  it("binds a tool_call guardrail decision to one exact concrete bridge execution", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
      defaultModel: "mock-model",
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({
      title: "Concrete Bridge Receipt",
    });
    const fakeGuardrail = {
      kind: "tool",
      name: "auto-mode",
      beforeTool: async () => ({ action: "allow" as const }),
      getEngine: () => "llm" as const,
      getStats: () => ({ engine: "llm" as const, denials: {}, breaker: {} }),
      setEngine: () => undefined,
      getEngineForTest: () => "llm" as const,
      getStatsForTest: () => ({
        engine: "llm" as const,
        denials: {},
        breaker: {},
      }),
      setProviderForTest: () => undefined,
    } as unknown as AutoModeToolGuardrail;
    replMock.bootstrapAutoMode.mockResolvedValue({
      getGuardrail: () => fakeGuardrail,
      rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
    });
    let runOptions: KodaXOptions | undefined;
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        runOptions = options;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: "auto",
      autoModeEngine: "llm",
      executionCwd: tempRoot,
    });

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "verify bridge",
    });
    await flushMicrotasks();
    if (!runOptions) throw new Error("expected Runtime run options");
    const outerCall: RunnerToolCall = {
      id: "bridge_1",
      name: "tool_call",
      input: {
        name: "bash",
        input: { command: "npm test", marker: undefined },
      },
    };
    await authorizeRuntimeAutoCall(runOptions, outerCall);
    await expect(
      runOptions.events?.beforeToolExecute?.(outerCall.name, outerCall.input, {
        sessionId: session.id,
        toolId: outerCall.id,
      }),
    ).resolves.toBe(true);
    await expect(
      runOptions.events?.beforeToolExecute?.(
        "bash",
        { command: "npm test" },
        { sessionId: session.id, toolId: "bridge_1:bash" },
      ),
    ).resolves.toContain("[Blocked]");
    await expect(
      runOptions.events?.beforeToolExecute?.(
        "bash",
        { command: "npm test", marker: undefined },
        { sessionId: session.id, toolId: "bridge_1:bash" },
      ),
    ).resolves.toBe(true);
    await expect(
      runOptions.events?.beforeToolExecute?.(
        "bash",
        { command: "npm test", marker: undefined },
        { sessionId: session.id, toolId: "bridge_1:bash" },
      ),
    ).resolves.toContain("[Blocked]");

    let accessorReads = 0;
    const accessorInput: Record<string, unknown> = { command: "npm test" };
    Object.defineProperty(accessorInput, "marker", {
      enumerable: true,
      get() {
        accessorReads += 1;
        return "dynamic";
      },
    });
    await authorizeRuntimeAutoCall(runOptions, {
      id: "bash_accessor",
      name: "bash",
      input: accessorInput,
    });
    await expect(
      runOptions.events?.beforeToolExecute?.("bash", accessorInput, {
        sessionId: session.id,
        toolId: "bash_accessor",
      }),
    ).resolves.toContain("[Blocked]");
    expect(accessorReads).toBe(0);

    const symbolInput: Record<string, unknown> = { command: "npm test" };
    Object.defineProperty(symbolInput, Symbol("marker"), {
      enumerable: true,
      value: "hidden",
    });
    await authorizeRuntimeAutoCall(runOptions, {
      id: "bash_symbol",
      name: "bash",
      input: symbolInput,
    });
    await expect(
      runOptions.events?.beforeToolExecute?.("bash", symbolInput, {
        sessionId: session.id,
        toolId: "bash_symbol",
      }),
    ).resolves.toContain("[Blocked]");
    await expect(
      runtime.permissions.listPending({ runId: handle.runId }),
    ).resolves.toEqual([]);

    await runtime.runs.abort(handle.runId);
    await runtime.close();
  }, 60_000);

  it("rechecks exact Runtime auto authorization after host permission hooks", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
      defaultModel: "mock-model",
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({ title: "Auto Host Hook" });
    const hostPermissionHook = vi.fn(
      async (_tool: string, toolInput: Record<string, unknown>) => {
        if (toolInput.command === "npm test --mutate") {
          toolInput.command = "npm publish";
        }
        return true;
      },
    );
    const fakeGuardrail = {
      kind: "tool",
      name: "auto-mode",
      beforeTool: async () => ({ action: "allow" as const }),
      getEngine: () => "llm" as const,
      getStats: () => ({ engine: "llm" as const, denials: {}, breaker: {} }),
      setEngine: () => undefined,
      getEngineForTest: () => "llm" as const,
      getStatsForTest: () => ({
        engine: "llm" as const,
        denials: {},
        breaker: {},
      }),
      setProviderForTest: () => undefined,
    } as unknown as AutoModeToolGuardrail;
    replMock.bootstrapAutoMode.mockResolvedValue({
      getGuardrail: () => fakeGuardrail,
      rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
    });
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        const result = (async (): Promise<KodaXResult> => {
          const stableCall: RunnerToolCall = {
            id: "bash_stable",
            name: "bash",
            input: { command: "npm test" },
          };
          await authorizeRuntimeAutoCall(options, stableCall);
          const stableDecision = await options.events?.beforeToolExecute?.(
            stableCall.name,
            stableCall.input,
            { sessionId: session.id, toolId: stableCall.id },
          );
          const mutatedCall: RunnerToolCall = {
            id: "bash_mutated",
            name: "bash",
            input: { command: "npm test --mutate" },
          };
          await authorizeRuntimeAutoCall(options, mutatedCall);
          const mutatedDecision = await options.events?.beforeToolExecute?.(
            mutatedCall.name,
            mutatedCall.input,
            { sessionId: session.id, toolId: mutatedCall.id },
          );
          return {
            success:
              stableDecision === true &&
              typeof mutatedDecision === "string" &&
              mutatedDecision.includes("[Blocked]"),
            lastText: String(mutatedDecision),
            messages: [],
            sessionId: session.id,
          };
        })();
        return fakeRunningSession(options, result);
      },
    );
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: "auto",
      autoModeEngine: "llm",
      executionCwd: tempRoot,
    });

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "verify",
      options: { events: { beforeToolExecute: hostPermissionHook } },
    });
    await expect(handle.result).resolves.toMatchObject({ phase: "completed" });

    expect(hostPermissionHook).toHaveBeenCalledTimes(2);
    await expect(
      runtime.events.replay({
        runId: handle.runId,
        type: "permission.requested",
      }),
    ).resolves.toEqual([]);
    await expect(
      runtime.permissions.listPending({ runId: handle.runId }),
    ).resolves.toEqual([]);
    await runtime.close();
  }, 60_000);

  it("derives Runtime auto path context from the Session when run options omit it", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const projectRoot = path.join(tempRoot, "session-project");
    await fs.mkdir(projectRoot, { recursive: true });
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
      defaultModel: "mock-model",
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({
      title: "Session Path Context",
      projectPath: projectRoot,
    });
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: "auto",
      autoModeEngine: "llm",
    });
    const fakeGuardrail = {
      kind: "tool",
      name: "auto-mode",
      beforeTool: async () => ({ action: "allow" as const }),
      getEngine: () => "llm" as const,
      getStats: () => ({ engine: "llm" as const, denials: {}, breaker: {} }),
      setEngine: () => undefined,
      getEngineForTest: () => "llm" as const,
      getStatsForTest: () => ({
        engine: "llm" as const,
        denials: {},
        breaker: {},
      }),
      setProviderForTest: () => undefined,
    } as unknown as AutoModeToolGuardrail;
    replMock.bootstrapAutoMode.mockResolvedValue({
      getGuardrail: () => fakeGuardrail,
      rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
    });
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession =>
        fakeRunningSession(
          options,
          Promise.resolve({
            success: true,
            lastText: "done",
            messages: [],
            sessionId: session.id,
          }),
        ),
    );

    await (
      await runtime.runs.start({ sessionId: session.id, prompt: "inspect" })
    ).result;

    expect(replMock.bootstrapAutoMode).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot,
        executionCwd: projectRoot,
      }),
    );
    await runtime.close();
  }, 60_000);

  it("executes the Runtime auto guardrail before the static permission hook", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
      defaultModel: "mock-model",
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({
      title: "Runner Auto Mode",
    });
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: "auto",
      autoModeEngine: "llm",
      executionCwd: tempRoot,
    });

    const order: string[] = [];
    const execute = vi.fn(async () => {
      order.push("execute");
      return { content: "ok" };
    });
    const fakeGuardrail = {
      kind: "tool",
      name: "auto-mode",
      beforeTool: vi.fn(async () => {
        order.push("guardrail");
        return { action: "allow" as const };
      }),
      getEngine: () => "llm" as const,
      getStats: () => ({ engine: "llm" as const, denials: {}, breaker: {} }),
      setEngine: () => undefined,
      getEngineForTest: () => "llm" as const,
      getStatsForTest: () => ({
        engine: "llm" as const,
        denials: {},
        breaker: {},
      }),
      setProviderForTest: () => undefined,
    } as unknown as AutoModeToolGuardrail;
    replMock.bootstrapAutoMode.mockResolvedValue({
      getGuardrail: () => fakeGuardrail,
      rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
    });
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        const bashTool: RunnableTool = {
          name: "bash",
          description: "Test bash tool",
          input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
          },
          execute,
        };
        const agent = createAgent({
          name: "runtime-auto-runner",
          instructions: "Run the requested command.",
          tools: [bashTool],
        });
        let turn = 0;
        const result = Runner.run(agent, "inspect", {
          guardrails: options.guardrails,
          llm: async (): Promise<RunnerLlmResult> => {
            turn += 1;
            return turn === 1
              ? {
                  text: "",
                  toolCalls: [
                    {
                      id: "bash_python",
                      name: "bash",
                      input: { command: "python --version" },
                    },
                  ],
                }
              : { text: "done", toolCalls: [] };
          },
          toolObserver: {
            beforeTool: async (call) => {
              order.push("permission");
              return options.events?.beforeToolExecute?.(
                call.name,
                call.input,
                { sessionId: session.id, toolId: call.id },
              );
            },
          },
        }).then((): KodaXResult => ({
          success: true,
          lastText: "done",
          messages: [],
          sessionId: session.id,
        }));
        return fakeRunningSession(options, result);
      },
    );

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "inspect",
    });
    await expect(handle.result).resolves.toMatchObject({ phase: "completed" });
    expect(fakeGuardrail.beforeTool).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(order).toEqual(["guardrail", "permission", "execute"]);
    await expect(
      runtime.permissions.listPending({ runId: handle.runId }),
    ).resolves.toEqual([]);
    await runtime.close();
  }, 60_000);

  it("reuses one Runtime auto guardrail until classifier configuration changes", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
      defaultModel: "mock-model",
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({
      title: "Persistent Auto Mode",
    });
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: "auto",
      autoModeEngine: "llm",
      executionCwd: tempRoot,
    });

    const fakeGuardrail = {
      kind: "tool",
      name: "auto-mode",
      beforeTool: async () => ({ action: "allow" as const }),
      getEngine: () => "rules" as const,
      getStats: () => ({ engine: "rules" as const, denials: {}, breaker: {} }),
      setEngine: () => undefined,
      getEngineForTest: () => "rules" as const,
      getStatsForTest: () => ({
        engine: "rules" as const,
        denials: {},
        breaker: {},
      }),
      setProviderForTest: () => undefined,
    } as unknown as AutoModeToolGuardrail;
    replMock.bootstrapAutoMode.mockImplementation(
      async (deps: AutoModeBootstrapDeps) => {
        queueMicrotask(() => deps.onEngineChange?.("rules"));
        return {
          getGuardrail: () => fakeGuardrail,
          rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
        };
      },
    );
    const guardrails: unknown[] = [];
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        guardrails.push(
          options.guardrails?.find(
            (guardrail) => guardrail.name === "auto-mode",
          ),
        );
        return fakeRunningSession(
          options,
          Promise.resolve({
            success: true,
            lastText: "done",
            messages: [],
            sessionId: session.id,
          }),
        );
      },
    );

    await (
      await runtime.runs.start({ sessionId: session.id, prompt: "turn one" })
    ).result;
    await (
      await runtime.runs.start({ sessionId: session.id, prompt: "turn two" })
    ).result;

    await runtime.sessions.updateSettings(session.id, {
      autoModeTimeoutMs: 18_000,
      autoModeSpeculativeWindowMs: 0,
    });
    await (
      await runtime.runs.start({ sessionId: session.id, prompt: "turn three" })
    ).result;

    expect(replMock.bootstrapAutoMode).toHaveBeenCalledTimes(3);
    expect(guardrails).toHaveLength(3);
    expect(guardrails[0]).not.toBe(guardrails[1]);
    expect(guardrails[2]).not.toBe(guardrails[1]);
    expect(guardrails[0]).not.toBe(fakeGuardrail);
    expect(
      replMock.bootstrapAutoMode.mock.calls[2]?.[0].autoModeSettings,
    ).toMatchObject({
      engine: "rules",
      timeoutMs: 18_000,
      speculativeWindowMs: 0,
    });
    await expect(
      runtime.sessions.getSettings(session.id),
    ).resolves.toMatchObject({
      autoModeEngine: "rules",
      autoModeSpeculativeWindowMs: 0,
    });
    await runtime.close();
  }, 60_000);

  it("releases the Session guardrail cache when a Session is deleted", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
      defaultModel: "mock-model",
      sharedDaemonHost: true,
    });
    const sessionId = "recreated-auto-session";
    const fakeGuardrail = {
      kind: "tool",
      name: "auto-mode",
      beforeTool: async () => ({ action: "allow" as const }),
      getEngine: () => "llm" as const,
      getStats: () => ({ engine: "llm" as const, denials: {}, breaker: {} }),
      setEngine: () => undefined,
      getEngineForTest: () => "llm" as const,
      getStatsForTest: () => ({
        engine: "llm" as const,
        denials: {},
        breaker: {},
      }),
      setProviderForTest: () => undefined,
    } as unknown as AutoModeToolGuardrail;
    replMock.bootstrapAutoMode.mockResolvedValue({
      getGuardrail: () => fakeGuardrail,
      rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
    });
    const runtimeGuardrails: AutoModeToolGuardrail[] = [];
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        runtimeGuardrails.push(runtimeAutoGuardrail(options));
        return fakeRunningSession(
          options,
          Promise.resolve({
            success: true,
            lastText: "done",
            messages: [],
            sessionId,
          }),
        );
      },
    );

    const configureSession = async (): Promise<void> => {
      await runtime.sessions.create({
        sessionId,
        title: "Recreated Auto Session",
      });
      await runtime.sessions.updateSettings(sessionId, {
        permissionMode: "auto",
        autoModeEngine: "llm",
        executionCwd: tempRoot,
      });
    };
    await configureSession();
    await (
      await runtime.runs.start({ sessionId, prompt: "first lifetime" })
    ).result;
    await runtime.sessions.delete(sessionId);
    await configureSession();
    await (
      await runtime.runs.start({ sessionId, prompt: "second lifetime" })
    ).result;

    expect(replMock.bootstrapAutoMode).toHaveBeenCalledTimes(2);
    expect(runtimeGuardrails).toHaveLength(2);
    expect(runtimeGuardrails[0]).not.toBe(runtimeGuardrails[1]);
    await runtime.close();
  }, 60_000);

  it("reports the shared auto guardrail engine when a queued turn starts after fallback", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
      defaultModel: "mock-model",
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({
      title: "Queued Auto Mode",
    });
    const firstCwd = path.join(tempRoot, "first-cwd");
    const secondCwd = path.join(tempRoot, "second-cwd");
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: "auto",
      autoModeEngine: "llm",
      executionCwd: firstCwd,
    });

    let notifyEngineChange: ((next: "llm" | "rules") => void) | undefined;
    let bootstrapCount = 0;
    replMock.bootstrapAutoMode.mockImplementation(
      async (deps: AutoModeBootstrapDeps) => {
        bootstrapCount += 1;
        let guardrailEngine = deps.autoModeSettings.engine;
        if (bootstrapCount === 1) {
          notifyEngineChange = (next) => {
            guardrailEngine = next;
            deps.onEngineChange?.(next);
          };
        }
        const fakeGuardrail = {
          kind: "tool",
          name: "auto-mode",
          beforeTool: async () => ({ action: "allow" as const }),
          getEngine: () => guardrailEngine,
          getStats: () => ({
            engine: guardrailEngine,
            denials: {},
            breaker: {},
          }),
          setEngine: (next: "llm" | "rules") => {
            guardrailEngine = next;
          },
          getEngineForTest: () => guardrailEngine,
          getStatsForTest: () => ({
            engine: guardrailEngine,
            denials: {},
            breaker: {},
          }),
          setProviderForTest: () => undefined,
        } as unknown as AutoModeToolGuardrail;
        return {
          getGuardrail: () => fakeGuardrail,
          rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
        };
      },
    );

    let releaseFirst: ((result: KodaXResult) => void) | undefined;
    let invocation = 0;
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        invocation += 1;
        const result =
          invocation === 1
            ? new Promise<KodaXResult>((resolve) => {
                releaseFirst = resolve;
              })
            : authorizeRuntimeAutoCall(options, {
                id: "queued-read",
                name: "read",
                input: { path: "README.md" },
              }).then(() => ({
                success: true,
                lastText: "done",
                messages: [],
                sessionId: session.id,
              }));
        return fakeRunningSession(options, result);
      },
    );
    const effectiveConfigs: unknown[] = [];
    runtime.events.subscribe({ sessionId: session.id }, (event) => {
      if (event.type === "config.effective")
        effectiveConfigs.push(event.payload);
    });

    const first = await runtime.runs.start({
      sessionId: session.id,
      prompt: "turn one",
      options: { context: { executionCwd: firstCwd } },
    });
    const second = await runtime.runs.start({
      sessionId: session.id,
      prompt: "turn two",
      options: { context: { executionCwd: secondCwd } },
    });
    notifyEngineChange?.("rules");
    await flushMicrotasks();
    releaseFirst?.({
      success: true,
      lastText: "done",
      messages: [],
      sessionId: session.id,
    });
    await first.result;
    await second.result;

    expect(effectiveConfigs).toEqual([
      expect.objectContaining({
        autoModeEngine: "llm",
        executionCwd: firstCwd,
      }),
      expect.objectContaining({
        autoModeEngine: "rules",
        executionCwd: secondCwd,
      }),
    ]);
    expect(replMock.bootstrapAutoMode.mock.calls.at(-1)?.[0]).toMatchObject({
      executionCwd: secondCwd,
      autoModeSettings: { engine: "rules" },
    });
    expect(replMock.bootstrapAutoMode.mock.calls.at(-1)?.[0].sharedState).toBe(
      replMock.bootstrapAutoMode.mock.calls[0]?.[0].sharedState,
    );
    await expect(
      runtime.sessions.getAutoModeStats(session.id),
    ).resolves.toMatchObject({
      engine: "rules",
      denials: expect.any(Object),
      breaker: expect.any(Object),
    });
    await runtime.close();
  }, 60_000);

  it("activates the Runtime-owned Auto guardrail when permission mode changes during a run", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
      defaultModel: "mock-model",
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({ title: "Live Auto Mode" });
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: "plan",
      autoModeEngine: "llm",
      executionCwd: tempRoot,
    });
    const fakeGuardrail = {
      kind: "tool",
      name: "auto-mode",
      beforeTool: vi.fn(async () => ({ action: "allow" as const })),
      getEngine: () => "llm" as const,
      getStats: () => ({ engine: "llm" as const, denials: {}, breaker: {} }),
      setEngine: () => undefined,
      getEngineForTest: () => "llm" as const,
      getStatsForTest: () => ({
        engine: "llm" as const,
        denials: {},
        breaker: {},
      }),
      setProviderForTest: () => undefined,
    } as unknown as AutoModeToolGuardrail;
    replMock.bootstrapAutoMode.mockResolvedValue({
      getGuardrail: () => fakeGuardrail,
      rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
    });
    let runOptions: KodaXOptions | undefined;
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        runOptions = options;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "wait",
    });
    if (!runOptions) throw new Error("expected run options");
    expect(replMock.bootstrapAutoMode).not.toHaveBeenCalled();
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: "auto",
    });
    await authorizeRuntimeAutoCall(runOptions, {
      id: "live-auto-read",
      name: "read",
      input: { path: "README.md" },
    });
    await expect(
      runOptions.events?.beforeToolExecute?.(
        "read",
        { path: "README.md" },
        { sessionId: session.id, toolId: "live-auto-read" },
      ),
    ).resolves.toBe(true);
    expect(fakeGuardrail.beforeTool).toHaveBeenCalledOnce();
    await expect(
      runtime.permissions.listPending({ runId: handle.runId }),
    ).resolves.toEqual([]);

    await runtime.sessions.updateSettings(session.id, {
      permissionMode: "plan",
    });
    await expect(
      runtime.sessions.getSettings(session.id),
    ).resolves.toMatchObject({
      permissionMode: "plan",
    });
    const blockedPlanPath = path.join(
      os.homedir(),
      "kodax-plan-mode-blocked.txt",
    );
    await authorizeRuntimeAutoCall(runOptions, {
      id: "live-plan-write",
      name: "write",
      input: { path: blockedPlanPath, content: "blocked" },
    });
    await expect(
      runOptions.events?.beforeToolExecute?.(
        "write",
        { path: blockedPlanPath, content: "blocked" },
        { sessionId: session.id, toolId: "live-plan-write" },
      ),
    ).resolves.toMatch(/plan mode/i);
    await runtime.runs.abort(handle.runId);
    await runtime.close();
  });

  it("serializes settings updates and Auto fallback without losing unrelated fields", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
      defaultModel: "mock-model",
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({
      title: "Settings Fallback CAS",
    });
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: "auto",
      autoModeEngine: "llm",
      executionCwd: tempRoot,
    });
    let fallback: ((engine: "llm" | "rules") => void) | undefined;
    const fakeGuardrail = {
      kind: "tool",
      name: "auto-mode",
      beforeTool: async () => ({ action: "allow" as const }),
      getEngine: () => "llm" as const,
      getStats: () => ({ engine: "llm" as const, denials: {}, breaker: {} }),
      setEngine: () => undefined,
      getEngineForTest: () => "llm" as const,
      getStatsForTest: () => ({
        engine: "llm" as const,
        denials: {},
        breaker: {},
      }),
      setProviderForTest: () => undefined,
    } as unknown as AutoModeToolGuardrail;
    replMock.bootstrapAutoMode.mockImplementation(
      async (deps: AutoModeBootstrapDeps) => {
        fallback = deps.onEngineChange;
        return {
          getGuardrail: () => fakeGuardrail,
          rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
        };
      },
    );
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession =>
        fakeRunningSession(options, new Promise<KodaXResult>(() => undefined)),
    );
    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "wait",
    });
    fallback?.("rules");
    await runtime.sessions.updateSettings(session.id, {
      autoModeClassifierModel: "mock-provider:classifier-v2",
    });
    await flushMicrotasks();

    await expect(
      runtime.sessions.getSettings(session.id),
    ).resolves.toMatchObject({
      permissionMode: "auto",
      autoModeEngine: "rules",
      autoModeClassifierModel: "mock-provider:classifier-v2",
      executionCwd: tempRoot,
    });
    await runtime.runs.abort(handle.runId);
    await runtime.close();
  });

  it("rebuilds the LLM guardrail after fallback when the Session explicitly switches back to LLM", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
      defaultModel: "mock-model",
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({
      title: "Auto Engine Reset",
    });
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: "auto",
      autoModeEngine: "llm",
      executionCwd: tempRoot,
    });
    let fallback: ((engine: "llm" | "rules") => void) | undefined;
    replMock.bootstrapAutoMode.mockImplementation(
      async (deps: AutoModeBootstrapDeps) => {
        fallback ??= deps.onEngineChange;
        const engine = deps.autoModeSettings.engine;
        const guardrail = {
          kind: "tool",
          name: "auto-mode",
          beforeTool: async () => ({ action: "allow" as const }),
          getEngine: () => engine,
          getStats: () => ({ engine, denials: {}, breaker: {} }),
          setEngine: () => undefined,
          getEngineForTest: () => engine,
          getStatsForTest: () => ({ engine, denials: {}, breaker: {} }),
          setProviderForTest: () => undefined,
        } as unknown as AutoModeToolGuardrail;
        return {
          getGuardrail: () => guardrail,
          rulesLoadResult: { merged: {}, sources: [], skipped: [], errors: [] },
        };
      },
    );
    let runOptions: KodaXOptions | undefined;
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        runOptions = options;
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "wait",
    });
    fallback?.("rules");
    await flushMicrotasks();
    await expect(
      runtime.sessions.getSettings(session.id),
    ).resolves.toMatchObject({
      autoModeEngine: "rules",
    });
    await runtime.sessions.updateSettings(session.id, {
      autoModeEngine: "llm",
    });
    if (!runOptions) throw new Error("expected run options");
    await authorizeRuntimeAutoCall(runOptions, {
      id: "llm-after-fallback",
      name: "read",
      input: { path: "README.md" },
    });

    expect(replMock.bootstrapAutoMode).toHaveBeenCalledTimes(2);
    expect(
      replMock.bootstrapAutoMode.mock.calls.at(-1)?.[0].autoModeSettings,
    ).toMatchObject({
      engine: "llm",
    });
    await runtime.runs.abort(handle.runId);
    await runtime.close();
  });

  it("rejects a caller-supplied auto-mode guardrail when Runtime owns explicit auto mode", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
      defaultModel: "mock-model",
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({
      title: "Duplicate Auto Mode",
    });
    await runtime.sessions.updateSettings(session.id, {
      permissionMode: "auto",
      autoModeEngine: "llm",
      executionCwd: tempRoot,
    });
    const duplicate = {
      kind: "tool" as const,
      name: "auto-mode",
      beforeTool: async () => ({ action: "allow" as const }),
    };

    await expect(
      runtime.runs.start({
        sessionId: session.id,
        prompt: "duplicate",
        options: { guardrails: [duplicate] },
      }),
    ).rejects.toThrow(/Runtime owns the auto-mode guardrail/i);
    expect(replMock.bootstrapAutoMode).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("tracks pending permission requests from wrapped tool approval hooks", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({ title: "Permission Test" });
    let releaseApproval: ((value: boolean) => void) | undefined;
    let approvalDone: Promise<boolean | string> | undefined;

    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        queueMicrotask(() => {
          approvalDone = options.events?.beforeToolExecute?.(
            "bash",
            { command: "npm test" },
            {
              sessionId: options.session?.id ?? session.id,
              seq: 1,
              turnId: "turn-permission",
              toolId: "tool-permission",
            },
          );
        });
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "needs permission",
      options: {
        events: {
          beforeToolExecute: () =>
            new Promise<boolean>((resolve) => {
              releaseApproval = resolve;
            }),
        },
      },
    });

    await flushMicrotasks();
    const pending = await runtime.permissions.listPending({
      runId: handle.runId,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.toolName).toBe("bash");

    releaseApproval?.(true);
    await approvalDone;

    expect(
      await runtime.permissions.listPending({ runId: handle.runId }),
    ).toEqual([]);
    const permissionEvents = await runtime.events.replay({
      runId: handle.runId,
      type: ["permission.requested", "permission.resolved"],
    });
    expect(permissionEvents.map((event) => event.type)).toEqual([
      "permission.requested",
      "permission.resolved",
    ]);

    await runtime.runs.abort(handle.runId);
    await runtime.close();
  });

  it("lets runtime permission responses resolve pending approval hooks", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Permission Respond Test",
    });
    let approvalDone: Promise<boolean | string> | undefined;
    let requestId = "";

    runtime.events.subscribe({ type: "permission.requested" }, (event) => {
      const payload = event.payload as { readonly id?: unknown };
      if (typeof payload.id === "string") {
        requestId = payload.id;
        void runtime.permissions.respond(payload.id, { type: "allow_once" });
      }
    });
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        queueMicrotask(() => {
          approvalDone = options.events?.beforeToolExecute?.(
            "bash",
            { command: "npm test" },
            {
              sessionId: options.session?.id ?? session.id,
              seq: 1,
              turnId: "turn-permission-respond",
              toolId: "tool-permission-respond",
            },
          );
        });
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "needs runtime permission response",
      options: {
        events: {
          beforeToolExecute: () => new Promise<boolean>(() => undefined),
        },
      },
    });

    await flushMicrotasks();

    expect(requestId).toMatch(/^perm_/);
    await expect(approvalDone).resolves.toBe(true);
    expect(
      await runtime.permissions.listPending({ runId: handle.runId }),
    ).toEqual([]);
    expect(
      await runtime.permissions.respond(requestId, { type: "allow_once" }),
    ).toBe(false);
    expect(
      await runtime.permissions.respond("missing-permission", {
        type: "allow_once",
      }),
    ).toBe(false);

    await runtime.runs.abort(handle.runId);
    await runtime.close();
  });

  it("emits bounded valid permission previews with an effective cwd for large writes", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const projectRoot = path.join(tempRoot, "large-write-project");
    await fs.mkdir(projectRoot, { recursive: true });
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Large Write Preview",
      projectPath: projectRoot,
    });
    let approvalDone: Promise<boolean | string> | undefined;
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        queueMicrotask(() => {
          approvalDone = options.events?.beforeToolExecute?.(
            "write",
            {
              file_path: "generated/large.txt",
              description:
                'Authorization: Bearer private-preview-token; deploy --access-token private-access-token; password: yaml-secret; "apiKey":"json-secret"; -----BEGIN PRIVATE KEY-----\npem-secret\n-----END PRIVATE KEY-----',
              content: `password=private-write-password\n${"x".repeat(32_000)}`,
            },
            { sessionId: session.id, toolId: "write-large" },
          );
        });
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "write a large generated file",
    });
    await flushMicrotasks();

    const [pending] = await runtime.permissions.listPending({
      runId: handle.runId,
    });
    expect(pending?.executionCwd).toBe(projectRoot);
    expect(pending?.inputPreview?.length).toBeLessThanOrEqual(8_192);
    const preview = JSON.parse(pending?.inputPreview ?? "");
    expect(preview).toMatchObject({
      file_path: "generated/large.txt",
      description:
        'Authorization: [REDACTED]; deploy --access-token=[REDACTED]; password: "[REDACTED]"; "apiKey":"[REDACTED]"; [REDACTED_PEM]',
      __truncated: true,
    });
    expect(pending?.inputPreview).not.toContain("private-preview-token");
    expect(pending?.inputPreview).not.toContain("private-access-token");
    expect(pending?.inputPreview).not.toContain("private-write-password");
    expect(pending?.inputPreview).not.toContain("yaml-secret");
    expect(pending?.inputPreview).not.toContain("json-secret");
    expect(pending?.inputPreview).not.toContain("pem-secret");
    expect(preview).not.toHaveProperty("content");

    if (!pending)
      throw new Error("expected a permission request for the large write");
    await runtime.permissions.respond(
      pending.id,
      { type: "reject" },
      { runId: handle.runId },
    );
    await approvalDone;
    await runtime.runs.abort(handle.runId);
    await runtime.close();
  }, 60_000);

  it("does not traverse or serialize write bodies even when they are small", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Small Write Preview",
    });
    let approvalDone: Promise<boolean | string> | undefined;
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        queueMicrotask(() => {
          const toolInput: Record<string, unknown> = { file_path: "small.txt" };
          Object.defineProperty(toolInput, "content", {
            enumerable: true,
            get() {
              throw new Error("write body was traversed");
            },
          });
          approvalDone = options.events?.beforeToolExecute?.(
            "write",
            toolInput,
            { sessionId: session.id, toolId: "write-small" },
          );
        });
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "write safely",
    });
    await flushMicrotasks();
    const [pending] = await runtime.permissions.listPending({
      runId: handle.runId,
    });
    expect(JSON.parse(pending?.inputPreview ?? "")).toEqual({
      file_path: "small.txt",
      __truncated: true,
    });
    if (!pending) throw new Error("expected a permission request");
    await runtime.permissions.respond(pending.id, { type: "reject" });
    await approvalDone;
    await runtime.runs.abort(handle.runId);
    await runtime.close();
  });

  it("falls back to valid bounded JSON when a tool input descriptor trap throws", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Hostile Preview Input",
    });
    let approvalDone: Promise<boolean | string> | undefined;
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        queueMicrotask(() => {
          const toolInput = new Proxy<Record<string, unknown>>(
            { path: "safe.txt" },
            {
              getOwnPropertyDescriptor() {
                throw new Error("descriptor trap");
              },
            },
          );
          approvalDone = options.events?.beforeToolExecute?.(
            "write",
            toolInput,
            { sessionId: session.id, toolId: "write-hostile-preview" },
          );
        });
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "write safely",
    });
    await flushMicrotasks();
    const [pending] = await runtime.permissions.listPending({
      runId: handle.runId,
    });
    expect(JSON.parse(pending?.inputPreview ?? "")).toEqual({
      __truncated: true,
    });
    if (!pending) throw new Error("expected a permission request");
    await runtime.permissions.respond(pending.id, { type: "reject" });
    await approvalDone;
    await runtime.runs.abort(handle.runId);
    await runtime.close();
  });

  it("normalizes caller-supplied permission previews into redacted JSON", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
    });
    const session = await runtime.sessions.create({
      title: "Permission Preview Input",
    });
    const decision = runtime.permissions.request({
      sessionId: session.id,
      runId: "run-preview-input",
      toolName: "bash",
      inputPreview: `Authorization: Bearer private-token\npassword: |\n  yaml-block-secret\n  second-secret\n${"x".repeat(100_000)}`,
    });
    await flushMicrotasks();

    const [pending] = await runtime.permissions.listPending({
      runId: "run-preview-input",
    });
    expect(pending?.executionCwd).toBe(process.cwd());
    expect(pending?.inputPreview?.length).toBeLessThanOrEqual(8_192);
    expect(() => JSON.parse(pending?.inputPreview ?? "")).not.toThrow();
    expect(pending?.inputPreview).toContain("[REDACTED]");
    expect(pending?.inputPreview).not.toContain("private-token");
    expect(pending?.inputPreview).not.toContain("yaml-block-secret");
    expect(pending?.inputPreview).not.toContain("second-secret");

    if (!pending) throw new Error("expected caller permission request");
    await runtime.permissions.respond(pending.id, { type: "reject" });
    await expect(decision).resolves.toEqual({ type: "reject" });
    await runtime.close();
  });

  it("derives the observable preview from concrete tool input instead of trusting caller text", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: tempRoot,
    });
    const session = await runtime.sessions.create({
      title: "Trusted Permission Preview",
    });
    const decision = runtime.permissions.request({
      sessionId: session.id,
      runId: "run-trusted-preview",
      toolName: "bash",
      inputPreview: '{"command":"npm test"}',
      toolInput: { command: "echo --token=private-preview-secret" },
      executionCwd: tempRoot,
    });

    const [pending] = await runtime.permissions.listPending({
      runId: "run-trusted-preview",
    });
    if (!pending) throw new Error("expected concrete permission request");
    expect(pending.inputPreview).toContain("echo");
    expect(pending.inputPreview).not.toContain("npm test");
    expect(pending.inputPreview).not.toContain("private-preview-secret");
    expect(pending.inputPreview).toContain("[REDACTED]");
    await runtime.permissions.respond(pending.id, { type: "reject" });
    await expect(decision).resolves.toEqual({ type: "reject" });
    await runtime.close();
  });

  it("lets clients select only Runtime-issued concrete grant suggestions", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, "sessions"),
    });
    const session = await runtime.sessions.create({
      title: "Concrete Permission Grant",
    });
    const decision = runtime.permissions.request({
      sessionId: session.id,
      runId: "run-concrete-grant",
      toolCallId: "tool-concrete-grant",
      toolName: "bash",
      toolInput: { command: "npm test" },
      executionCwd: tempRoot,
    });
    const [pending] = await runtime.permissions.listPending({
      runId: "run-concrete-grant",
    });
    if (!pending) throw new Error("expected concrete permission request");

    expect(pending.grantSuggestions).toEqual([
      expect.objectContaining({
        kind: "session",
        label: expect.stringContaining("npm test"),
      }),
      expect.objectContaining({
        kind: "persistent",
        label: expect.stringContaining("npm test"),
      }),
    ]);
    const persistent = pending.grantSuggestions?.find(
      (candidate) => candidate.kind === "persistent",
    );
    if (!persistent) throw new Error("expected persistent grant suggestion");

    await expect(
      runtime.permissions.respond(pending.id, {
        type: "allow_always",
        suggestionId: "scope_not_issued_by_runtime",
      }),
    ).rejects.toThrow(/grant suggestion/i);
    expect(
      await runtime.permissions.listPending({ runId: "run-concrete-grant" }),
    ).toHaveLength(1);

    expect(
      await runtime.permissions.respond(pending.id, {
        type: "allow_always",
        suggestionId: persistent.id,
      }),
    ).toBe(true);
    await expect(decision).resolves.toEqual({
      type: "allow_always",
      suggestionId: persistent.id,
    });

    const grants = await runtime.permissions.listGrants();
    expect(grants.value).toEqual([
      expect.objectContaining({
        persistence: "persistent",
        scope: expect.objectContaining({
          toolName: "bash",
          matcher: expect.objectContaining({ kind: "exact-command" }),
        }),
      }),
    ]);

    await expect(
      runtime.permissions.request({
        sessionId: session.id,
        runId: "run-concrete-grant-reuse",
        toolName: "bash",
        toolInput: { command: "npm test" },
        executionCwd: tempRoot,
      }),
    ).resolves.toMatchObject({ type: "allow_always" });
    const changed = runtime.permissions.request({
      sessionId: session.id,
      runId: "run-concrete-grant-changed",
      toolName: "bash",
      toolInput: { command: "npm publish" },
      executionCwd: tempRoot,
    });
    expect(
      await runtime.permissions.listPending({
        runId: "run-concrete-grant-changed",
      }),
    ).toHaveLength(1);
    const [changedRequest] = await runtime.permissions.listPending({
      runId: "run-concrete-grant-changed",
    });
    if (!changedRequest) throw new Error("expected changed permission request");
    await runtime.permissions.respond(changedRequest.id, { type: "reject" });
    await expect(changed).resolves.toEqual({ type: "reject" });
    await runtime.close();
  });

  it("narrows legacy allow_always scope responses to a Runtime-issued concrete matcher", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: tempRoot,
    });
    const session = await runtime.sessions.create({
      title: "Legacy Scope Response",
    });
    const filePath = path.join(tempRoot, "legacy-response.md");
    const decision = runtime.permissions.request({
      sessionId: session.id,
      runId: "run-legacy-scope-response",
      toolName: "edit",
      toolInput: { path: filePath, old_string: "a", new_string: "b" },
      executionCwd: tempRoot,
    });
    const [pending] = await runtime.permissions.listPending({
      runId: "run-legacy-scope-response",
    });
    if (!pending) throw new Error("expected legacy compatibility request");

    const legacyDecision = {
      type: "allow_always" as const,
      scope: { toolName: "edit", sessionId: session.id },
    };
    expect(await runtime.permissions.respond(pending.id, legacyDecision)).toBe(
      true,
    );
    await expect(decision).resolves.toEqual(legacyDecision);
    const grants = await runtime.permissions.listGrants();
    expect(grants.value).toEqual([
      expect.objectContaining({
        persistence: "persistent",
        scope: expect.objectContaining({
          toolName: "edit",
          sessionId: session.id,
          matcher: expect.objectContaining({ kind: "exact-path" }),
        }),
      }),
    ]);

    await expect(
      runtime.permissions.request({
        sessionId: session.id,
        runId: "run-legacy-scope-reuse",
        toolName: "edit",
        toolInput: {
          path: filePath,
          old_string: "other",
          new_string: "content",
        },
        executionCwd: tempRoot,
      }),
    ).resolves.toMatchObject({ type: "allow_always" });
    const otherSession = await runtime.sessions.create({
      title: "Other Session",
    });
    const otherDecision = runtime.permissions.request({
      sessionId: otherSession.id,
      runId: "run-legacy-scope-other-session",
      toolName: "edit",
      toolInput: { path: filePath, old_string: "other", new_string: "content" },
      executionCwd: tempRoot,
    });
    const [otherPending] = await runtime.permissions.listPending({
      runId: "run-legacy-scope-other-session",
    });
    if (!otherPending)
      throw new Error("expected another Session to require permission");
    await runtime.permissions.respond(otherPending.id, { type: "reject" });
    await expect(otherDecision).resolves.toEqual({ type: "reject" });
    await runtime.close();
  });

  it("never offers a persistent grant for dangerous or dynamically expanded shell commands", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: tempRoot,
    });
    const session = await runtime.sessions.create({
      title: "Unsafe Grant Suggestions",
    });

    const dangerous = runtime.permissions.request({
      sessionId: session.id,
      runId: "run-dangerous-grant",
      toolName: "bash",
      toolInput: { command: "rm -rf build" },
      executionCwd: tempRoot,
    });
    const dynamic = runtime.permissions.request({
      sessionId: session.id,
      runId: "run-dynamic-grant",
      toolName: "bash",
      toolInput: {
        command:
          process.platform === "win32"
            ? "echo %USERPROFILE% > output.txt"
            : "echo $HOME > output.txt",
      },
      executionCwd: tempRoot,
    });
    for (const runId of ["run-dangerous-grant", "run-dynamic-grant"]) {
      const [request] = await runtime.permissions.listPending({ runId });
      if (!request) throw new Error(`expected permission request for ${runId}`);
      expect(
        request.grantSuggestions?.map((candidate) => candidate.kind),
      ).toEqual(["session"]);
      await runtime.permissions.respond(request.id, { type: "reject" });
    }
    await expect(dangerous).resolves.toEqual({ type: "reject" });
    await expect(dynamic).resolves.toEqual({ type: "reject" });
    await runtime.close();
  });

  it("does not honor a previously persisted dynamic command grant", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtimeDir = path.join(tempRoot, ".kodax", "runtime");
    const command =
      process.platform === "win32"
        ? 'powershell -Command "Get-Content $HOME\\report.txt"'
        : 'cat "$HOME/report.txt"';
    const matcher = createRuntimePermissionMatcher({
      toolName: "bash",
      toolInput: { command },
      executionCwd: tempRoot,
      platform: runtimePermissionHostPlatform(),
    });
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(
      path.join(runtimeDir, "permission-grants.json"),
      JSON.stringify({
        revision: 1,
        value: [
          {
            id: "legacy-dynamic-command",
            scope: { toolName: "bash", matcher },
            persistence: "persistent",
            createdAt: "2026-07-19T00:00:00.000Z",
          },
        ],
      }),
      "utf-8",
    );
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: tempRoot,
    });
    const session = await runtime.sessions.create({
      title: "Dynamic Grant Migration",
    });

    const decision = runtime.permissions.request({
      sessionId: session.id,
      runId: "run-dynamic-grant-migration",
      toolName: "bash",
      toolInput: { command },
      executionCwd: tempRoot,
    });
    const [pending] = await runtime.permissions.listPending({
      runId: "run-dynamic-grant-migration",
    });
    if (!pending)
      throw new Error("expected dynamic grant to require a new decision");
    expect(
      pending.grantSuggestions?.map((candidate) => candidate.kind),
    ).toEqual(["session"]);
    await runtime.permissions.respond(pending.id, { type: "reject" });
    await expect(decision).resolves.toEqual({ type: "reject" });
    await runtime.close();
  });

  it("offers persistent grants only for Runtime-normalized command or path scopes", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: tempRoot,
    });
    const session = await runtime.sessions.create({
      title: "Generic Grant Boundary",
    });
    const decision = runtime.permissions.request({
      sessionId: session.id,
      runId: "run-generic-grant",
      toolName: "extension_action",
      toolInput: { action: "publish", _target: "staging" },
      executionCwd: tempRoot,
    });
    const [pending] = await runtime.permissions.listPending({
      runId: "run-generic-grant",
    });
    if (!pending) throw new Error("expected generic permission request");
    expect(
      pending.grantSuggestions?.map((candidate) => candidate.kind),
    ).toEqual(["session"]);
    await runtime.permissions.respond(pending.id, { type: "reject" });
    await expect(decision).resolves.toEqual({ type: "reject" });
    await runtime.close();
  });

  it("redacts secrets from Runtime-issued grant labels without weakening the exact matcher", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: tempRoot,
    });
    const session = await runtime.sessions.create({
      title: "Redacted Permission Grant",
    });
    const command =
      "TOKEN=private-grant-secret npm test -- --token=private-grant-secret";
    const decision = runtime.permissions.request({
      sessionId: session.id,
      runId: "run-redacted-grant",
      toolName: "bash",
      toolInput: { command },
      executionCwd: tempRoot,
    });
    const [pending] = await runtime.permissions.listPending({
      runId: "run-redacted-grant",
    });
    if (!pending) throw new Error("expected redacted permission request");
    expect(
      pending.grantSuggestions?.map((item) => item.label).join("\n"),
    ).not.toContain("private-grant-secret");
    expect(
      pending.grantSuggestions?.map((item) => item.label).join("\n"),
    ).toContain("[REDACTED]");

    const persistent = pending.grantSuggestions?.find(
      (item) => item.kind === "persistent",
    );
    if (!persistent) throw new Error("expected persistent grant suggestion");
    await runtime.permissions.respond(pending.id, {
      type: "allow_always",
      suggestionId: persistent.id,
    });
    await decision;
    await expect(
      runtime.permissions.request({
        sessionId: session.id,
        runId: "run-redacted-grant-reuse",
        toolName: "bash",
        toolInput: { command },
        executionCwd: tempRoot,
      }),
    ).resolves.toMatchObject({ type: "allow_always" });
    expect(
      JSON.stringify(await runtime.permissions.listGrants()),
    ).not.toContain("private-grant-secret");
    const grantAudit = await runtime.events.replay({
      type: "permission.grant.changed",
      sessionId: session.id,
    });
    expect(grantAudit.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        action: "created",
        grant: expect.objectContaining({ persistence: "persistent" }),
      }),
    ]);
    expect(JSON.stringify(grantAudit)).not.toContain("private-grant-secret");
    await runtime.close();
  });

  it("coalesces concurrent identical concrete calls without widening their grant candidate", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: tempRoot,
    });
    const session = await runtime.sessions.create({
      title: "Concurrent Permission Grant",
    });
    const input = {
      sessionId: session.id,
      runId: "run-concurrent-grant",
      toolName: "bash",
      toolInput: { command: "npm test" },
      executionCwd: tempRoot,
    } as const;
    const first = runtime.permissions.request({
      ...input,
      toolCallId: "tool-a",
    });
    const second = runtime.permissions.request({
      ...input,
      toolCallId: "tool-b",
    });

    const pending = await runtime.permissions.listPending({
      runId: input.runId,
    });
    expect(pending).toHaveLength(1);
    const suggestion = pending[0]?.grantSuggestions?.find(
      (item) => item.kind === "session",
    );
    if (!pending[0] || !suggestion)
      throw new Error("expected coalesced session suggestion");
    const decision = {
      type: "allow_session" as const,
      suggestionId: suggestion.id,
    };
    await runtime.permissions.respond(pending[0].id, decision);

    await expect(Promise.all([first, second])).resolves.toEqual([
      decision,
      decision,
    ]);
    expect((await runtime.permissions.listGrants()).value).toHaveLength(1);
    await runtime.close();
  });

  it("loads, lists, and revokes legacy coarse grants without letting them authorize calls", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtimeDir = path.join(tempRoot, ".kodax", "runtime");
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(
      path.join(runtimeDir, "permission-grants.json"),
      JSON.stringify({
        revision: 7,
        value: [
          {
            id: "legacy-bash-grant",
            scope: { toolName: "bash", sessionId: "legacy-session" },
            createdAt: "2026-07-01T00:00:00.000Z",
          },
        ],
      }),
      "utf-8",
    );
    const runtime = await createKodaXRuntime({ homeDir: tempRoot });

    const listed = await runtime.permissions.listGrants();
    expect(listed).toEqual({
      revision: 7,
      value: [
        expect.objectContaining({
          id: "legacy-bash-grant",
          persistence: "persistent",
          scope: { toolName: "bash", sessionId: "legacy-session" },
        }),
      ],
    });
    const decision = runtime.permissions.request({
      sessionId: "legacy-session",
      runId: "legacy-run",
      toolName: "bash",
      toolInput: { command: "rm -rf C:/project/$env:LEGACY_TARGET" },
      executionCwd: tempRoot,
    });
    const [pending] = await runtime.permissions.listPending({
      runId: "legacy-run",
    });
    if (!pending)
      throw new Error("expected legacy grant to require fresh approval");
    expect(pending).toMatchObject({
      sessionId: "legacy-session",
      toolName: "bash",
    });
    await runtime.permissions.respond(pending.id, { type: "reject" });
    await expect(decision).resolves.toEqual({ type: "reject" });
    expect(
      await runtime.permissions.revokeGrant(
        "legacy-bash-grant",
        listed.revision,
      ),
    ).toBe(true);
    expect((await runtime.permissions.listGrants()).value).toEqual([]);
    await expect(
      runtime.events.replay({ type: "permission.grant.changed" }),
    ).resolves.toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          action: "revoked",
          grant: expect.objectContaining({ id: "legacy-bash-grant" }),
        }),
      }),
    ]);
    await runtime.close();
  });

  it("keeps session grants in memory and exposes them through revisioned list/revoke", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: tempRoot,
    });
    const session = await runtime.sessions.create({
      title: "Session Permission Grant",
    });
    const decision = runtime.permissions.request({
      sessionId: session.id,
      runId: "run-session-grant",
      toolName: "edit",
      toolInput: { path: "src/index.ts", old_string: "a", new_string: "b" },
      executionCwd: tempRoot,
    });
    const [pending] = await runtime.permissions.listPending({
      runId: "run-session-grant",
    });
    const suggestion = pending?.grantSuggestions?.find(
      (candidate) => candidate.kind === "session",
    );
    if (!pending || !suggestion)
      throw new Error("expected session grant suggestion");
    await runtime.permissions.respond(pending.id, {
      type: "allow_session",
      suggestionId: suggestion.id,
    });
    await expect(decision).resolves.toMatchObject({ type: "allow_session" });

    const listed = await runtime.permissions.listGrants();
    expect(listed.value).toEqual([
      expect.objectContaining({ persistence: "session" }),
    ]);
    await expect(
      runtime.permissions.revokeGrant("missing", listed.revision - 1),
    ).rejects.toThrow(/stale/i);
    expect(
      await runtime.permissions.revokeGrant(
        listed.value[0]?.id ?? "",
        listed.revision,
      ),
    ).toBe(true);
    expect((await runtime.permissions.listGrants()).value).toEqual([]);
    await runtime.close();
  });

  it("drops session grants on Session deletion while keeping the grant CAS revision durable", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const sessionsDir = path.join(tempRoot, "sessions");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
    });
    const session = await runtime.sessions.create({
      title: "Session Grant Lifecycle",
    });
    const decision = runtime.permissions.request({
      sessionId: session.id,
      runId: "run-session-grant-lifecycle",
      toolName: "read",
      toolInput: { path: "README.md" },
      executionCwd: tempRoot,
    });
    const [pending] = await runtime.permissions.listPending({
      runId: "run-session-grant-lifecycle",
    });
    const suggestion = pending?.grantSuggestions?.find(
      (item) => item.kind === "session",
    );
    if (!pending || !suggestion)
      throw new Error("expected session grant suggestion");
    await runtime.permissions.respond(pending.id, {
      type: "allow_session",
      suggestionId: suggestion.id,
    });
    await decision;
    const beforeDelete = await runtime.permissions.listGrants();
    expect(beforeDelete.value).toHaveLength(1);

    await runtime.sessions.delete(session.id);
    const afterDelete = await runtime.permissions.listGrants();
    expect(afterDelete.value).toEqual([]);
    expect(afterDelete.revision).toBeGreaterThan(beforeDelete.revision);
    const grantAudit = await runtime.events.replay({
      type: "permission.grant.changed",
      sessionId: session.id,
    });
    expect(
      grantAudit.map((event) => (event.payload as { action?: string }).action),
    ).toEqual(["created", "expired"]);
    await runtime.close();

    const recreated = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
    });
    await expect(recreated.permissions.listGrants()).resolves.toEqual({
      revision: afterDelete.revision,
      value: [],
    });
    await recreated.close();
  });

  it("advances the durable grant revision when Runtime close expires session grants", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const sessionsDir = path.join(tempRoot, "sessions");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
    });
    const session = await runtime.sessions.create({
      title: "Runtime Grant Lifecycle",
    });
    const decision = runtime.permissions.request({
      sessionId: session.id,
      runId: "run-runtime-grant-lifecycle",
      toolName: "read",
      toolInput: { path: "README.md" },
      executionCwd: tempRoot,
    });
    const [pending] = await runtime.permissions.listPending({
      runId: "run-runtime-grant-lifecycle",
    });
    const suggestion = pending?.grantSuggestions?.find(
      (item) => item.kind === "session",
    );
    if (!pending || !suggestion)
      throw new Error("expected session grant suggestion");
    await runtime.permissions.respond(pending.id, {
      type: "allow_session",
      suggestionId: suggestion.id,
    });
    await decision;
    const beforeClose = await runtime.permissions.listGrants();
    expect(beforeClose.value).toHaveLength(1);
    await runtime.close();

    const recreated = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir,
    });
    const afterClose = await recreated.permissions.listGrants();
    expect(afterClose.value).toEqual([]);
    expect(afterClose.revision).toBeGreaterThan(beforeClose.revision);
    await recreated.close();
  });

  it("brokers daemon AskUser and accepts exactly one concurrent answer", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: "mock-provider",
      sharedDaemonHost: true,
    });
    const session = await runtime.sessions.create({ title: "Shared AskUser" });
    let answerDone: Promise<unknown> | undefined;

    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        queueMicrotask(() => {
          answerDone = options.events?.askUser?.({
            question: "Continue?",
            options: [
              { label: "Yes", value: "yes" },
              { label: "No", value: "no" },
            ],
          });
        });
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "ask the user",
    });
    await flushMicrotasks();
    const [request] = await runtime.userInputs.listPending({
      runId: handle.runId,
    });
    if (!request) throw new Error("expected pending AskUser request");
    const observation = await runtime.sessions.observe(
      session.id,
      () => undefined,
    );
    expect(observation.snapshot.live.pendingUserInputs).toEqual([
      expect.objectContaining({ requestId: request.id, runId: handle.runId }),
    ]);
    observation.close();

    const results = await Promise.all([
      runtime.userInputs.respond(request.id, "yes", {
        expectedRevision: request.revision,
      }),
      runtime.userInputs.respond(request.id, "no", {
        expectedRevision: request.revision,
      }),
    ]);

    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    await expect(answerDone).resolves.toBe("yes");
    await expect(
      runtime.userInputs.listPending({ runId: handle.runId }),
    ).resolves.toEqual([]);
    await runtime.runs.abort(handle.runId);
    await runtime.close();
  });

  it("keeps pending permission requests when a response is bound to another run", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({
      title: "Permission Binding Test",
    });
    const pendingDecision = runtime.permissions.request({
      sessionId: session.id,
      runId: "run-permission-owner",
      toolName: "bash",
      timeoutMs: 60_000,
    });
    const pending = await runtime.permissions.listPending({
      runId: "run-permission-owner",
    });
    const request = pending[0];
    if (!request) throw new Error("expected a pending permission request");

    expect(
      await runtime.permissions.respond(
        request.id,
        { type: "allow_once" },
        { runId: "run-other" },
      ),
    ).toBe(false);
    expect(
      await runtime.permissions.listPending({ runId: "run-permission-owner" }),
    ).toHaveLength(1);

    expect(
      await runtime.permissions.respond(
        request.id,
        { type: "allow_once" },
        { runId: "run-permission-owner" },
      ),
    ).toBe(true);
    await expect(pendingDecision).resolves.toEqual({ type: "allow_once" });
    expect(
      await runtime.permissions.respond(
        request.id,
        { type: "allow_once" },
        { runId: "run-permission-owner" },
      ),
    ).toBe(false);

    await runtime.close();
  });

  it("brokers permission requests even when the host did not provide an approval hook", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({ title: "Broker Test" });
    let approvalDone: Promise<boolean | string> | undefined;

    runtime.events.subscribe({ type: "permission.requested" }, (event) => {
      const payload = event.payload as { readonly id?: unknown };
      if (typeof payload.id === "string") {
        void runtime.permissions.respond(payload.id, { type: "allow_once" });
      }
    });
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        queueMicrotask(() => {
          approvalDone = options.events?.beforeToolExecute?.(
            "bash",
            { command: "npm test" },
            {
              sessionId: options.session?.id ?? session.id,
              seq: 1,
              turnId: "turn-broker",
              toolId: "tool-broker",
            },
          );
        });
        return fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
      },
    );

    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "needs broker permission",
    });

    await flushMicrotasks();

    await expect(approvalDone).resolves.toBe(true);
    expect(
      await runtime.permissions.listPending({ runId: handle.runId }),
    ).toEqual([]);

    await runtime.runs.abort(handle.runId);
    await runtime.close();
  });

  it("aborts the targeted running session only", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    const first = await runtime.sessions.create({ title: "First" });
    const second = await runtime.sessions.create({ title: "Second" });
    const aborts = new Map<string, number>();
    const firstEvents: string[] = [];
    const secondEvents: string[] = [];
    runtime.events.subscribe({ sessionId: first.id }, (event) =>
      firstEvents.push(event.type),
    );
    runtime.events.subscribe({ sessionId: second.id }, (event) =>
      secondEvents.push(event.type),
    );

    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession => {
        const sessionId = options.session?.id ?? "missing-session";
        queueMicrotask(() => {
          options.events?.onTextDelta?.(`delta-${sessionId}`, {
            sessionId,
            seq: 1,
            timestamp: new Date().toISOString(),
          });
        });
        const session = fakeRunningSession(
          options,
          new Promise<KodaXResult>(() => undefined),
        );
        return {
          ...session,
          abort(reason?: unknown) {
            aborts.set(sessionId, (aborts.get(sessionId) ?? 0) + 1);
            session.abort(reason);
          },
        };
      },
    );

    const firstRun = await runtime.runs.start({
      sessionId: first.id,
      prompt: "first",
    });
    const secondRun = await runtime.runs.start({
      sessionId: second.id,
      prompt: "second",
    });
    await flushMicrotasks();

    await runtime.runs.abort(firstRun.runId);
    const firstReplay = await runtime.events.replay({ runId: firstRun.runId });
    const secondReplay = await runtime.events.replay({
      runId: secondRun.runId,
    });

    expect(aborts.get(first.id)).toBe(1);
    expect(aborts.get(second.id)).toBeUndefined();
    expect(await runtime.runs.get(firstRun.runId)).toMatchObject({
      phase: "unknown",
      stop: {
        state: "unknown",
        outcome: "unknown",
      },
    });
    expect((await runtime.runs.get(secondRun.runId)).phase).toBe("running");
    expect(firstEvents).toContain("assistant.delta");
    expect(firstEvents).toContain("run.updated");
    expect(firstEvents).not.toContain("run.completed");
    expect(secondEvents).toContain("assistant.delta");
    expect(secondEvents).not.toContain("run.cancelled");
    expect(firstReplay.every((event) => event.sessionId === first.id)).toBe(
      true,
    );
    expect(secondReplay.every((event) => event.sessionId === second.id)).toBe(
      true,
    );

    await runtime.close();
  });

  it("persists and publishes run setting changes to other observers", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const runtime = await createKodaXRuntime({
      sessionsDir: tempRoot,
      defaultProvider: "mock-provider",
    });
    const session = await runtime.sessions.create({ title: "Run settings" });
    codingMock.startKodaX.mockImplementation(
      (options: KodaXOptions): RunningSession =>
        fakeRunningSession(options, new Promise<KodaXResult>(() => undefined)),
    );
    const updates: RuntimeEvent[] = [];
    runtime.events.subscribe(
      { sessionId: session.id, type: "run.updated" },
      (event) => {
        updates.push(event);
      },
    );
    const handle = await runtime.runs.start({
      sessionId: session.id,
      prompt: "configure me",
    });

    await runtime.runs.setModel(handle.runId, "model-next");
    await runtime.runs.setProvider(handle.runId, "provider-next");
    await runtime.runs.setReasoning(handle.runId, "deep");

    await expect(runtime.runs.get(handle.runId)).resolves.toMatchObject({
      model: "model-next",
      provider: "provider-next",
      reasoning: "deep",
    });
    expect(updates).toHaveLength(3);
    expect(updates.at(-1)?.payload).toMatchObject({
      model: "model-next",
      provider: "provider-next",
      reasoning: "deep",
    });
    await runtime.close();
  });

  it("wraps the existing workflow run manager without creating a second workflow store", async () => {
    const { createKodaXRuntime } = await import("@kodax-ai/kodax/runtime");
    const { getDefaultWorkflowRunManager } = await import("@kodax-ai/agent");
    const runtime = await createKodaXRuntime({ sessionsDir: tempRoot });
    const manager = getDefaultWorkflowRunManager();
    const runId = `runtime-workflow-${Date.now()}`;
    const workflowEvents: string[] = [];
    let finishWorkflow: (() => void) | undefined;
    const subscription = runtime.workflows.subscribe({ runId }, (event) => {
      workflowEvents.push(event.type);
    });

    const run = manager.start<WorkflowOutcome>({
      runId,
      workflow: "runtime-contract-test",
      processMetadata: {
        source: "sdk",
        hostMetadata: { sessionId: "workflow-session" },
      },
      runFn: async (hooks) => {
        hooks.onEvent(workflowEvent("agent_spawned", 1));
        await new Promise<void>((resolve) => {
          finishWorkflow = resolve;
        });
        hooks.onEvent(workflowEvent("agent_completed", 2));
        hooks.onEvent({
          type: "workflow_completed",
          seq: 3,
          data: { resultSummary: "workflow ok" },
        });
        return { kind: "completed", result: "workflow ok" };
      },
      classify: classifyWorkflowOutcome,
      onError: workflowErrorOutcome,
    });

    await flushMicrotasks();

    await expect(runtime.status.preflight()).resolves.toMatchObject({
      activeWorkflows: [expect.objectContaining({ runId, status: "running" })],
      activeAgentTurns: [],
      blockers: expect.arrayContaining(["active_workflows"]),
      canStop: false,
    });
    expect(await runtime.workflows.list({ runId })).toHaveLength(1);
    expect(await runtime.workflows.get(runId)).toMatchObject({
      runId,
      workflowName: "runtime-contract-test",
      status: "running",
    });
    expect(await runtime.workflows.pause(runId)).toBe(true);
    expect((await runtime.workflows.get(runId))?.status).toBe("paused");
    await expect(runtime.status.preflight()).resolves.toMatchObject({
      activeWorkflows: [expect.objectContaining({ runId, status: "paused" })],
      blockers: expect.arrayContaining(["active_workflows"]),
      canStop: false,
    });
    expect(await runtime.workflows.resume(runId)).toBe(true);

    finishWorkflow?.();
    await run.done;

    expect(await runtime.workflows.get(runId)).toMatchObject({
      runId,
      status: "completed",
      resultSummary: "workflow ok",
    });
    expect(workflowEvents).toContain("workflow_updated");
    expect(workflowEvents).toContain("workflow_finished");
    expect(await runtime.workflows.stop("missing-workflow")).toBe(false);
    const settledPreflight = await runtime.status.preflight();
    expect(settledPreflight.activeWorkflows).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ runId })]),
    );
    expect(settledPreflight.blockers).not.toContain("active_workflows");

    subscription.close();
    await runtime.close();
  });
});

type WorkflowOutcome =
  | { readonly kind: "completed"; readonly result: string }
  | { readonly kind: "failed"; readonly error: Error };

function classifyWorkflowOutcome(
  outcome: WorkflowOutcome,
): ManagedRunClassification {
  if (outcome.kind === "completed") {
    return { status: "completed", resultText: outcome.result };
  }
  return { status: "failed", error: outcome.error };
}

function workflowErrorOutcome(error: unknown): WorkflowOutcome {
  return {
    kind: "failed",
    error: error instanceof Error ? error : new Error(String(error)),
  };
}

function workflowEvent(
  type: WorkflowEvent["type"],
  seq: number,
): WorkflowEvent {
  return { type, seq };
}

function deferredExternalAgentFixture(key: string): {
  readonly factory: AgentExecutorFactory;
  readonly registration: ExternalAgentRegistration;
  readonly finish: () => void;
} {
  let taskState: AgentTaskState = "unknown";
  let finishChild: (() => void) | undefined;
  const childFinished = new Promise<void>((resolve) => {
    finishChild = resolve;
  });
  const factory: AgentExecutorFactory = {
    executorId: `${key}-deferred`,
    protocol: "http",
    async create() {
      return {
        async start(input) {
          return { idempotencyKey: input.idempotencyKey ?? key };
        },
        async *events() {
          yield { state: "unknown" as const };
          await childFinished;
          if (taskState === "unknown") taskState = "completed";
          yield { state: taskState, output: "child complete" };
        },
        async get() { return { state: taskState }; },
        async sendInput() {},
        async cancel() {
          taskState = "canceled";
          finishChild?.();
          return { state: taskState };
        },
        async reconcile() { return { state: taskState }; },
        async dispose() { finishChild?.(); },
      };
    },
  };
  return {
    factory,
    registration: {
      agentId: `external:${key}`,
      displayName: key,
      enabled: true,
      executorId: factory.executorId,
      protocol: factory.protocol,
      configurationRevision: `${key}-rev-1`,
      endpointIdentityHash: `sha256:${key}`,
      capabilities: {
        streaming: "supported",
        durableTasks: "supported",
        inputRequired: "supported",
        cancellation: "supported",
        artifacts: "supported",
      },
      effects: { remote: "read", workspace: "proposal" },
    },
    finish() {
      finishChild?.();
    },
  };
}

function fakeRunningSession(
  options: KodaXOptions,
  result: Promise<KodaXResult>,
): RunningSession {
  let aborted = false;
  let provider = options.provider;
  let model = options.modelOverride ?? options.model;
  let reasoning = options.reasoningMode;
  return {
    id: options.session?.id ?? "missing-session",
    get currentProvider() {
      return provider;
    },
    get currentModel() {
      return model;
    },
    get currentReasoning() {
      return reasoning;
    },
    get aborted() {
      return aborted;
    },
    attached: true,
    setProvider(name) {
      provider = name;
    },
    setModel(nextModel) {
      model = nextModel;
    },
    setReasoning(nextReasoning) {
      reasoning = nextReasoning;
    },
    abort() {
      aborted = true;
    },
    result,
  };
}

type RuntimeToolInputEvent = RuntimeEvent & {
  readonly payload: {
    readonly toolName: string;
    readonly partialJson: string;
    readonly meta?: { readonly toolId?: string };
  };
};

type RuntimeToolProgressEvent = RuntimeEvent & {
  readonly payload: {
    readonly update: { readonly id: string; readonly message: string };
  };
};

function runtimeTextPayload(event: RuntimeEvent): string {
  if (!isTestRecord(event.payload) || typeof event.payload.text !== "string") {
    throw new Error(`Expected text payload for ${event.type}`);
  }
  return event.payload.text;
}

function isRuntimeToolInputEvent(
  event: RuntimeEvent,
): event is RuntimeToolInputEvent {
  return isTestRecord(event.payload)
    && typeof event.payload.toolName === "string"
    && typeof event.payload.partialJson === "string";
}

function runtimeToolInputId(event: RuntimeToolInputEvent): string | undefined {
  const meta = event.payload.meta;
  return meta?.toolId;
}

function runtimeToolInputJson(event: RuntimeToolInputEvent): string {
  return event.payload.partialJson;
}

function isRuntimeToolProgressEvent(
  event: RuntimeEvent,
): event is RuntimeToolProgressEvent {
  return isTestRecord(event.payload)
    && isTestRecord(event.payload.update)
    && typeof event.payload.update.id === "string"
    && typeof event.payload.update.message === "string";
}

function runtimeToolProgressMessage(event: RuntimeToolProgressEvent): string {
  return event.payload.update.message;
}

function workflowProgressUpdate(
  runId: string,
  message: string,
): WorkflowProcessEvent {
  const now = new Date().toISOString();
  return {
    type: "workflow_updated",
    snapshot: {
      runId,
      workflowName: "parallel-review",
      status: "running",
      startedAt: now,
      updatedAt: now,
      items: [],
      counts: {
        pending: 0,
        running: 1,
        completed: 0,
        failed: 0,
        cancelled: 0,
        skipped: 0,
      },
      progress: {
        spawnedAgents: 1,
        finishedAgents: 0,
        activeAgents: 1,
        failedAgents: 0,
        stoppedAgents: 0,
      },
    },
    message,
  };
}

function runtimeWorkflowProgress(
  event: RuntimeEvent,
): { readonly runId: string; readonly message: string | undefined } {
  const payload = event.payload as WorkflowProcessEvent;
  return {
    runId: payload.snapshot.runId,
    message: payload.type === "workflow_updated" ? payload.message : undefined,
  };
}

function runtimeEventLogPath(root: string, runId: string): string {
  return path.join(
    root,
    ".kodax",
    "runtime",
    "runs",
    encodeURIComponent(runId),
    "events.jsonl",
  );
}

async function replayRuntimeText(
  runtime: KodaXRuntime,
  runId: string,
): Promise<string> {
  const replay = await runtime.events.replay({
    runId,
    type: "assistant.delta",
  });
  return replay.map(runtimeTextPayload).join("");
}

function runtimeEventIndex(
  events: readonly RuntimeEvent[],
  type: RuntimeEvent["type"],
): number {
  const index = events.findIndex((event) => event.type === type);
  if (index < 0) throw new Error(`Missing Runtime event: ${type}`);
  return index;
}

function isTestRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function makeDaemonEndpoint(tempRoot: string): RuntimeDaemonEndpoint {
  if (process.platform === "win32") {
    return {
      kind: "pipe",
      path: `\\\\.\\pipe\\kodax-sdk-runtime-test-${randomUUID()}`,
    };
  }
  return {
    kind: "unix",
    path: path.join(tempRoot, `kodax-sdk-runtime-test-${randomUUID()}.sock`),
  };
}

function isPermissionRequestPayload(
  value: unknown,
): value is { readonly id: string; readonly runId: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { readonly id?: unknown }).id === "string" &&
    typeof (value as { readonly runId?: unknown }).runId === "string"
  );
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function readDirectoryText(root: string): Promise<string> {
  const chunks: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile()) {
        chunks.push((await fs.readFile(target)).toString("utf8"));
      }
    }
  };
  await visit(root);
  return chunks.join("\n");
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Condition did not become true within ${timeoutMs}ms.`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function shutdownRuntimeDaemon(
  homeDir: string,
  profile: string,
): Promise<void> {
  const {
    readRuntimeDaemonLockOwner,
    readRuntimeDaemonState,
    readRuntimeDaemonToken,
    resolveRuntimeDaemonPaths,
  } = await import("./runtime-daemon/state.js");
  const state = readRuntimeDaemonState(
    resolveRuntimeDaemonPaths(homeDir, profile),
  );
  if (!state) return;
  const { runtimeDaemonEndpointFromState } =
    await import("./runtime-daemon/lifecycle.js");
  const {
    createRuntimeDaemonSocketClientTransport,
    isRuntimeDaemonTransportError,
  } = await import("./runtime-daemon/transport.js");
  const paths = resolveRuntimeDaemonPaths(homeDir, profile);
  const transport = await createRuntimeDaemonSocketClientTransport(
    runtimeDaemonEndpointFromState(state),
  );
  try {
    await transport.request("initialize", {
      profile,
      token: readRuntimeDaemonToken(paths),
    });
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        await transport.request("runtime.shutdown");
        break;
      } catch (error: unknown) {
        if (
          !isRuntimeDaemonTransportError(error) ||
          error.code !== "conflict" ||
          Date.now() >= deadline
        ) {
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }
  } finally {
    await transport.close?.();
  }
  await waitForCondition(
    () =>
      readRuntimeDaemonState(paths) === undefined &&
      readRuntimeDaemonLockOwner(paths.lockFile) === undefined,
  );
}

async function expectSettles<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 250,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not settle`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
