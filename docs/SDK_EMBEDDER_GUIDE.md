# KodaX SDK — Embedder Integration Guide

> Audience: host applications embedding `@kodax-ai/kodax` (and its
> subpaths) as a substrate — e.g. KodaX Space's desktop wrapper, IDE
> extensions, custom CLIs. If you are an end-user running the `kodax`
> command-line tool, see the root [README.md](../README.md) instead.

This guide documents the SDK surfaces a host integrator needs that
are NOT obvious from inspecting the type definitions alone:

1. [MCP server management — `McpManager` runtime API](#1-mcp-server-management--mcpmanager-runtime-api)
2. [Skill `!`cmd`` dynamic-context resolution + `IVariableResolver`](#2-skill-cmd-dynamic-context-resolution--ivariableresolver)
3. [Per-app data directory namespacing — `getAppDataDir`](#3-per-app-data-directory-namespacing--getappdatadir)
4. [Cross-reference: other FEATURE_186 surfaces](#4-cross-reference-other-feature_186-surfaces)
5. [Consuming from a CommonJS context (Electron main, CJS bundles)](#5-consuming-from-a-commonjs-context-electron-main-cjs-bundles)
6. [Session persistence — wiring `runKodaX` to disk](#6-session-persistence--wiring-runkodax-to-disk)
7. [Local development via `npm link` (iterating against in-tree KodaX)](#7-local-development-via-npm-link-iterating-against-in-tree-kodax)
8. [User-authored agents — markdown loader + extension `registerAgent`](#8-user-authored-agents--markdown-loader--extension-registeragent-feature_191-v0743)
9. [Electron + `stdio: 'inherit'` on Windows — PowerShell input hijack](#9-electron--stdio-inherit-on-windows--powershell-input-hijack)
10. [Model capabilities — context window, reasoning, descriptors](#10-model-capabilities--context-window-reasoning-descriptors)
11. [Workflow process events and lifecycle controls](#11-workflow-process-events-and-lifecycle-controls-feature_229-v0750)
12. [Provider credential verification — `verifyProviderCredential`](#12-provider-credential-verification--verifyprovidercredential-feature_216-v0745)
13. [Inject your product's manual — `selfManual`](#13-inject-your-products-manual--selfmanual-feature_221-v0747)
14. [Media input artifacts — `@kodax-ai/kodax/media`](#14-media-input-artifacts--kodax-aikodaxmedia-feature_239-v0756)
15. [Space v0.7.57 follow-up ledger](#15-space-v0757-follow-up-ledger)
16. [SDK agent-profile surface — `KodaXAgentProfile`](#16-sdk-agent-profile-surface--kodaxagentprofile-feature_247-v0758)
17. [Runtime SDK, Worker isolation, and local daemon](#17-runtime-sdk-worker-isolation-and-local-daemon-feature_253-feature_257)
18. [External-agent executor plane](#18-external-agent-executor-plane-feature_258-v0767)
19. [Session surface filtering and cursor pagination](#19-session-surface-filtering-and-cursor-pagination-feature_261-v0767)
20. [Cost-disciplined workflow routing and telemetry](#20-cost-disciplined-workflow-routing-and-telemetry-feature_259-v0767)
21. [Experimental governed memory — `/experimental-memory`](#21-experimental-governed-memory--experimental-memory-feature_260-v0768)
22. [Bidirectional A2A 1.0 — `/a2a`](#22-bidirectional-a2a-10--a2a-feature_267-v0769)

§1–§3 (and the Phase-7/8 MCP-popout surface in §1) land in v0.7.42
under FEATURE_186 (see [ADR-032](ADR.md#adr-032-sdk-embedder-surface-closure-feature_186-v0742)).
§5 documents the ESM-only packaging contract and the canonical
`await import(...)` recipe for CJS / Electron main consumers.

> **Code examples in §1–§4 use static ESM `import`** — that's the
> shape ESM consumers (Node `"type": "module"`, Vite, modern Electron
> renderer with `nodeIntegration: true`+ESM) want. **If your host
> compiles to CJS** (Electron main process, legacy Webpack CJS bundle,
> `tsc --module commonjs`), every static `import` example becomes
> `await import(...)` — see §5 for the full recipe and bundler
> configuration.

---

## 1. MCP server management — `McpManager` runtime API

### Why this exists

`@kodax-ai/kodax/mcp` re-exports `McpCapabilityProvider`, which is the
class KodaX uses internally to plug MCP into the agent runtime. Its
methods are capability-provider-shaped (`search` / `describe` /
`execute` / `read` / `getPrompt`) — that's the substrate-facing API,
not what a popout UI needs.

`McpManager` is a thin facade exposing the **popout-shape** API for
the lifecycle operations a host UI typically renders:

```
+- MCP Servers (popout) -+
| filesystem    [Ready]  | <- listServers row
| git           [Idle]   |
| sqlite        [Error]  |
+------------------------+
| [Start] [Stop] [Logs]  | <- startServer / stopServer / getServerLogs
| [View tools]           | <- listTools / getCatalog
+------------------------+
```

### Quick start

```ts
import { createMcpManager } from '@kodax-ai/kodax/mcp';
import { listMcpServers } from '@kodax-ai/kodax/repl';

// Build manager from the persisted ~/.kodax/config.json `mcpServers` section.
// listMcpServers reads the CRUD module's view of disk state.
const manager = createMcpManager(listMcpServers());

// Enumerate all configured servers (lazy + prewarm + disabled all included).
const rows = manager.listServers();
for (const row of rows) {
  console.log(`${row.serverId}: status=${row.status}, tools=${row.tools}`);
}

// Force connect + catalog refresh for a single server.
const started = await manager.startServer('filesystem');
console.log(`filesystem now: ${started.status}, ${started.tools} tools`);

// Tools-only view (popout's "tools" tab).
const toolList = await manager.listTools('filesystem');
for (const tool of toolList.tools) {
  console.log(`  - ${tool.name}: ${tool.description ?? '(no description)'}`);
}

// Full catalog (tools + resources + prompts) — popout's "all capabilities" tab.
const catalog = await manager.getCatalog('filesystem');
for (const descriptor of catalog.descriptors) {
  console.log(`  [${descriptor.kind}] ${descriptor.id}`);
}

// Last error + status for the "Logs" pane.
const logs = manager.getServerLogs('filesystem');
console.log(`status=${logs.status}, lastError=${logs.lastError ?? '(none)'}`);

// Disconnect transport (server stays in config; status flips to idle).
await manager.stopServer('filesystem');

// Tear down all runtimes when the popout closes / app exits.
await manager.dispose();
```

### Method reference

| Method | Returns | Purpose |
|---|---|---|
| `listServers()` | `McpServerStatus[]` | One row per configured server: `status`, `tools`/`resources`/`prompts` counts, `lastError`, `cachedAt`, deep-cloned `config`. Synchronous (uses cached diagnostics). |
| `startServer(id)` | `Promise<McpServerStatus>` | Force `refreshCatalog(true)`. Connects (or reconnects), re-lists tools/resources/prompts, writes the disk cache. Throws on unknown id. |
| `stopServer(id)` | `Promise<McpServerStatus>` | Dispose transport. Server stays in config so a subsequent `startServer` / `listTools` reconnects cleanly. |
| `getServerLogs(id)` | `McpServerLogs` | `{ status, connect, lastError?, cachedAt? }`. Designed as the data source for a "Logs" pane. **v0.7.42 is intentionally conservative** — only last error + status are exposed. Future iterations may add a ring buffer; the field shape will extend, never break. |
| `listTools(id, { forceRefresh? })` | `Promise<McpServerToolList>` | Tools-only filtered descriptors. Triggers lazy connect on cold cache. |
| `getCatalog(id, { forceRefresh? })` | `Promise<McpServerCatalog>` | Full catalog: `items` (lightweight) + `descriptors` (full) for tools, resources, and prompts. |
| `dispose()` | `Promise<void>` | Dispose all runtimes. After this, build a fresh `McpManager` to reuse. |
| `provider()` | `McpCapabilityProvider` | Escape hatch — the underlying capability-provider for advanced uses. |
| `execute(id, input)` | `Promise<CapabilityResult>` | Invoke a tool by capability id (`mcp:<serverId>:tool:<name>`). |
| `describe(id)` | `Promise<McpCapabilityDescriptor \| undefined>` | Resolve a single descriptor by capability id. |
| `search(query, options?)` | `Promise<readonly McpCatalogItem[]>` | Cross-server catalog search. |
| `read(id, options?)` | `Promise<CapabilityResult>` | Read a resource by capability id. |

### Server lifecycle states

`McpServerStatus.status` values:

| Status | Meaning |
|---|---|
| `idle` | Configured, not yet connected. Lazy default until first tool call. |
| `connecting` | Connection in progress (transient). |
| `ready` | Connected, catalog cached. |
| `error` | Last connect / refresh failed. `lastError` carries the message. |
| `disabled` | `connect: 'disabled'` in config — runtime exists but won't be used. |

### Adding / removing servers

For server **config** CRUD (write to `~/.kodax/config.json`), use the
`@kodax-ai/kodax/repl` subpath — kept separate from `/mcp` to keep
the latter dependency-free:

```ts
import { listMcpServers, upsertMcpServer, removeMcpServer } from '@kodax-ai/kodax/repl';

upsertMcpServer('filesystem', {
  type: 'stdio',
  command: 'mcp-server-filesystem',
  args: ['/repo'],
  connect: 'lazy',
});

// Remote servers: `type: 'streamable-http'` or `'sse'`. For ecosystem-config
// compatibility you may also use `type: 'http'` (v0.7.48+) — a config-layer
// alias that auto-detects Streamable HTTP first, then falls back to legacy
// HTTP+SSE. OAuth-protected servers are zero-config: omit `auth` endpoint
// fields and KodaX discovers + dynamically registers on the first 401.

// In-flight `McpManager` does NOT hot-pickup config changes. The
// standard pattern is: edit config, then construct a fresh manager
// (or call dispose() + createMcpManager again) before the next agent
// turn.
await manager.dispose();
const refreshed = createMcpManager(listMcpServers());
```

### Trust boundary

KodaX is a single-user CLI; the manager is last-write-wins. A popout
that swaps configs hot constructs a fresh manager — there is no
file-locking layer in v0.7.42. If your host needs multi-process
coordination (e.g. KodaX Space's popout window AND the main agent
both writing the same config), you mediate at your IPC layer.

---

## 2. Skill `!`cmd`` dynamic-context resolution + `IVariableResolver`

### Why this exists

Skills (`SKILL.md` files in `~/.kodax/skills/<name>/` etc.) support
**dynamic context** — markdown can embed `!`shell-command`` tokens
that are replaced with the command's stdout at resolution time:

```markdown
---
name: incident-report
description: Generate an incident summary from current repo state.
---

Current git status:
!`git status --short`

Recent commits:
!`git log --oneline -10`
```

Default behavior (no host hook): `VariableResolver` directly
`execSync`s each command with an internal allowlist. **For host
applications** (KodaX Space, IDE extensions, sandboxed substrates)
this is rarely the right behavior — the host typically wants to
mediate every shell execution through its own permission broker,
audit trail, or policy gate.

v0.7.42 (FEATURE_186 Phase 3) added a host hook on `SkillContext`
that intercepts every `!`cmd`` execution.

### Quick start

```ts
import { createResolver, resolveSkillContent } from '@kodax-ai/kodax/skills';
import type { SkillContext } from '@kodax-ai/kodax/skills';

const context: SkillContext = {
  workingDirectory: '/repo',
  projectRoot: '/repo',
  sessionId: 'session-1',
  environment: process.env as Record<string, string>,

  // v0.7.42 — host hook for !`cmd` execution.
  executeDynamicContext: async (command, cwd) => {
    // Route through the host's permission broker.
    const approved = await brokerAskUser({
      kind: 'skill-shell-command',
      command,
      cwd,
    });
    if (!approved) {
      throw new Error('User denied shell command execution');
    }
    // Run via the host's audited shell wrapper.
    const { stdout } = await brokerExecute(command, { cwd });
    return stdout;
  },
};

const resolved = await resolveSkillContent(skill.content, '', context);
// resolved.content has !`cmd` tokens replaced with stdout (or the
// command was rejected and the resolver substituted an error
// banner — depending on your hook's throw behavior).
```

### Disabling dynamic context entirely

For maximum-safety hosts (e.g. a security-audit popout), set
`disableDynamicContext: true` — every `!`cmd`` token is replaced with
a refusal banner regardless of any hook:

```ts
const context: SkillContext = {
  workingDirectory: '/repo',
  projectRoot: '/repo',
  sessionId: 'session-1',
  environment: {},
  disableDynamicContext: true,
};
```

### Resolution priority (3-tier dispatch)

```
+- VariableResolver.executeDynamicCommand ------+
|                                                |
|  1. context.disableDynamicContext === true    |
|     -> throw "Dynamic context disabled"       |
|                                                |
|  2. context.executeDynamicContext is set      |
|     -> await hook(command, cwd)               |
|                                                |
|  3. (legacy fallback)                         |
|     -> isSafeDynamicContextCommand allowlist  |
|     -> execSync (with built-in restrictions)  |
|                                                |
+------------------------------------------------+
```

**Hosts should always set `executeDynamicContext`** — the legacy
fallback exists for the standalone `kodax` CLI use case where the
end-user implicitly trusts their own machine's shell. Embedded
hosts have a different trust boundary (user trusts the host UI,
host UI mediates everything else).

### The LLM-triggered `skill` tool path — `KodaXOptions.skillDynamicContext` (v0.7.58)

The `SkillContext` hook above covers skills your host expands itself via
`resolveSkillContent`. But a skill can also be **auto-triggered by the model**
through the built-in `skill` tool — and that path builds its own `SkillContext`
internally, so it does not see your `resolveSkillContent` hook. Without wiring,
an auto-triggered `SKILL.md` (including a cloned project-level
`.kodax/skills/*`) would run its `` !`cmd` `` blocks through the built-in
`execSync` allowlist, bypassing your permission broker.

Thread the same policy into the tool path via `runKodaX`/`startKodaX` options:

```ts
import { runKodaX } from '@kodax-ai/kodax/coding';

await runKodaX(
  {
    provider: 'anthropic',
    skillDynamicContext: {
      // Same shape as SkillContext.executeDynamicContext — route through your broker.
      execute: async (command, cwd) => brokerExecute(command, cwd),
      // …or refuse all dynamic-context commands outright:
      // disable: true,
    },
  },
  prompt,
);
```

Absent this option the tool path keeps the trusted-CLI `execSync` fallback
(unchanged), so setting `skillDynamicContext.execute` (or `disable: true`) is the
supported way for an embedder to bring the auto-triggered path under the same
policy as the manual one.

### `IVariableResolver` entry points

| Symbol | Purpose | Source |
|---|---|---|
| `IVariableResolver` (interface) | Type contract — `resolve(content): Promise<string>` | `@kodax-ai/kodax/skills` |
| `VariableResolver` (class) | Stock implementation; reads `context.executeDynamicContext` if present, otherwise legacy `execSync` | `@kodax-ai/kodax/skills` |
| `createResolver(context)` (factory) | Returns a fresh `IVariableResolver` bound to the given context | `@kodax-ai/kodax/skills` |
| `resolveSkillContent(content, args, context)` (top-level) | High-level convenience — constructs resolver internally + resolves a single skill body | `@kodax-ai/kodax/skills` |

Hosts that want to ship a fully custom resolver (e.g. replace the
default with a JS-only sandbox) can implement `IVariableResolver`
directly and call `resolver.resolve(content)` themselves — KodaX's
own skill execution path calls through this interface.

### Argument parsing

`parseArguments(args: string): string[]` is exported alongside the
resolver. Use it to convert the raw `$ARGS` string into a parsed
positional array matching the skill's `argumentHint`.

---

## 3. Per-app data directory namespacing — `getAppDataDir`

### Why this exists

`~/.kodax/` is KodaX's own state directory — sessions, custom
providers, MCP servers, instances heartbeat, etc. all live under it.
Embedder hosts often need their **own** state directory adjacent to
KodaX's:

- IDE extension: store extension-local cache (`recents`, layout
  prefs, popout snapshot).
- KodaX Space: store desktop-app preferences (window position,
  theme, last-opened project).

Letting every host pick its own dir leads to multi-app conflict
(two extensions both writing `~/.kodax/cache/`) — and writing
inside `~/.kodax/` itself risks collision with KodaX's own keys.

`getAppDataDir(appId)` carves out a namespaced subdirectory under
`<KODAX_HOME>/apps/<appId>/` with reserved-name guards.

### Quick start

```ts
import { getAppDataDir } from '@kodax-ai/kodax/coding';

// Returns <KODAX_HOME>/apps/space/  (default: ~/.kodax/apps/space/)
// mkdirSync({recursive:true}) is called for you.
const spaceDir = getAppDataDir('space');

// Persist host-specific state inside that dir.
writeFileSync(path.join(spaceDir, 'window-state.json'), JSON.stringify(state));
```

### Namespace rules

`appId` is validated against `^[a-z][a-z0-9-]{1,31}$`:

- Must start with a lowercase letter.
- May contain lowercase letters, digits, `-`.
- 2-32 characters total.
- Reserved prefix: `kodax-*` (and the bare string `kodax`) — rejected
  to prevent host apps from squatting on names that look like KodaX's
  own subsystems.

| `appId` | Result |
|---|---|
| `space` | ✓ `<KODAX_HOME>/apps/space/` |
| `kodax-space-helper` | ✗ `Error: reserved appId prefix 'kodax-*'` |
| `MyApp` | ✗ `Error: appId must match /^[a-z][a-z0-9-]{1,31}$/` |
| `a` | ✗ `Error: appId must be 2-32 chars` |

### Interaction with `setAgentConfigHome`

`getAppDataDir` resolves `<KODAX_HOME>` via `getAgentConfigHome()` on
every call — so a host that called `setAgentConfigHome('/custom')`
before the first `getAppDataDir('space')` lands at
`/custom/apps/space/`. Useful for:

- **Tests**: per-test temp dir override.
- **Multi-tenant**: route different tenants to different home dirs.

```ts
import { setAgentConfigHome, getAppDataDir } from '@kodax-ai/kodax/coding';

setAgentConfigHome('/srv/tenant-42/.kodax');
const dir = getAppDataDir('space');
// dir === '/srv/tenant-42/.kodax/apps/space/'
```

---

## 4. Cross-reference: other FEATURE_186 surfaces

The three surfaces above are the most "needs-a-guide" pieces.
FEATURE_186 ships several additional SDK exports that are self-
documenting from type signatures but are worth knowing:

| Subpath | Symbol | Purpose |
|---|---|---|
| `@kodax-ai/kodax` | `runKodaX(opts, prompt)` | Blocking `Promise<KodaXResult>` — the original entry. |
| `@kodax-ai/kodax/coding` | `startKodaX(opts, prompt): RunningSession` | Non-blocking handle. See [RunningSession docs](#running-session-quick-reference). |
| `@kodax-ai/kodax/coding` | `createSessionControl()` | Bare `KodaXSessionControl` for advanced wiring. |
| `@kodax-ai/kodax/coding` | `getAgentConfigPath(name)` | Resolves `<KODAX_HOME>/<name>` dynamically. |
| `@kodax-ai/kodax/coding` | `setAgentConfigHome(path \| undefined)` | Override KODAX_HOME for tests / multi-tenant. |
| `@kodax-ai/kodax/coding` | `validateCustomProviderConfig(config)` | Same validator the SDK uses internally — no parallel schemas. |
| `@kodax-ai/kodax/coding` | `ToolSideEffect` + 4 helpers | Tool metadata (`readonly` / `mutates-fs` / `mutates-shell` / `mutates-network` / `mutates-state`) for plan-mode gates + custom permission UIs. |
| `@kodax-ai/kodax/coding` | `loadAgentsFiles(opts?)` | Load `AGENTS.md` cascade (project + user + global) for prompt assembly. |
| `@kodax-ai/kodax/repl` | `bootstrapAutoMode(...)` | Bootstrap the auto-mode classifier guardrail. |
| `@kodax-ai/kodax/repl` | `loadCommands(...)` / `KODAX_COMMANDS_DIR` | Discover user-defined slash commands. |
| `@kodax-ai/kodax/repl` | `listCustomProviders` / `upsertCustomProvider` / `removeCustomProvider` | Custom LLM provider CRUD. |
| `@kodax-ai/kodax/repl` | `listMcpServers` / `upsertMcpServer` / `removeMcpServer` / `validateMcpServerConfig` | MCP server config CRUD. |
| `@kodax-ai/kodax/skills` | `IVariableResolver` / `VariableResolver` / `createResolver` | See [section 2](#2-skill-cmd-dynamic-context-resolution--ivariableresolver). |

### RunningSession quick reference

```ts
import { startKodaX } from '@kodax-ai/kodax/coding';

const session = startKodaX({ provider: 'anthropic', model: 'claude-sonnet-4-6' }, 'review this PR');
console.log(session.id);                // freshly minted or echoes opts.session.id

// Mid-run mutators — applied on the next turn (CAP-055 per-turn re-resolution).
session.setProvider('zhipu');
session.setModel('glm-4.6');
session.setReasoning('balanced');       // KodaXReasoningMode: 'off' | 'auto' | 'quick' | 'balanced' | 'deep'

// Cooperative abort.
setTimeout(() => session.abort('user cancelled'), 30_000);

// Await the eventual result.
const result = await session.result;
console.log(result.finalMessage);
```

Constructor-supplied `options.abortSignal` is forwarded into the
internal `AbortController`; calling either signal aborts the run.

---

## 5. Consuming from a CommonJS context (Electron main, CJS bundles)

### TL;DR

`@kodax-ai/kodax` and **all** its subpaths are published **ESM-only**.
In a CommonJS context — Electron's main process (`vm.mainModule` runs
as CJS by default), legacy Webpack/esbuild configs with
`format: 'cjs'`, or any code path that ends up calling `require()` —
you must use dynamic `import()` instead of static `import` /
`require`. Both Node 22+ and Node 20.19+ support dynamic-importing
ESM from CJS without flags.

```ts
// ❌ This breaks in CJS — esbuild / tsc transforms static `import`
//    into `require('@kodax-ai/kodax/mcp')`, which Node then rejects
//    with ERR_PACKAGE_PATH_NOT_EXPORTED because our `exports` only
//    declares the `import` condition.
import { McpManager } from '@kodax-ai/kodax/mcp';

// ✅ Use dynamic import — Node resolves it via the ESM loader and
//    matches our `import` condition.
const { McpManager } = await import('@kodax-ai/kodax/mcp');
```

`import type { ... }` is **fine in CJS** — TypeScript / esbuild strip
type-only imports at compile time, so they never become runtime
`require()` calls:

```ts
import type { McpManager, McpServerStatus } from '@kodax-ai/kodax/mcp';
// ↑ compiles to nothing at runtime
```

### Why we don't ship dual ESM/CJS bundles

The natural fix would be to add `"require": "./dist/sdk-*.cjs"` next
to the existing `"import"` condition in `package.json#exports`. We
investigated this for v0.7.42 and the technical reality blocks all
the subpaths embedders typically reach for:

| Subpath | ESM-only third-party deps inlined | Dual feasible? |
|---|---|---|
| `/agent` | 0 | ✅ feasible (no UI deps) |
| `/mcp` | 0 | ✅ feasible (no UI deps) |
| `/skills` | 1 (`yaml`) | ❌ |
| `/llm` | 2 (`@agentclientprotocol/sdk`, `partial-json`) | ❌ |
| `/coding` | 4 (`yaml`, `tsx`, …) | ❌ |
| `/repl` | **21** (`ink`, `chalk`, `react`, `ansi-escapes`, …) | ❌ |
| root | 21 (same as `/repl`) | ❌ |

Once a bundle inlines any ESM-only dependency, the bundle itself
cannot be a valid CJS module — `require()`ing it would synchronously
import an ESM dep, which Node refuses. `ink`, `chalk`, and most of
the modern terminal-UI ecosystem are ESM-only as of 2024–2026, with
no plans to dual-publish.

**Dynamic `import()` is the canonical fix**, not a workaround. It
is part of the ECMAScript standard, supported in CJS contexts by
spec, and is how Node itself recommends consuming ESM from CJS today.

### Electron main process recipe

Electron's main process is CJS by default (`require('electron')`
works because main runs without `"type": "module"`). The pattern
that drops cleanly into existing Electron code:

```ts
// main.ts (or main.cjs) — Electron main process
import type { McpManager } from '@kodax-ai/kodax/mcp';            // compile-time only
import type { RunningSession } from '@kodax-ai/kodax/coding';     // compile-time only

let mcpManager: McpManager | null = null;
let kodax: typeof import('@kodax-ai/kodax/coding') | null = null;

async function bootKodaX() {
  // Bundle these dynamic imports as runtime-resolved (don't let
  // esbuild rewrite them — see "Bundler config" below).
  const { createMcpManager } = await import('@kodax-ai/kodax/mcp');
  const { listMcpServers } = await import('@kodax-ai/kodax/repl');

  kodax = await import('@kodax-ai/kodax/coding');
  mcpManager = createMcpManager(listMcpServers());
}

app.whenReady().then(bootKodaX);

// Wire to IPC handlers — your popout UI calls these.
ipcMain.handle('mcp:listServers', () => mcpManager!.listServers());
ipcMain.handle('mcp:startServer', (_, id: string) => mcpManager!.startServer(id));
ipcMain.handle('mcp:listTools', (_, id: string) => mcpManager!.listTools(id));
ipcMain.handle('mcp:getServerLogs', (_, id: string) => mcpManager!.getServerLogs(id));

ipcMain.handle('kodax:run', async (_, prompt: string) => {
  const session = kodax!.startKodaX({ provider: 'anthropic', model: 'claude-sonnet-4-6' }, prompt);
  return session.result;
});
```

### Bundler configuration

Most bundlers (esbuild, Webpack, Vite, Rollup) will, by default,
transform `await import(x)` into `require(x)` when targeting CJS.
You must tell the bundler to **preserve** the dynamic import:

**esbuild**:

```js
build({
  format: 'cjs',
  platform: 'node',
  // Keep dynamic imports as-is so they resolve to the ESM bundle at runtime.
  external: ['@kodax-ai/kodax', '@kodax-ai/kodax/*'],
})
```

Alternatively, mark only `@kodax-ai/kodax` as external — bundlers
that respect `external` will not rewrite dynamic imports of external
modules.

**Webpack**: add `@kodax-ai/kodax` (and any subpaths you use) to
`externals`, e.g. `{ '@kodax-ai/kodax/mcp': 'commonjs2 @kodax-ai/kodax/mcp' }`.

**Vite**: in `vite.config.ts` SSR / Electron-main builds, add
`@kodax-ai/kodax` and subpaths to `ssr.external`.

If the bundler still rewrites the dynamic import, the symptom is a
synchronous `Error: ERR_REQUIRE_ESM` (Node ≤ 20) or
`ERR_PACKAGE_PATH_NOT_EXPORTED` (Node 22+). Fix the bundler config
before suspecting our package.

### When you really need synchronous CJS

If your host environment cannot adopt `await import(...)` (rare —
even old Webpack supports it via `import()` syntax preserved through
to runtime), the two subpaths with zero ESM-only deps (`/agent` and
`/mcp`) are the **only** ones that could in principle ship a CJS
build. We have not productized this yet — file an issue with your
concrete blocker (sync popout startup, specific bundler limitation,
etc.) and we'll evaluate adding a partial-dual emit for those two
subpaths in a follow-up release.

### Quick checklist before reporting "it doesn't work in CJS"

- [ ] `package.json#type` in **your** project — if it's `"module"`,
      static `import` works; if absent / `"commonjs"`, you need
      dynamic `await import()`.
- [ ] Your bundler emit format — `format: 'cjs'` + static `import`
      from KodaX subpaths will always fail.
- [ ] You used `import type { ... }` not `import { ... }` for
      type-only references (otherwise they survive as runtime
      `require`).
- [ ] Bundler is set to **external** `@kodax-ai/kodax` (or skip
      bundling subpath imports entirely).
- [ ] Node version ≥ 20.19 (or ≥ 22 for the more permissive
      `--experimental-require-module` default).

---

## 6. Session persistence — wiring `runKodaX` to disk

### The trap

```ts
import { runKodaX } from '@kodax-ai/kodax/coding';

await runKodaX(
  {
    provider: 'zhipu-coding',
    session: { id: 's_my_chat', scope: 'user' },  // ← session.id set
  },
  'reply with: ok',
);
// ✗ Run completes, LLM streams, events fire — but
// ~/.kodax/sessions/s_my_chat.jsonl does NOT exist.
```

`session.id` alone is **not** enough. The SDK's snapshot path is
gated on `options.session.storage`:

```ts
// packages/coding/src/agent-runtime/middleware/session-snapshot.ts
if (!options.session?.storage) {
  return;   // silent no-op
}
```

This is by design — the CLI ships its own storage wiring, and the
SDK doesn't want to force a disk-write side-effect onto every
embedder (some hosts persist to a DB / cloud / IndexedDB instead).
But the contract was previously **undocumented**, so SDK consumers
typically hit this once before learning the rule.

**v0.7.43 added a one-shot `console.warn` when `session.id` is set
but `session.storage` is missing** — it points at this section.

**v0.7.63 narrows that warning to caller-provided session IDs.** The
`startKodaX()` convenience wrapper may generate a handle ID for the returned
running-session object; that generated ID is threaded into the run only when it
will not override auto-resume/resume discovery, and it no longer triggers the
missing-storage warning by itself.

### The canonical fix

```ts
import { runKodaX } from '@kodax-ai/kodax/coding';
import { createSessionManager } from '@kodax-ai/kodax/session';

// One manager per host process; reuse across runs so the
// per-session write queue + append-watermark caches stay coherent.
const {
  storage,
  listSessions,
  loadSession,
  loadFullTranscript,
  appendClientNotice,
  compactSession,
} = createSessionManager();

await runKodaX(
  {
    provider: 'zhipu-coding',
    session: {
      id: 's_my_chat',
      scope: 'user',
      storage,                  // ← key — wire the storage instance
    },
  },
  'reply with: ok',
);
// ✓ ~/.kodax/sessions/s_my_chat.jsonl now exists after the run.

// Same `storage` instance reads back through SessionManager:
const recent = await listSessions({
  scope: 'user',
  surface: 'acp',
  limit: 50,
});
const nextPage = recent.at(-1)?.cursor
  ? await listSessions({
      scope: 'user',
      surface: 'acp',
      limit: 50,
      cursor: recent.at(-1)?.cursor,
    })
  : [];
const replay = await loadSession('s_my_chat');
const scrollback = await loadFullTranscript('s_my_chat');
const compacted = await compactSession('s_my_chat', { dryRun: true });

await appendClientNotice('s_my_chat', {
  source: 'space',
  content: '/doctor ok',
});
```

### What `createSessionManager()` returns (v0.7.43+)

```ts
interface SessionManager {
  // Read side (FEATURE_173 v0.7.42)
  listSessions(...): Promise<SessionSummary[]>;
  loadSession(id): Promise<...>;
  loadFullTranscript(id): Promise<...>;
  appendClientNotice(id, opts): Promise<SessionTranscriptEntry | null>;
  compactSession(id, opts?): Promise<CompactSessionResult>;
  forkSession(id, opts?): Promise<...>;
  rewindSession(id, opts?): Promise<...>;
  setActiveEntry(id, selector): Promise<void>;
  deleteSession(id): Promise<void>;
  listRunningSessions(): Promise<RunningSessionInfo[]>;
  watchSessions(cb): () => void;
  // Write side (v0.7.43 follow-up)
  storage: FileSessionStorage;     // ← NEW — pass into runKodaX
}
```

`surface` is an exact filter applied before `limit`. Each returned summary may
include an opaque `cursor`; pass the last summary's cursor back unchanged to
continue the stable newest-first listing. Callers must not parse or construct
cursors themselves.

### Active context vs full transcript vs UI replay

Session persistence exposes three related but different layers:

| Need | Use | Meaning |
|---|---|---|
| Continue a model turn | `loadSession(id)` | Active branch only. This is the context KodaX would resume from. |
| Render a host sidebar / scrollback | `loadFullTranscript(id)` | Append-order transcript entries, including entries no longer on the active branch when available. |
| Reuse TUI display projection | `SessionData.uiHistory` | Optional bounded replay cache. Interactive REPL sessions may write it; headless SDK sessions may not. |

For product UI, prefer `loadFullTranscript(id)` for conversation history and
treat `loadSession(id)` as the model-context API. Do not assume `uiHistory`
exists. It is intentionally a small, lossy replay cache; canonical facts remain
in `messages` / `lineage`.

`loadFullTranscript(id).transcriptEntries` is the structured host-facing
scrollback. Each entry has stable ownership and ordering fields:

```ts
interface SessionTranscriptEntry {
  entryId: string;
  parentId: string | null;
  logicalId: string;
  sourceEntryId?: string;
  timestamp: string;
  type: 'message' | 'compaction' | 'branch_summary' | 'rewind_marker' | 'client_notice' | 'task_result';
  source?: 'user' | 'assistant' | 'workflow' | 'child_task' | 'system' | 'client';
  turnId?: string;
  active: boolean;
  message: KodaXMessage;
  payload?: unknown;
  taskResults?: readonly KodaXTaskResultMetadata[];
}
```

`entryId` is the physical lineage node id. `logicalId` is stable across
forked/cloned copies of the same transcript item, and `sourceEntryId` is present
on cloned entries to point back to the root physical source entry. Hosts that
want to fold cloned history should group by `logicalId`, not by
`message.role`, content, timestamp, or `[compacted]` placeholders.
Legacy entries without persisted provenance use `logicalId === entryId` and omit
`sourceEntryId`; treat that as "unknown/not cloned", not as content-based proof
that no older clone exists.
`loadFullTranscript()` still returns raw append-order scrollback; it does not
hide compaction notices or silently merge branches.

Since v0.7.63, rewind audit markers are represented as
`type: 'rewind_marker'`. They are useful for host scrollback and audit UI, but
they do not enter model context: `loadSession()` omits them, and
`loadFullTranscript().messages` filters them out while
`loadFullTranscript().transcriptEntries` keeps the structured marker.

Use `type` / `source` / `timestamp` / `active` instead of parsing
`message.role`, synthetic wrapper text, or filesystem side stores. In
particular, workflow and child-task completions surface as
`type: 'task_result'` with `taskResults[]`:

```ts
const full = await loadFullTranscript(sessionId);
for (const entry of full?.transcriptEntries ?? []) {
  if (entry.type === 'task_result') {
    for (const result of entry.taskResults ?? []) {
      // result.source is 'workflow' or 'child_task'
      // result.taskId / runId / status / title / summary are structured.
    }
  }
}
```

For host-local output that should be visible in the transcript but must not
enter model context, call `appendClientNotice()`:

```ts
await appendClientNotice(sessionId, {
  source: 'space',
  content: '/mcp status: 3 servers connected',
  timestamp: new Date().toISOString(),
  payload: { command: '/mcp status' },
});

const active = await loadSession(sessionId);         // no client notice
const full = await loadFullTranscript(sessionId);    // includes client_notice
```

Client notices are persisted as lineage entries, not model messages. They are
returned from `loadFullTranscript()` with `type: 'client_notice'`,
`source: 'client'`, and `payload.entersModelContext === false`.

v0.7.51 extends the `uiHistory` schema so interactive sessions can persist
sanitized terminal tool cards. Headless SDK sessions can still reconstruct
tool-call display from canonical assistant `tool_use` and user `tool_result`
messages when no TUI replay cache exists. Workflow progress remains on the
`WorkflowProcessSnapshot` / lifecycle-controller surfaces from v0.7.50; session
history should replay durable child digests and final answers, not workflow live
process state. The neutral replay types live with the session data model and are
exported from both `@kodax-ai/kodax/agent` and `@kodax-ai/kodax/session`; use
`KodaXSessionUiHistoryItem` / `KodaXSessionUiToolCall` when a host needs to
type-check `SessionData.uiHistory`.

SDK hosts that want the same neutral replay projection as the TUI can call the
session helper directly without importing Ink/React:

```ts
import {
  loadSession,
  restoreHistoryItemsFromSession,
  type CreatableHistoryItem,
} from '@kodax-ai/kodax/session';

const session = await loadSession(sessionId);
const replayItems: CreatableHistoryItem[] = session
  ? restoreHistoryItemsFromSession({
      messages: session.messages,
      uiHistory: session.uiHistory,
    })
  : [];
```

`restoreHistoryItemsFromSession()` prefers persisted `uiHistory.tool_group`
items when present, and otherwise reconstructs sanitized terminal tool cards
from adjacent `tool_use` / `tool_result` message blocks. The lower-level
`extractHistorySeedsFromMessages()` helper is also exported from
`@kodax-ai/kodax/session` for hosts that want to apply their own projection.

### Custom sessions directory (multi-tenant / tests)

```ts
const { storage } = createSessionManager({
  sessionsDir: '/srv/tenant-42/.kodax/sessions',
});
// `storage` writes there; matching listSessions/loadSession on the
// same manager read from the same dir.
```

This is equivalent to constructing `FileSessionStorage` directly
but keeps read + write sharing one instance (so append-watermark
caches stay warm across mixed list / run operations).

### Bring-your-own storage (database / cloud / IndexedDB)

`FileSessionStorage` implements `KodaXSessionStorage`. Any class
implementing the same interface can be passed in. Minimal contract:

```ts
import type { KodaXSessionStorage, SessionData } from '@kodax-ai/kodax/coding';

class MyDbSessionStorage implements KodaXSessionStorage {
  async save(id: string, data: SessionData): Promise<void> { /* ... */ }
  async load(id: string): Promise<SessionData | null> { /* ... */ }
  async list(opts?: ...): Promise<SessionSummary[]> { /* ... */ }
  async delete(id: string): Promise<void> { /* ... */ }
  // (other methods — see the @kodax-ai/kodax/coding type for the full surface)
}

const storage = new MyDbSessionStorage();
await runKodaX({ session: { id, storage }, ... }, prompt);
```

The SA / AMA loops are storage-implementation-agnostic — they just
call `storage.save(...)` at the terminal sites (success / error /
mid-flow / limit-reached). Storage failures are swallowed locally
with a `[SessionSnapshot] storage.save failed` `console.error` —
they never propagate to the `runKodaX` caller.

### Why isn't `storage` defaulted automatically?

Three reasons we **don't** auto-construct `FileSessionStorage` when
`session.id` is supplied:

1. **Package boundary**: `FileSessionStorage` is implemented in
   `@kodax-ai/repl` (it's >500 LoC of write-queue + watermark +
   JSONL streaming logic). `@kodax-ai/coding` does not depend on
   `/repl`, and reversing that direction breaks ADR-001 package
   independence (you'd no longer be able to consume `/coding`
   without dragging the Ink REPL bundle).
2. **Pluggability**: hosts often want non-filesystem storage
   (Electron IndexedDB, web app S3 bucket, server-side Postgres).
   Defaulting to `FileSessionStorage` would force a `fs/promises`
   side-effect on every embedder.
3. **Explicit > implicit**: a silent default would hide the wiring
   from new SDK consumers; the v0.7.43 `console.warn` makes the
   missing wiring loud the first time it bites.

### When to construct `FileSessionStorage` directly vs go through `createSessionManager`

| Use case | Construct directly | Use `createSessionManager` |
|---|---|---|
| Only need to save runs, no listing / reading UI | ✓ | (also fine — `storage` field gives you the same instance) |
| Need a popout / sidebar showing past sessions | | ✓ — pairs read + write through one instance |
| Custom sessions dir for tests / tenants | (works, but you must repeat the dir option for each call) | ✓ — `{ sessionsDir }` once, both sides honor it |
| Want to mock storage for unit tests | ✓ (inject mock implementing `KodaXSessionStorage`) | — |

### Quick checklist before reporting "session.jsonl not appearing"

- [ ] Did you set `session.storage`? (Not just `session.id`.)
- [ ] Is the run actually reaching a terminal site?
      `saveSessionSnapshot` fires from success / error / mid-flow /
      limit-reached. A run that throws synchronously before
      `runKodaX` enters the loop never saves.
- [ ] Did `storage.save` throw? Check `console.error` for
      `[SessionSnapshot] storage.save failed`. Storage errors are
      isolated by design (don't fail the run), but they leave the
      session file unwritten.
- [ ] Is the `sessionsDir` the one you expect? Default is
      `<KODAX_HOME>/sessions`; override via `setAgentConfigHome` or
      `createSessionManager({ sessionsDir })`.
- [ ] Is the `session.id` filesystem-safe? KodaX accepts any string
      but writes `<id>.jsonl` literally — IDs with `/`, `\`, or
      control chars will be rejected by the OS.

---

## 7. Local development via `npm link` (iterating against in-tree KodaX)

If you maintain an SDK consumer (KodaX Space, an IDE extension, a custom
bundler integration) and need to iterate against an unreleased KodaX
build — verifying a bugfix, prototyping against an in-progress feature,
running your project's test suite against `main` — you can `npm link`
the in-tree KodaX checkout instead of waiting for a published version.

As of v0.7.43 the root `package.json` is in **already-published shape**:
`"name": "@kodax-ai/kodax"` is baked in along with all 10 SDK subpath
exports. `npm link` "just works" — no need to run `scripts/release.mjs`
first.

### Recipe

```bash
# In your local KodaX checkout
cd /path/to/KodaX
npm install                                    # one-time (sets up workspaces)
npm run build                                  # required — npm link resolves to dist/
npm link                                       # exposes the dir as @kodax-ai/kodax globally

# In your SDK consumer project (e.g. KodaX Space)
cd /path/to/my-host-app
npm link @kodax-ai/kodax                       # consume the linked checkout
```

After this, `import { ... } from '@kodax-ai/kodax/repl'` in your host
app resolves to `/path/to/KodaX/dist/sdk-repl.js`. Subsequent edits
inside KodaX require **re-running `npm run build`** — the link points
at the bundled output, not source.

### Tearing down the link

```bash
# In your SDK consumer project
npm unlink @kodax-ai/kodax       # restore the published version (npm install runs again)

# In KodaX
npm unlink -g @kodax-ai/kodax    # remove the global symlink
```

### Why root stays `"private": true`

The dev `package.json` carries `"private": true` so a bare `npm publish`
from the repo refuses — `scripts/release.mjs` is the only sanctioned
publish path, and it briefly toggles `private: false` (via try/finally)
just for the publish call. `"private"` does **not** block `npm link` —
it only gates `npm publish` — so the linked-build flow is unaffected.

### Alternative: tarball install

If you want a one-shot snapshot rather than a live symlink (e.g. for CI
or for a teammate without write access to the KodaX checkout):

```bash
# In KodaX
node scripts/release.mjs --pack-only           # produces kodax-ai-kodax-<v>.tgz

# In your host app
npm install /path/to/KodaX/kodax-ai-kodax-<version>.tgz
```

The tarball is byte-identical to what `npm publish` would ship, so it
exercises exactly the published shape.

---

## 8. User-authored agents — markdown loader + extension `registerAgent` (FEATURE_191, v0.7.43)

### Why this exists

KodaX's Self-Construction substrate (FEATURE_087-090 / 101) lets the
LLM author + admit constructed agents at runtime. FEATURE_191 closes
the loop for **human authors** and **SDK embedders**: ship an `<name>.md`
file under `~/.kodax/agents/` (user-level) or `<repo>/.kodax/agents/`
(project-level), or have an extension call `api.registerAgent(name, content)`
at activate time. All three paths feed the same admission pipeline as
the LLM-generation route and surface in the Worker SP's
`=== Available specialist agents ===` block.

### Markdown shape

```markdown
---
name: db-reviewer
description: Reviews DB migrations for safety and best practices
tools: [read, grep]
model: claude-sonnet-4-6
---
You are a DB migration reviewer. Focus on:
- Locking behavior under concurrent writes
- Default value backfill cost on large tables
```

`name` and `description` are required; missing/invalid `name` is a
silent skip (claudecode-compatible: treats the file as a reference doc).
`tools` accepts either a YAML array (`[read, grep]`) or a
comma-separated string (`"read, grep"`); each entry maps to
`builtin:<name>`. `mcpServers` / `hooks` / `memory` / `isolation` /
`permissionMode` / `maxTurns` / `skills` frontmatter fields are
silently ignored in v0.7.43 (forward-compat with future features).

Project agents (`<repo>/.kodax/agents/*.md`) shadow user-level agents
of the same name (last-write-wins).

### SDK API for extensions

```ts
// In an extension's activate function:
export default async function activate(api: KodaXExtensionAPI) {
  const dispose = await api.registerAgent('python-reviewer', {
    instructions: 'You review Python code for PEP-8 + type hints.',
    description: 'Python code reviewer (PEP-8 + type hints)',
    tools: [{ ref: 'builtin:read' }, { ref: 'builtin:grep' }],
  });

  // The returned dispose is auto-pushed onto the extension's
  // disposables list, so manual disposal is optional. Call it only
  // if you need to unregister the agent mid-session.
  return () => dispose();
}
```

`api.registerAgent(name, content)` throws on admission rejection with
the extension id + agent name + verdict reason — the embedder sees
failures at activate time rather than silently dropped registrations.

### Reading the agent registry (host code)

```ts
import {
  listConstructedAgents,
  resolveConstructedAgent,
} from '@kodax-ai/kodax';

// All registered constructed agents (markdown + extension + LLM + CLI).
const agents = listConstructedAgents();

// Resolve a specific agent by name.
const agent = resolveConstructedAgent('db-reviewer');
```

> **Source-aware variants** — `listConstructedAgentsWithSource()` /
> `resolveConstructedAgentSource(name)` expose the in-memory source
> tag (`'built-in' | 'extension' | 'markdown:user' | 'markdown:project'
> | 'constructed:cli' | 'constructed:llm'`). These are marked
> `@internal` in v0.7.43 and exposed only via the construction
> sub-barrel — they will be promoted to the top-level SDK entry when
> the v0.7.46+ REPL `/agents list` command lands as their third
> production consumer (current consumers: source-tag round-trip tests
> + planned REPL). Embedders that need provenance today can read the
> source via the existing `listConstructedAgents()` Agent shape and
> cross-reference their own registration calls.

### Wiring dispatch

Workers automatically see a registered agent through the SP block.
Programmatic dispatch (e.g. in `runKodaX` SDK consumers) goes through
the standard tool surface — pass `subagent_type` to
`dispatch_child_task`:

```ts
// Inside a tool handler or eval driver:
const result = await dispatchChildTask({
  id: 'child-1',
  objective: 'Review the migration in this PR',
  readOnly: true,
  subagent_type: 'db-reviewer',
});
```

Unknown `subagent_type` returns a tool-result error listing available
names (does NOT throw); write-capable specialists dispatched outside the
Worker path are rejected at the dispatch layer. Older V1 docs may phrase
this as "non-Worker/Generator"; Generator is historical after FEATURE_193.

### See also

- [docs/test-guides/FEATURE_191_v0.7.43_TEST_GUIDE.md](test-guides/FEATURE_191_v0.7.43_TEST_GUIDE.md) — manual test recipes
- [docs/features/v0.7.43.md FEATURE_191](features/v0.7.43.md#feature_191-user-authored-custom-agents--markdown-loader--extension-registeragent--dispatch_child_task-bridge) — design + acceptance gates
- [docs/ADR.md ADR-035](ADR.md#adr-035-user-authored-custom-agents--markdown-loader--extension-registeragent--dispatch_child_task-bridge-feature_191-v0743) — architectural rationale

---

## 9. Electron + `stdio: 'inherit'` on Windows — PowerShell input hijack

### Symptom

A host process (e.g. `scripts/dev.mjs`) spawns Electron with
`stdio: 'inherit'`. After Electron's main process starts up and loads
the KodaX SDK, the parent terminal (PowerShell, Windows Terminal,
cmd.exe) stops responding to keyboard input — characters don't echo,
Enter doesn't dispatch, Ctrl-C may not register.

### What's actually happening

This is **not caused by KodaX hooking stdin**. The SDK has no
module-level `process.stdin.on/setRawMode/resume/setEncoding` anywhere
in the published code path. We verified this empirically with the
following probe (Node 24, Windows, v0.7.43 dist):

| Probe step | stdin listeners delta | raw mode delta | signal listeners delta |
|---|---|---|---|
| `import('@kodax-ai/kodax')` (root) | 0 | none | 0 |
| `import('@kodax-ai/kodax/agent')` | 0 | none | 0 |
| `import('@kodax-ai/kodax/llm')` | 0 | none | 0 |
| `import('@kodax-ai/kodax/coding')` | 0 | none | 0 |
| `import('@kodax-ai/kodax/mcp')` | 0 | none | 0 |
| `import('@kodax-ai/kodax/session')` | 0 | none | 0 |
| `import('@kodax-ai/kodax/skills')` | 0 | none | 0 |
| `import('@kodax-ai/kodax/repl')` | 0 | none | 0 |
| `hydrateProcessEnvFromShell()` (Windows) | 0 (early return) | none | 0 |
| `loadConfig()` + `listMcpServers()` | 0 | none | 0 |

`hydrateProcessEnvFromShell()` on Windows specifically returns `false`
at [packages/repl/src/common/utils.ts](../packages/repl/src/common/utils.ts)
line 151 **before** any `spawnSync`. Even on non-Windows where the
spawn happens, it explicitly passes `stdio: ['ignore', 'pipe', 'pipe']`
— the child shell never sees the parent stdin.

The root cause is an Electron + Windows ConPTY interaction: spawning
an Electron child with `stdio: 'inherit'` from a Windows terminal
makes the child process inherit a live handle to the parent's input
stream. Even though nobody inside Electron's main process reads from
it, the open handle alters how PowerShell / Windows Terminal route
keystrokes — they cannot tell whether the upstream child has
"consumed" them. This is a known Windows console quirk independent
of any code Electron's main module runs.

### Canonical fix (host-side)

Detach Electron's stdin in the spawn config:

```js
// scripts/dev.mjs
import { spawn } from 'node:child_process';

const electron = spawn(electronBin, [appEntry], {
  stdio: ['ignore', 'inherit', 'inherit'], // ← stdin: 'ignore', NOT 'inherit'
  shell: false,
});
```

`stdio: ['ignore', 'inherit', 'inherit']` keeps stdout/stderr piped
to the host terminal for log visibility but prevents Electron from
holding the parent's stdin. PowerShell / Windows Terminal regain
full control of keyboard input. This is the canonical workaround
Electron itself documents (the `electron/dev-tools` examples ship
with this exact pattern).

### Why we don't ship a SDK-side mitigation

There is nothing the SDK can do to release a stdin handle it never
opened. Some hosts (CLI runners, headless servers) may legitimately
want to pipe data into the Electron main process via stdin; pre-emptively
closing or redirecting it from inside the SDK would break those.
The spawn-time decision belongs to the host.

### How to confirm whether your symptom matches this

Run [`scripts/probe-sdk-stdin.mjs`](../scripts/probe-sdk-stdin.mjs)
against your in-tree or installed SDK dist:

```bash
# In-tree (this repo):
node scripts/probe-sdk-stdin.mjs

# Against an installed @kodax-ai/kodax:
node scripts/probe-sdk-stdin.mjs ./node_modules/@kodax-ai/kodax/dist
```

The probe imports every SDK subpath and runs the Space startup sequence
(`hydrateProcessEnvFromShell` / typeof reads / `loadConfig` /
`listMcpServers` / provider snapshots), reporting stdin listener delta /
raw-mode delta / signal-handler delta at each step. If every step shows
"no state change ✓", the issue is in your spawn config — not in KodaX.
If any step shows a non-zero delta, file an issue with the probe output
and your Node / OS / SDK version.

---

## 10. Model capabilities — context window, reasoning, descriptors

### Why this exists

A popout-style UI typically wants to list every provider/model KodaX
supports, with at minimum `context window` and `reasoning capability`
shown next to each model — so the user can pick informed. Pre-v0.7.43,
this metadata lived inside each `Provider` class's `config` field and
was only readable via `provider.getContextWindow()` / `getModelDescriptor()`
on an instantiated Provider. `getProvider(name)` instantiates which
throws if the relevant API key env var is unset — meaning a UI couldn't
show "Anthropic Sonnet 4.6 / 200K context" until the user had set
`ANTHROPIC_API_KEY`. Capability metadata is **KodaX-maintained static
data** (we know what context windows the upstream models advertise),
so gating it on credentials is wrong.

v0.7.43 promoted this metadata into registry-layer snapshots and getters; the
current implementation backs `KODAX_PROVIDER_SNAPSHOTS` with
`provider-capabilities.json`. The getters still read without a provider
instance, API key, or env var.

### The new surface

All exports below come from `@kodax-ai/kodax/llm` (preferred) — also
re-exported through `@kodax-ai/kodax` (root), `@kodax-ai/kodax/coding`,
and `@kodax-ai/kodax/agent` for convenience.

```ts
import {
  // Built-in providers (anthropic / kimi / zhipu / deepseek / ark-coding / ...):
  getProviderModelDescriptors,           // (name) => KodaXModelDescriptor[]
  getModelCapabilities,                  // (name, model) => KodaXModelCapabilities | undefined
  listBuiltinModelCapabilities,          // () => KodaXModelCapabilities[]   (all built-ins, default-first per provider)

  // Custom providers (registered via `registerConfiguredCustomProviders`
  // from `~/.kodax/config.json#customProviders`):
  getCustomProviderModelDescriptors,     // (name) => KodaXModelDescriptor[] | undefined
  getCustomModelCapabilities,            // (name, model) => KodaXModelCapabilities | undefined
  listCustomProviderModelCapabilities,   // () => KodaXModelCapabilities[]

  // Unified dispatchers — built-in OR custom, transparent routing:
  resolveProviderModelDescriptors,       // (name) => KodaXModelDescriptor[]   (empty if unknown)
  resolveModelCapabilities,              // (name, model) => KodaXModelCapabilities | undefined
  listAllModelCapabilities,              // () => KodaXModelCapabilities[]   (built-in + custom merged)

  // Types:
  type KodaXModelCapabilities,
  type KodaXModelDescriptor,
} from '@kodax-ai/kodax/llm';
```

### Shape

```ts
interface KodaXModelCapabilities {
  provider: string;                 // 'anthropic' | 'kimi' | 'ark-coding' | <custom-name>
  model: string;                    // model id (e.g. 'claude-sonnet-4-6', 'kimi-k2.6')
  displayName: string;              // human label — falls back to model id
  supportsThinking: boolean;        // native reasoning is available?
  reasoningCapability: 'native-budget' | 'native-effort' | 'native-toggle' | 'prompt-only' | 'none' | 'unknown'; // legacy mechanism label
  reasoningProfile?: {
    defaultEffort?: string;
    supportedEfforts?: Array<{ value: string; isDefault?: boolean; isUserVisible?: boolean }>;
  };
  contextWindow?: number;           // input tokens (provider default + per-model override cascade)
  maxOutputTokens?: number;         // per-turn max_tokens KodaX requests — see note below
  thinkingBudgetCap?: number;       // tokens (native-budget providers only)
  isDefault: boolean;               // true for the provider's default model
}
```

### Recipes

**List every model KodaX supports (built-in + custom):**

```ts
import { listAllModelCapabilities } from '@kodax-ai/kodax/llm';

for (const caps of listAllModelCapabilities()) {
  console.log(`${caps.provider}/${caps.model}: ${caps.contextWindow ?? 'unknown'} tokens`);
}
```

**Look up a single model:**

```ts
import { resolveModelCapabilities } from '@kodax-ai/kodax/llm';

const caps = resolveModelCapabilities('kimi', 'kimi-k2.6');
// => { contextWindow: 256_000, supportsThinking: true, reasoningProfile: { defaultEffort: 'high', ... }, ... }
```

For picker/status UIs, use `reasoningProfile.supportedEfforts` and
`defaultEffort`. The legacy `reasoningCapability` field describes the provider
wire mechanism, not user-facing reasoning depth.

> **v0.7.58 fix — per-model overrides on a provider's DEFAULT model.**
> `resolveModelCapabilities(provider, model)` previously dropped a model's own
> `contextWindow` / `maxOutputTokens` / `reasoningProfile` override when that
> model happened to be the provider's default (e.g. `zhipu-coding` / `zai-coding`
> default to `glm-5.2`, which declares a 1M window — the resolver returned the
> 200K provider default). It now merges the `models[]` override regardless of
> default-model status, so `resolveModelCapabilities` agrees with the runtime
> `provider.getEffectiveContextWindow()` / `getEffectiveMaxOutputTokens()`.

### Resolving a wire-legal reasoning effort — `resolveWireEffort` (v0.7.58)

Mapping a user's desired reasoning strength to the actual wire `effort` value
means composing the model's profile with its alias / disabled / ceiling / default
rules AND any learned hard-rejections. `resolveWireEffort` (from
`@kodax-ai/kodax/llm`) is the single host-facing entry so you don't re-assemble
(and drift from) that logic:

```ts
import { resolveWireEffort } from '@kodax-ai/kodax/llm';

const { effort, adjusted } = resolveWireEffort({
  provider: 'zai-coding',
  model: 'glm-5.2',
  desiredEffort: 'low',   // GLM-5.2 aliases low → high
});
// effort === 'high', adjusted === true
```

`effort` is `undefined` when the model omits a wire effort (e.g. anthropic
adaptive) — send no `reasoning_effort` in that case; do **not** substitute a
value. Pass `rejectedEfforts` (e.g. from the agent layer's
`getCachedRejectedEfforts`) to fold learned rejections into the resolution.

### Reasoning-effort rejection is self-healing at the runtime layer (v0.7.58)

When a provider hard-rejects a `reasoning_effort` (400/422), the coding runtime
now **records** the rejection in the capability cache and **consults** it before
building each subsequent turn's request — so the same rejected effort is not
re-sent turn after turn. This happens whether or not a host wires
`events.onReasoningEffortRejected` (that event is still delivered for hosts that
want to surface it). Previously only the built-in REPL recorded rejections, so a
headless SDK host silently re-issued a failing request every turn.

### Passive effort capability learning

KodaX v0.7.57 treats `effort` as the primary reasoning-depth input. When a
provider hard-rejects a requested effort value, the SDK emits
`KodaXEvents.onReasoningEffortRejected` with provider/model/effort metadata.
The LLM layer owns the pure learning semantics (`narrowReasoningProfile` and
cache record helpers), while the agent layer provides the default
`~/.kodax/capability-cache.json` store (`recordRejectedEffort`,
`getCachedRejectedEfforts`, `clearCapabilityCache`). The built-in REPL is just
one consumer: it records the event through the agent store and narrows future
effort choices for the same provider/model.

Headless SDK hosts can use the same agent store, provide their own store around
the LLM pure helpers, or ignore the event for deterministic no-learning runs.
This keeps the mechanism reusable without forcing a cross-session disk cache on
every embedded runtime.

**Group by provider for a picker UI:**

```ts
import {
  KODAX_PROVIDER_SNAPSHOTS,
  resolveProviderModelDescriptors,
} from '@kodax-ai/kodax/llm';

for (const providerName of Object.keys(KODAX_PROVIDER_SNAPSHOTS)) {
  const descriptors = resolveProviderModelDescriptors(providerName);
  // descriptors[0] is the default model; descriptors.slice(1) are alternatives.
}
```

### A note on `maxOutputTokens`

`KodaXModelCapabilities.maxOutputTokens` is the **per-turn `max_tokens`
KodaX requests**, NOT the upstream "theoretical maximum". The two
diverge because:

- **What upstream advertises is often unreliable.** A 2026-05 probe
  against `zhipu-coding` / `kimi-code` / `minimax-coding` / `ark-coding`
  (Coding-Plan endpoint) / `deepseek` showed their `/v1/models`
  endpoints return only `{id, object, owned_by, created}` — no
  context-window, no max-output, no capabilities at all. Ark's
  pay-as-you-go `/v3/models` returns rich `token_limits` but none of
  the Coding-Plan models KodaX actually uses appear in that catalog.
  Even when upstream does advertise a number, stream behavior often
  deviates (the LLM stops early at unrelated stop conditions, or the
  server enforces a tighter kill window). Upstream `/models` data is
  not a substitute for KodaX-maintained metadata.
- **What KodaX requests is the trustworthy number.** Values in
  `KODAX_PROVIDER_SNAPSHOTS` are bench-validated against each provider
  (kill-windows, decode-rate, cost-per-turn predictability). Examples:
  - DeepSeek V4 *advertises* 384K max output; KodaX requests
    `KODAX_ESCALATED_MAX_OUTPUT_TOKENS` (~32K) per turn so streams
    finish under server-side timeouts. Long generation flows through
    the L5 continuation meta path instead.
  - `zhipu-coding` has a ~308s server-side kill window; KodaX caps at
    16K so typical tool_use turns complete within the window.

For a popout UI showing "expected output size for this model", use
the KodaX value (`caps.maxOutputTokens`). It's exactly what KodaX
asks the model for — i.e. the actual size budget your turn gets. If
you also want to expose the model's *theoretical* max output, that
comes from the upstream provider's own documentation; KodaX doesn't
certify that number because we don't request it.

### Why no instance methods touch this

The existing `provider.getContextWindow()` / `getEffectiveContextWindow()`
/ `getModelDescriptor()` instance methods still work — they're the
runtime path the agent loop itself uses. The new getters layer above
them at the **registry** layer so they don't need a Provider instance.
A consumer that has a configured Provider and wants effective values
in the four-step cascade (compactionConfig override → per-model →
provider default → 200K fallback) should still use
`resolveContextWindow(compactionConfig, provider, model)` from
`@kodax-ai/kodax/agent`. The new registry-layer getters are for the
*"list everything KodaX knows"* case — for picker UIs, comparison
tables, capability-aware routing.

### Confirming snapshot accuracy

Snapshot values are sourced from
[`packages/llm/src/providers/provider-capabilities.json`](../packages/llm/src/providers/provider-capabilities.json)
and loaded into the in-memory `KODAX_PROVIDER_SNAPSHOTS` export. When upstream
providers publish a new model or change a context-window cap, the JSON file is
the patch site — the new value flows to runtime (via `buildProviderConfig`) AND
to SDK consumers (via the getters) in a single edit. The current snapshot is
dated 2026-06-14 and includes the GPT-5.4, Kimi K2.7 Code, GLM-5.2, MiniMax
M3/M2.7, DeepSeek V4, and Doubao Seed 2.0 route refreshes where supported. The
test suite at
[`packages/llm/src/providers/model-capabilities.test.ts`](../packages/llm/src/providers/model-capabilities.test.ts)
locks in specific values (e.g. kimi-k2.6 at 256K, deepseek-v4-pro at 1M)
so accidental drift is caught at PR time.

The probe scripts that surveyed upstream APIs live at
[`scripts/probe-upstream-model-metadata.mjs`](../scripts/probe-upstream-model-metadata.mjs)
and [`scripts/probe-ark-tokens.mjs`](../scripts/probe-ark-tokens.mjs) —
re-run them periodically; if a provider starts returning richer model
metadata, we can promote the snapshot to derive from it.

---

## 11. Workflow process events and lifecycle controls (FEATURE_229, v0.7.50)

FEATURE_229 makes dynamic workflow progress a reusable SDK process surface
instead of terminal-only text. Hosts can observe and control workflows without
parsing `/workflow` output, replaying slash commands, or depending on Ink view
models.

Use the Agent subpath for neutral process types:

```ts
import type {
  WorkflowProcessEvent,
  WorkflowProcessSnapshot,
} from '@kodax-ai/kodax/agent';
```

Use the Coding subpath for workflow execution, process subscription, and
lifecycle control:

```ts
import {
  createWorkflowLifecycleController,
  createWorkflowRunManager,
  generateWorkflowFromOptions,
} from '@kodax-ai/kodax/coding';

const runManager = createWorkflowRunManager();
const unsubscribe = runManager.subscribeWorkflowProcess((event) => {
  renderWorkflowPanel(event.snapshot);
});

const controller = createWorkflowLifecycleController({
  runManager,
  runBaseDir: '.kodax/workflows/runs',
});

const generated = await generateWorkflowFromOptions({
  options,
  request: 'Review the payment flow',
});

if (generated.kind !== 'generated') throw new Error(generated.reason);

const runId = makeRunId();
const runDir = makeRunDir(runId);
const run = runManager.startFromOptions({
  module: generated.module,
  args: { request: 'Review the payment flow' },
  options,
  runId,
  runDir,
  scriptSnapshot: generated.scriptSnapshot,
  onWorkflowProcessEvent: (event) => auditWorkflow(event.snapshot),
});

await run.done;
const snapshot = controller.getWorkflowProcessSnapshot(runId);
const result = await controller.readWorkflowResult(runId);
```

`KodaXOptions.events.onWorkflowProcessEvent` receives the same events when a
host runs normal coding tasks that enter workflow mode. `WorkflowProcessSnapshot`
is intentionally ANSI-free and UI-neutral. It carries workflow status, phases,
child item status, result-bearing child summaries, provider/model routing hints,
and final `resultSummary`.

### Two ways to author a workflow (v0.7.58)

There are two host-facing ways to turn a natural-language request into a workflow
run — pick by whether you want the SDK to *orchestrate generation for you* or the
*Worker to investigate and author it itself*:

| | `generateWorkflowFromOptions` (shown above) | `authorWorkflowViaWorker` |
|---|---|---|
| Who authors | A context-**blind** one-shot LLM call (`tools:[]`) | The **Worker agent** — scouts the repo with its own tools, then authors + runs `run_workflow` (ADR-047 scout-then-author) |
| Host role | You call it, get a `module`, then `startFromOptions` | You submit one turn; the Worker does everything; you subscribe |
| Quality | Generic (no repo investigation) | Grounded (real paths / sub-problems / `outputSchema` baked into child prompts) |
| Use when | Non-interactive / CI / low-capability host, or you want to inspect the module before running | You want the same intelligence the REPL's `/workflow create` gets (recommended for interactive GUI hosts) |

`authorWorkflowViaWorker` is exactly what the REPL's `/workflow create` does
internally (elevate one turn to `agentMode:'amaw'` so the Worker has
`run_workflow`), exposed as a single call so a GUI host doesn't reimplement the
turn-submission glue:

```ts
import { authorWorkflowViaWorker } from '@kodax-ai/kodax/coding';

const { session, workflowRunId } = authorWorkflowViaWorker({
  request: 'Review the payment flow end-to-end and fix any bugs you find',
  options: {
    provider: 'anthropic',
    workflowRunsBaseDir: '<your app data>/workflow-runs', // REQUIRED — else run_workflow can't wire (throws)
    events: {
      // Numeric, UI-neutral progress — same surface as everything else in §11.
      onWorkflowProcessEvent: (event) => renderWorkflowPanel(event.snapshot),
    },
  },
});

// Resolves once the Worker actually launches a workflow (the run_workflow task),
// or `undefined` if it judged a workflow unnecessary and answered inline.
const runId = await workflowRunId;

// `session` is a normal RunningSession — await session.result, or session.abort().
await session.result;
```

Notes:
- `agentMode` is forced to `'amaw'` for the turn; the base `options.agentMode`
  is otherwise irrelevant here.
- `workflowRunsBaseDir` is **mandatory** for this call (it gates `ctx.workflowHost`
  → the `run_workflow` tool). Omitting it throws immediately rather than silently
  producing a Worker that can't author.
- The Worker retains judgment: for a request that doesn't warrant a multi-agent
  workflow it may just answer inline, in which case `workflowRunId` resolves
  `undefined`. There is no forced-tool guarantee (that would trade away the
  scout-then-author intelligence).

### Resume replay telemetry (v0.7.58)

When a workflow run resumes a prior run (`run_workflow`'s `resumeFromRunId`),
unchanged child agents replay instantly from the prior run's content-addressed
cache. Three read-only fields let a host render "resumed, N/M replayed from
cache" without changing any execution semantics:

- `WorkflowProcessSnapshot.resumedFromRunId?` — the prior run id this run resumed
  from (absent on a fresh run).
- `WorkflowProcessItem.origin?` — `'ran'` (executed live this run) or
  `'replayed-from-cache'` (returned from the prior run's cache). Populated only
  on resumed runs; on a fresh run every item omits it (treat absent as `'ran'`).
- `WorkflowProcessProgress.replayedAgents?` — count of replayed agents; present
  only when `> 0`. `spawnedAgents`/`finishedAgents` continue to count only agents
  that actually ran this turn.

All three are additive and absent on non-resumed runs, so existing renderers are
unaffected. A resumed agent item is emitted with `status:'completed'` (a replay
is instantaneous) and `origin:'replayed-from-cache'`.

### Timeout configuration

SDK hosts can configure user-facing timeout budgets with seconds-based fields:

```ts
const options = {
  provider: 'anthropic',
  timeouts: {
    workflow: {
      generationTimeoutSec: 300,
    },
    llm: {
      requestTimeoutSec: 900,
      streamIdleTimeoutSec: 0,
      chunkTimeoutSec: 45,
      maxRetryDelaySec: 90,
    },
  },
};
```

`timeouts.workflow.generationTimeoutSec` controls dynamic workflow harness
generation. It replaces the legacy millisecond-only environment override for
SDK callers while keeping `KODAX_WORKFLOW_GENERATION_TIMEOUT_MS` compatible.
`timeouts.llm.*Sec` is normalized by the LLM-layer helper
`resolveLlmTimeoutConfig()` from `@kodax-ai/kodax/llm`; the coding runtime then
adapts the resolved millisecond values into provider resilience settings. Use
the LLM helper directly when building a non-coding runner that still needs the
same request/stream timeout semantics.

The public timeout config intentionally does not control internal cleanup or
resource-protection watchdogs such as process kill probes, workflow stop
cleanup, VM smoke checks, or daemon readiness checks.

### Workflow run host attribution (v0.7.51)

Hosts that need to attach a workflow run back to an external session, surface,
or tab can stamp an opaque string map on the run:

```ts
const run = runManager.startFromOptions({
  module: generated.module,
  args: { request: 'Review the payment flow' },
  options,
  runId,
  runDir,
  scriptSnapshot: generated.scriptSnapshot,
  processMetadata: {
    source: 'sdk',
    hostMetadata: {
      sessionId: 'space-session-123',
      tag: 'coder',
    },
  },
});

runManager.subscribeWorkflowProcess((event) => {
  const owner = event.snapshot.hostMetadata;
  if (owner?.sessionId === 'space-session-123') {
    renderSessionWorkflow(event.snapshot);
  }
});
```

`hostMetadata` is host-owned and KodaX does not interpret its keys. It is
normalized as a small string-only map, persisted in `run.json`, and echoed on
live and restored `WorkflowProcessSnapshot` values. Unstamped runs return
`hostMetadata === undefined`; hosts should treat that as "no declared owner",
not infer ownership from session replay text.

### Live child-agent telemetry

F229 also preserves parent `KodaXEvents` callbacks for child-agent execution.
Treat these callbacks as live telemetry, not canonical assistant messages.
Tool callbacks, prompt callbacks, `onTextDelta`, `onThinkingDelta`,
`onThinkingEnd`, and `onStreamEnd` can receive optional trailing metadata.

The child-agent event bridge is intentionally an allow-list. KodaX does not
blindly clone the parent `KodaXEvents` object into child runs, because unscoped
callbacks such as compaction, retry history, session start, and parent
iteration start would otherwise mutate the parent host state. Child activity
callbacks carry child metadata; child `onIterationEnd` events that are surfaced
to a host are worker-scoped (`scope:'worker'`).

For workflow children, tool/progress/prompt callbacks can carry
`workflowCorrelation` metadata that identifies the workflow run, child agent,
and workflow item. Use that metadata to update a workflow panel or activity log.
Keep `WorkflowProcessEvent` / `WorkflowProcessSnapshot` as the durable source of
workflow state, summaries, terminal status, result reads, and artifact reads.
Async digest failures are still summary-bearing: hosts should render
`summaryStatus:'unavailable'` / `summaryKind:'digest-failed'` with the provided
bounded fallback summary instead of treating the child as silent.
KodaX gives async digest a longer best-effort window than blocking digest, so
late `agent_summary_updated` messages can arrive noticeably after the child
terminal event without restarting the workflow.

### Collecting a child's result inside a workflow script (declare `outputSchema`)

When a workflow script aggregates child agents into a synthesis step, read the
child's result from the **right field**. A `WorkflowTaskResult` (from
`wf.runAgent` / `wf.wait`) carries several fields that are NOT all populated at
the same instant:

| field | reliability at the moment `runAgent`/`wait` resolves |
|---|---|
| `structured` | **The reliable field.** Present + schema-validated (with one bounded, *awaited* repair turn) whenever the spawn declared an `outputSchema`. Resolved before the call returns. |
| `finalText` | Always a string, but **may be empty or a "Let me start…" preamble** if the child ended its turn on a `tool_use`/handoff rather than a closing text block. Do NOT treat it as guaranteed content. |
| `digest` / `digestPending` | The smart digest is delivered **asynchronously** via `agent_summary_updated` *after* the call resolves; at resolve time `digest` is usually absent and `digestPending` is `true`. It powers the live panel — it is NOT available to the script's return value. |

So a script that folds `finalText` straight into `wf.synthesize` can get **empty
findings even though the per-agent digest is visible in the panel** (the digest
arrived a moment later, asynchronously). The supported pattern:

```ts
const FINDING = {
  type: 'object', additionalProperties: false, required: ['finding'],
  properties: { finding: { type: 'string', description: 'Concrete findings with file:line evidence.' } },
};

const result = await wf.runAgent({ name: 'review:auth', prompt, readOnly: true, outputSchema: FINDING });
// Prefer the schema-validated structured finding; fall back to finalText only when non-empty.
const text =
  (result?.structured as { finding?: string } | undefined)?.finding?.trim()
  || (result?.finalText?.trim() ? result.finalText : '[no finding returned]');
```

Declare an `outputSchema` on every child whose result feeds a downstream step,
and read `result.structured`. `finalText` is a best-effort fallback, and the
async `digest` is for live UI only — never rely on it in the script's own control
flow. (The built-in `parallel-investigation` workflow follows exactly this
pattern as the reference.)

For normal `dispatch_child_task` children, hosts should render child activity
under the dispatch tool or a separate child-activity panel, while leaving the
main TodoList/plan visible. A good default is:

- show the main agent plan as the work contract;
- show child-agent tool/thinking/progress as bounded live-only activity;
- persist only the child final summary, explicit approvals/audit records, and
  the parent assistant's final answer in the user-visible conversation history.

Callbacks use optional trailing metadata so existing consumers remain
source-compatible:

```ts
events.onToolProgress = (update, meta) => {
  if (meta?.workflowCorrelation) {
    renderWorkflowToolProgress(meta.workflowCorrelation, update);
    return;
  }
  renderMainToolProgress(update);
};
```

Hosts that want full child transcripts should put them in an explicit debug or
trace drawer. Do not append raw child thinking/text/tool streams into the normal
conversation by default; it makes the parent assistant appear to have authored
every child step and can overwhelm users.

### Sidecar verifier actionable messages

`KodaXEvents.onSidecarMessage` fires when the Sidecar Verifier produces an
actionable `revise` or `blocked` verdict. `accept` remains silent because there
is no message to deliver.

```ts
events.onSidecarMessage = (event) => {
  if (event.delivery === 'synthetic-user-message') {
    renderAudit(`Sidecar asked the main agent to revise: ${event.content}`);
    return;
  }
  if (event.delivery === 'budget-exhausted') {
    renderTerminalBlock(`Sidecar requested a revision, but the reanimate budget is exhausted: ${event.content}`);
    return;
  }
  renderTerminalBlock(event.content);
};
```

The payload is:

```ts
interface KodaXSidecarMessageEvent {
  source: 'sidecar-verifier';
  verdict: 'revise' | 'blocked';
  recipient: 'main-agent' | 'user';
  delivery: 'synthetic-user-message' | 'budget-exhausted' | 'terminal-block';
  content: string;
  suggestedFix?: string;
  trace?: string;
}
```

For `revise`, `content` is the exact synthetic user message injected back into
the main agent. Treat it as sidecar-authored control text rather than a
user-authored chat turn. When `delivery` is `budget-exhausted`, that same
revise text was not injected because the runner is terminating instead. For
`blocked`, `content` is terminal user-facing text. Headless JSONL output emits
the same information as `{"type":"sidecar.message", ...}`.

The lifecycle controller also exposes terminal-run controls: stop, pause,
resume, artifact reads, delete, prune, display-name changes, saved-capsule
revision/replace provenance, and capsule preflight. Provenance fields such as
`source`, `sourceRunId`, `sourceWorkflowName`, `savedWorkflowName`, and
`revisionOf` let a host distinguish AMAW, `/workflow`, `/review --workflow`,
saved-name reruns, and capsule revisions while still consuming one process
contract.

### Generated harness validation

Generated workflow source is treated as a restricted harness, not as trusted
application code. `generateWorkflowFromOptions()` validates the source before a
run is launched, including wrapped JavaScript compilation, the generated
`async function run(wf, args)` contract, source-policy checks that ignore
strings/comments, and a no-effect smoke execution with a fake `wf`
implementation. Smoke validation catches common early harness defects such as
malformed `wf.runAgent` inputs, wrong `wf.wait` arguments, startup
`ReferenceError`, synchronous runaway startup code, and stalled startup awaits;
those errors feed the generator repair loop instead of creating a doomed
workflow run.

`preflightWorkflowCapsule()` also reports invalid restricted source as a
`workflow:source` error. Hosts should show that as a capsule/harness problem
before asking the user to approve a run. If a run still fails before launching
any child agents, render it as a generated harness or saved capsule failure,
not as a failed child-agent task. `/workflow rerun <runId>` repeats the saved
script snapshot; it does not regenerate a broken generated harness.

Layer boundary:

- `@kodax-ai/kodax/agent` owns neutral workflow process/event/status types.
- `@kodax-ai/kodax/coding` owns the coding backend, generated/saved workflow
  execution, run graph, host policy, lifecycle controller, result/artifact
  reads, and retention.
- `@kodax-ai/kodax/repl` renders snapshots; it is not required for SDK workflow
  execution or progress UI.

---

## 12. Provider credential verification — `verifyProviderCredential` (FEATURE_216, v0.7.45)

### Why

The original SDK exposed `provider.isConfigured()` (env-only check) and the full streaming surface (`provider.stream()` / `sideQuery()`). Neither fits the "test connection" UI use case: env check doesn't validate the key actually works against the upstream; streaming costs ~50–200 tokens and several seconds. KodaX Space (and any third-party SDK consumer building a provider-settings UI) needs a lightweight server-validated check.

FEATURE_216 ships **`verifyProviderCredential(name, opts?)`** — never-throws, lightweight, per-provider-strategy.

### Quick start

```typescript
import { verifyProviderCredential } from '@kodax-ai/kodax/llm';

const result = await verifyProviderCredential('zhipu-coding', { timeoutMs: 8000 });

if (result.ok) {
  // Key works. result.durationMs is wall-clock; result.approxTokensSpent
  // is 0 for count-tokens/models-list strategies, ~6-7 for minimal-message.
  console.log(`✓ Verified in ${result.durationMs}ms (${result.approxTokensSpent} tokens)`);
} else {
  switch (result.error) {
    case 'unauthorized':  /* show "invalid key — auth failed" (covers 401/403 + kimi-code 400 special) */ break;
    case 'unconfigured':  /* env var not set */ break;
    case 'network':       /* show "check network" (DNS/conn/socket errors) */ break;
    case 'timeout':       /* upstream didn't respond in time */ break;
    case 'server_error':  /* upstream 5xx; transient */ break;
    case 'rate_limited':  /* 429 — key is valid but throttled; suggest retry */ break;
    case 'unsupported':   /* cli-bridge provider or unknown name */ break;
    case 'unknown':       /* unexpected; surface result.message */ break;
  }
}
```

### Guarantees

- **Never throws** — every failure mode is captured in the returned `KodaXVerifyCredentialResult` envelope. Mirrors the `side-query.ts` pattern. Guarantee holds even for runtime-registered providers whose `verifyCredential()` override might throw (legacy 3rd-party extensions that predate FEATURE_216): the top-level helper wraps the call in try/catch and returns `error: 'unknown'`.
- **No ctor throw on missing env** — the helper short-circuits to `error: 'unconfigured'` BEFORE attempting to instantiate the provider class (which would call `getApiKey()` and throw).
- **Lightweight** — 9 of the 12 verifiable providers run a **zero-token** primitive; the remaining 3 cost ~6–7 tokens per call (~$0.00001 at typical rates).
- **Cancellable** — pass `opts.signal` (any `AbortSignal`); the helper distinguishes timeout vs parent-abort in the result.
- **Key redaction** — `result.message` redacts `sk-...` patterns before being surfaced, so an upstream error body that echoes the submitted key won't leak the fragment into a UI log or display.

### How the strategy is chosen

Each provider has one `verifyStrategy` value baked into `provider-capabilities.json`. Three primitives, picked per-provider empirically:

| Strategy | What runs | Cost | Used by built-ins |
|---|---|---|---|
| `count-tokens` | `client.messages.countTokens({ messages: [{role:'user',content:'hi'}] })` | 0 token | `anthropic`, `zhipu-coding`, `kimi-code`, `minimax-coding`, `ark-coding` |
| `models-list` | `client.models.list()` | 0 token | `openai`, `deepseek`, `kimi`, `qwen` |
| `minimal-message` | `chat.completions.create({max_tokens:1, content:'hi'})` (or Anthropic equivalent) | ~6–7 token | `zhipu`, `mimo`, `mimo-coding` |
| `unsupported` | nothing — short-circuits | — | `gemini-cli`, `codex-cli` (cli-bridge: credentials live in CLI binary) |

`models-list` is NOT used as a universal default because (a) some providers' `/v1/models` is publicly accessible (so a bad key returns 200 — false positive), and (b) some compat layers don't implement it (404) or 401 even for valid keys (false negative). The 2026-05-28 provider probe matrix captured these empirically (12 providers at the time; 15 built-in aliases as of 2026-06-28); opencode's `setup-recording-env.ts` makes the same per-provider decision across its 20+ providers.

### Custom providers

Custom providers (`registerCustomProviders` / `~/.kodax/config.json`) inherit the verify primitive from their base class. The strategy default is derived from `protocol`:

- `protocol: 'anthropic'` → defaults to `count-tokens`
- `protocol: 'openai'` → defaults to `models-list`

Override with explicit `verifyStrategy` when the upstream needs a different primitive (e.g. an openai-compat gateway whose `/v1/models` is public — set `verifyStrategy: 'minimal-message'`):

```typescript
registerCustomProviders([{
  name: 'my-gateway',
  protocol: 'openai',
  baseUrl: 'https://api.example.com/v1',
  apiKeyEnv: 'MY_GATEWAY_KEY',
  model: 'gpt-4-mini',
  verifyStrategy: 'minimal-message',  // optional override
}]);
```

The validator rejects illegal combinations:
- `protocol: 'openai'` + `verifyStrategy: 'count-tokens'` → throws (OpenAI protocol has no count_tokens endpoint).

### Model listing — `listProviderModels(name)`

Separate API for "model picker" UIs. Returns the static model list KodaX maintains in `provider-capabilities.json` (or the custom provider's `models` field). Always `source: 'static'` in v0.7.45 — KodaX's curated list is more reliable than upstream `/v1/models` (which is noisy, includes deprecated entries, or — in zhipu's case — is publicly served regardless of auth).

```typescript
import { listProviderModels } from '@kodax-ai/kodax/llm';

const r = await listProviderModels('ark-coding');
if (r.ok) {
  // r.models is e.g. ['glm-5.1', 'glm-4.7', 'kimi-k2.6', ...]
  // r.source is 'static'; durationMs is 0 (no wire call)
  showModelPicker(r.models);
}
```

Cli-bridge providers (`gemini-cli`, `codex-cli`) return their CLI binary's known model list — filled at SDK load via `cli-bridge-models.ts`.

### Reference

- Source: `packages/llm/src/providers/verify-credential.ts` (orchestrator + classifier) + `verify-credential.test.ts` (19 unit tests) + `verify-credential-integration.test.ts` (10 real-key tests, gated on `KODAX_INTEGRATION_TEST=1`).
- Data: `packages/llm/src/providers/provider-capabilities.json` `verifyStrategy` field per provider.
- Design notes + probe matrix: [docs/features/v0.7.45.md FEATURE_216](features/v0.7.45.md#feature_216-provider-credential-verification-api).

---

## 13. Inject your product's manual — `selfManual` (FEATURE_221, v0.7.47)

### Why

KodaX has a built-in self-knowledge manual + a read-only `kodax_manual` tool: when a user asks how to use / configure / troubleshoot KodaX, the model looks it up instead of guessing (and instead of mixing in Claude Code / Codex knowledge). If you embed KodaX in your own product (say **KodaX-Space**), your users ask about **your product** — and by default they'd get KodaX's internal manual. `selfManual` lets you inject your product's manual so those questions are answered correctly and on-brand.

### Shape

```ts
import { runKodaX, type KodaXManualTopicInput } from '@kodax-ai/coding';

const SPACE_TOPICS: KodaXManualTopicInput[] = [
  { id: 'overview',  title: 'KodaX-Space', summary: 'What KodaX-Space is.', body: 'A desktop coding app built on KodaX.' },
  { id: 'settings',  title: 'KodaX-Space Settings', summary: 'Configure KodaX-Space.', body: 'Open Settings → Providers …', aliases: ['配置'] },
];

runKodaX({
  /* …your usual config… */
  selfManual: {
    productName: 'KodaX-Space',   // re-brands the routing rule + every answer's scope anchor
    topics: SPACE_TOPICS,         // extend the KodaX base; same id overrides a base topic
  },
});
```

### Semantics

- **Extend, not replace.** Your topics are merged on top of KodaX's base topics (same `id` overrides, new `id` adds). So a KodaX-Space user can ask about KodaX-Space *and* about the underlying provider/config (KodaX base topics).
- **`productName` re-brands the prose**, not the tool. The routing rule and each answer's anti-confusion anchor say your product name; the tool stays `kodax_manual` (the model doesn't care about the tool name).
- **Still tool-on-demand + bounded.** Nothing big is injected into the prompt — only the ≤250-token routing rule. Topics live in the registry and are returned one at a time when the model calls the tool, each capped at 4 KB. Drift-guarding your own topics (e.g. not referencing a removed setting) is your responsibility.

### White-labeling further — `baseTopics` (v0.7.58, FEATURE_221)

By default your `topics` **extend** the KodaX base manual. v0.7.58 adds
`selfManual.baseTopics` to control which base topics are present underneath:

- **omit** — all base topics (default; byte-identical to pre-v0.7.58).
- **`[]`** — none: a full white-label replace where only your topics exist, so the
  model never surfaces a KodaX-branded mechanism topic.
- **explicit subset** — seed only the base topic ids you name.

`KODAX_UNDERLYING_CAPABILITY_TOPICS` (exported) is the recommended mechanism-topic
subset a product built on KodaX should keep even in a full replace — so your users
still get correct answers about the underlying engine (providers / config /
permissions / tools / skills / extensions / mcp / repo-intelligence / sessions /
sdk / custom-providers) without the KodaX brand:

The default full manual also includes the `memory` topic. It is intentionally
not part of `KODAX_UNDERLYING_CAPABILITY_TOPICS` because `/experimental-memory`
is opt-in; hosts that expose it should add `memory` explicitly or provide a
product-specific override.

```ts
import {
  runKodaX,
  KODAX_UNDERLYING_CAPABILITY_TOPICS,
  MANUAL_REGISTRY,
} from '@kodax-ai/coding';

runKodaX({
  selfManual: {
    productName: 'KodaX-Space',
    topics: SPACE_TOPICS,
    baseTopics: [...KODAX_UNDERLYING_CAPABILITY_TOPICS], // keep engine topics, drop KodaX-branded ones
  },
});
```

`MANUAL_REGISTRY` (exported, keyed by `KodaXManualTopicId`) lets you read the base
topic bodies at build time — e.g. to re-word them under your own brand.

### Topic shape (`KodaXManualTopicInput`)

`{ id, title, summary, body }` required; `aliases?`, `nextTopics?`, `sources?` optional. Keep `body` short (a few lines) — it is a bounded on-demand answer, not a document.

### Reference

- Types/exports: `KodaXManualTopicInput`, `KodaXSelfManualConfig`, `ResolveKodaXManualOptions`, `buildSelfKnowledgeRoutingRule` from `@kodax-ai/coding`.
- Design: [docs/features/v0.7.47.md FEATURE_221](features/v0.7.47.md#feature_221-injectable-self-manual-for-sdk-consumers).

---

## 14. Media input artifacts — `@kodax-ai/kodax/media` (FEATURE_239, v0.7.56)

### Why

Host apps such as KodaX Space own paste/drop UI, sandbox storage, and path
authorization, but they should not import REPL-private files to normalize images
or construct `runKodaX` artifacts. `@kodax-ai/kodax/media` is backed by the
agent-layer `@kodax-ai/agent/media` implementation in v0.7.57, because input
artifacts are an agent capability rather than a coding-only concept.
`@kodax-ai/coding/media` remains as a compatibility re-export for existing
source consumers.

### Quick start

```ts
import {
  createFileArtifactFromPath,
  createImageArtifactFromPath,
  createVideoArtifactFromPath,
  enqueueWithArtifacts,
  getModelInputCapabilities,
  readAndNormalizeClipboardImage,
  validateInputArtifactsForModel,
} from '@kodax-ai/kodax/media';

const image = await readAndNormalizeClipboardImage();
if (!image) {
  // Clipboard did not provide a native image fallback. Continue normal text paste.
  return;
}

const stored = await spaceImageStore.write({
  bytes: image.buffer,
  mediaType: image.mediaType,
});

const artifact = createImageArtifactFromPath(stored.path, {
  mediaType: image.mediaType,
  source: 'clipboard',
  description: 'Clipboard image',
});

validateInputArtifactsForModel([artifact], {
  provider: selectedProvider,
  model: selectedModel,
});

// Pass the artifacts through `runKodaX` (or the `KodaXClient` constructor) —
// `context.inputArtifacts` is the public entry point. `KodaXClient.send`
// takes only a prompt string, so per-call artifacts go through `runKodaX`.
import { runKodaX } from '@kodax-ai/kodax/coding';

await runKodaX(
  {
    provider: selectedProvider,
    model: selectedModel,
    context: { inputArtifacts: [artifact] },
  },
  promptText,
);
```

### Capability query

Use provider and model together. The same model name behind a gateway route is
not assumed to support media unless that route is verified.

```ts
const caps = getModelInputCapabilities({
  provider: 'minimax-coding',
  model: 'MiniMax-M3',
});

if (caps.image.sdkSupported) {
  enableImageDropZone();
}

if (caps.video.status === 'provider-native-unwired') {
  showVideoComingSoonCopy();
}
```

v0.7.57 can send image artifacts. File and video artifact shapes are stable, but
the SDK runtime does not serialize them yet. Known native-video models report
`video.status = 'provider-native-unwired'` so hosts can show accurate UI without
enabling a send path KodaX cannot serialize yet.

### Artifact contract

`KodaXInputArtifact` is a stable union:

```ts
type KodaXInputArtifact =
  | { kind: 'image'; path: string; mediaType?: KodaXImageMediaType; source?: KodaXInputArtifactSource; description?: string }
  | { kind: 'file'; path: string; mediaType?: string; mimeType?: string; name?: string; source?: KodaXInputArtifactSource; description?: string }
  | { kind: 'video'; path: string; mediaType: KodaXVideoMediaType; name?: string; source?: KodaXInputArtifactSource; description?: string };
```

Use `createFileArtifactFromPath()` for stable file metadata and
`createVideoArtifactFromPath()` when a video path has a supported media type
(`mp4`, `mpeg`, `mov`, `avi`, `flv`, `webm`, `wmv`, `3gp`). Video construction
throws `KodaXMediaError('UNSUPPORTED_MEDIA_TYPE')` if the type cannot be
inferred or supplied.

### File/video downgrade strategy

`getModelInputCapabilities()` distinguishes native provider support from SDK
runtime support:

- `image.status === 'supported'`: SDK can send image artifacts.
- `video.status === 'provider-native-unwired'`: the selected provider/model is
  native-video capable, but KodaX SDK does not serialize video artifacts yet.
- `file.status === 'unsupported'`: file artifacts are contract-stable, but KodaX
  SDK does not upload or extract files yet.

`validateInputArtifactsForModel()` enforces that policy before provider send.
Hosts should use the thrown `KodaXMediaError.code` and `detail` to disable send
or show downgrade UI. If Space wants to support files before SDK runtime wiring,
Space should perform its own extraction and include the extracted text in the
prompt rather than passing the file artifact through as sendable media.

### Queued follow-ups with artifacts

For streaming follow-ups, use `enqueueWithArtifacts()` instead of the raw
message queue:

```ts
enqueueWithArtifacts({
  provider: selectedProvider,
  model: selectedModel,
  content: followupText,
  inputArtifacts: [artifact],
});
```

The helper validates first and then stores `inputArtifacts` on the queued prompt.
Queued image follow-ups are rebuilt as multimodal content blocks on the next
runner turn. Unsupported file/video attachments are rejected before enqueueing.

### Boundaries

- `readAndNormalizeClipboardImage()` returns `null` when there is no clipboard
  image fallback; thrown `KodaXMediaError` values are stable enough for host copy.
- Direct image path artifacts preserve `image/png`, `image/jpeg`, `image/webp`,
  and `image/gif`; clipboard normalization emits static PNG/JPEG bytes and may
  flatten animated GIFs before artifact creation. `image/gif` capability means
  SDK can pass the bytes and media type; provider animation semantics vary
  (for example, first-frame-only or non-animated GIF handling).
- `persistImageAsBlock()` is a convenience helper. Embedded hosts should usually
  pass `directory` or store bytes in their own sandbox before constructing an
  artifact path.
- `validateInputArtifactsForModel()` is pure shape/model validation. It does not
  probe host-owned sandbox paths.

### Reference

- Public SDK entry: `src/sdk-media.ts`.
- Shared implementation: `packages/agent/src/media/`.
- Compatibility source re-export: `packages/coding/src/media/`.
- Design: [docs/features/v0.7.56.md FEATURE_239](features/v0.7.56.md#feature_239-sdk-multimodal-input--clipboard-image-public-api).

---

## 15. Space v0.7.57 follow-up ledger

These are the remaining SDK-consumer integration decisions reported after the
v0.7.57 source review. They are not all KodaX core regressions; most are Space
UI/API follow-ups that should consume the SDK contracts already exposed here.

- **Custom provider reasoning form**: Space should expose the v0.7.57 custom
  provider shape `reasoning: { efforts, default }` or `"none"` instead of only
  legacy reasoning-mode inputs. Keep using the SDK validator from
  `@kodax-ai/kodax/llm` so Space does not maintain a parallel schema.
- **Effort selector**: Space should build effort choices from
  `resolveModelCapabilities(provider, model)?.reasoningProfile.supportedEfforts`
  and `defaultEffort`. A fixed five-option selector will miss provider-specific
  values such as `xhigh`, `max`, or custom-provider effort names.
- **Repo-intelligence prewarm**: `prewarmRepoIntelligenceCaches()` is currently a
  best-effort warmup call, not a progress/completion contract. Hosts can call it
  opportunistically; if Space needs visible progress or a completed state, the
  next SDK step should be a small handle/result API rather than inferring status
  from cache side effects.
- **Relationship scan**: `relationship_scan` is a v0.7.57 agent/tool capability.
  It is intentionally model-facing today. Space can decide separately whether it
  deserves a top-level UI entry or remains available through normal agent turns.
- **Quick Ask / `sideQuery`**: `sideQuery` is exported from
  `@kodax-ai/kodax/llm`, so the capability ledger can move from blocked to
  partial. Migrating Space Quick Ask still needs an application-level decision
  about transcript promotion and history semantics, because `sideQuery` is an
  isolated text-only one-shot call rather than a chat-session append.

---

## 16. SDK agent-profile surface — `KodaXAgentProfile` (FEATURE_247, v0.7.58)

### Why

An SDK embedder (e.g. **KodaX-Space Partner**) often needs to run KodaX under a
named product persona — its own identity + instructions, a narrowed tool surface,
and a default verification standard — without forking the agent. `KodaXAgentProfile`
provides this as one **opaque, profile-gated** object on `options.context`. With no
`agentProfile` set the default Coding Agent is **byte-identical**; every path below
is a no-op.

### Shape

```ts
runKodaX({
  /* …your usual config… */
  context: {
    agentProfile: {
      surface: 'partner',            // opaque label ('code' | 'partner' | …)
      name: 'KodaX-Space Partner',   // opaque display name
      instructions: '…house rules injected into the AMA/AMAW Worker role prompt…',
      verification: { /* KodaXTaskVerificationContract — profile-default standard */ },
    },
    // R2 — narrow the model-visible tool list (applied on top of excludeTools):
    toolVisibilityPolicy: (tool) => tool !== 'web_search',
  },
});
```

### What each field / companion gates

- **R1 — identity + instructions.** `agentProfile.instructions` is prepended to the
  AMA/AMAW Worker role prompt; the SA path uses `context.systemPromptOverride`
  (mapped from `instructions` by `startKodaX`), so a profile behaves consistently
  across both execution modes.
- **R2 — `context.toolVisibilityPolicy`.** A predicate applied when the
  model-visible tool list is built (in addition to `excludeTools`); tools it returns
  `false` for are hidden from the model.
- **R3 — `agentProfile.verification`.** A profile-default `KodaXTaskVerificationContract`
  merged with per-task `context.taskVerification` (per-task fields win) before it
  reaches the Sidecar Verifier; each verdict is attributed to the profile.
- **R4 — `KodaXEvents.onEffectiveConfig`.** Reports the effective agentMode / tool
  scope / verification / resolved verifier at run start, so a host can reflect what
  the profile actually resolved to.
- **R5 — metadata across `fork()`.** Structured `profile` + `runtimeInfo` metadata
  ride on results and are inherited by forked sessions.
- **R6 — `compactSession(id, options)`** from `@kodax-ai/kodax/session` — an
  imperative session compaction the host can trigger directly.
- **R7 / R8 — attribution.** Session / profile / toolCall attribution is threaded
  into the tool execution context and onto inline-workflow process events + AMA tool
  events.
- **R9 — `reads-network` side-effect class** (`isToolNetworkRead`) tags read-only
  network tools (`web_search`, MCP read / prompt) so a profile can allow network
  reads without granting mutation.

### Reference

- Types: `KodaXAgentProfile`, `KodaXToolVisibilityPolicy`, `KodaXEffectiveTaskConfig`
  from `@kodax-ai/coding`; `compactSession` from `@kodax-ai/kodax/session`.
- Design: [docs/features/v0.7.58.md](features/v0.7.58.md) FEATURE_247.

---

## 17. Runtime SDK, Worker isolation, and local daemon (FEATURE_253-FEATURE_257)

`@kodax-ai/kodax/runtime` is the stable host-facing runtime facade for
applications that want KodaX as a substrate instead of only as a terminal CLI.
It wraps the same coding/session engine used by the REPL and exposes it through
one interface in three deployment shapes:

- **embedded / inline**: in-process runtime owned by the caller;
- **embedded / worker**: private caller-owned runtime in a disposable V8 Worker;
- **daemon**: local-only runtime owner reached through a named pipe on Windows or
  a Unix domain socket on Linux/macOS.

The daemon is not a separate product engine. It hosts the embedded runtime behind
a process boundary, so REPL, Space, IDE adapters, ACP, and custom SDK clients can
share the same profile runtime without reimplementing sessions, permissions,
events, config, MCP, catalogs, artifacts, or diagnostics.

### Which shape to use

| Host scenario | Recommended shape | Why |
|---|---|---|
| Unit tests, one-off scripts, short-lived SDK tools | `createKodaXRuntime()` | No daemon lifecycle; easiest cleanup. |
| A single app owns all KodaX state in one process | `createKodaXRuntime({ mode: 'embedded' })` | Direct in-process calls and no IPC. |
| A single app needs private state plus hard V8 disposal | `createKodaXRuntime({ mode: 'embedded', isolation: 'worker' })` | Same services over MessagePort; `close()` escalates to Worker termination. |
| REPL + Space + IDE should share sessions/status/permissions | `createKodaXRuntime({ mode: 'daemon' })` | Starts or reuses the local profile daemon. |
| Attach to an already-started daemon only | `connectKodaXRuntime({ profile, homeDir })` | Attach-only by default; fails if no daemon is ready. |
| Test/CI isolated daemon namespace | pass `homeDir` and `profile` | Keeps state/config/sessions out of the user's home daemon. |

### Public construction contract

Import the Runtime facade from the dedicated subpath:

```ts
import {
  createKodaXRuntime,
  connectKodaXRuntime,
  type CreateKodaXRuntimeOptions,
  type KodaXRuntime,
} from '@kodax-ai/kodax/runtime';
```

The important creation options are:

| Option | Default | Contract |
|---|---|---|
| `mode` | `'embedded'` | Chooses private ownership or a shared daemon process. |
| `isolation` | `'inline'` | Embedded-only. `'worker'` creates a private Runtime Worker; daemon rejects any explicit isolation because it is already process-isolated. |
| `worker.resourceLimits` | unset | Optional V8 heap/stack limits; requires `isolation: 'worker'`. |
| `worker.shutdownTimeoutMs` | `2000` | Grace before the parent terminates the Runtime Worker. |
| `requirements.hardDispose` | `false` | Rejects inline and daemon forms; prevents an accidental weaker ownership form. |
| `homeDir` | OS user home | Root for `.kodax` config/state and default sessions. Use a private value in tests. |
| `profile` | `'default'` | Daemon uniqueness and runtime configuration namespace. |
| `sessionsDir` | `<homeDir>/.kodax/sessions` | Explicit session storage override. |
| `daemonStartupTimeoutMs` | `60000` | Total cold-start/concurrent-owner wait budget. |
| `daemonConnectTimeoutMs` | `2000` | Per-socket connection timeout. |
| `autoStartDaemon` | conditional | For `createKodaXRuntime({mode:'daemon'})`, true only when no explicit endpoint/transport is supplied. |
| `externalAgents` | unset | Host-installed executor factories, dispatch policy, optional credential/artifact policies, and default dispatch context. Inline owner only; see §18. |
| `requirements.externalAgents` | `false` | Reject a Runtime/daemon connection that does not advertise an installed external-agent plane. |

KodaX rejects contradictory options. Worker settings without Worker isolation,
`requirements.hardDispose` on inline/daemon forms, and any explicit isolation
on daemon mode are errors. Options are never silently ignored to select a
weaker isolation form.

### Basic embedded usage

```ts
import { createKodaXRuntime } from '@kodax-ai/kodax/runtime';

const runtime = await createKodaXRuntime({
  mode: 'embedded',
  homeDir: '/tmp/my-host-kodax',
  defaultProvider: 'zai-coding',
});

try {
  const session = await runtime.sessions.create({
    title: 'SDK embedded session',
    projectPath: process.cwd(),
    surface: 'my-host',
  });
  const handle = await runtime.runs.start({
    sessionId: session.id,
    prompt: 'Read package.json and summarize this project.',
  });
  const result = await handle.result;
  console.log(result.phase);
} finally {
  await runtime.close();
}
```

### Basic daemon usage

```ts
import { createKodaXRuntime, connectKodaXRuntime } from '@kodax-ai/kodax/runtime';

const replLikeClient = await createKodaXRuntime({
  mode: 'daemon',
  profile: 'default',
  clientInfo: { name: 'my-repl', title: 'My REPL', version: '1.0.0' },
  capabilities: {
    richEvents: true,
    permissionPrompts: true,
    contextDiagnostics: true,
  },
});

const spaceLikeClient = await connectKodaXRuntime({
  profile: 'default',
  clientInfo: { name: 'my-space', title: 'My Space', version: '1.0.0' },
  capabilities: {
    richEvents: true,
    permissionPrompts: true,
    contextDiagnostics: true,
  },
});

try {
  console.log(replLikeClient.identity.runtimeId === spaceLikeClient.identity.runtimeId);
} finally {
  await spaceLikeClient.close();
  await replLikeClient.close();
}
```

`createKodaXRuntime({ mode: 'daemon' })` is the high-level convenience API: when
no explicit `daemonEndpoint` or `daemonTransport` is supplied it starts or reuses
the local profile daemon. `connectKodaXRuntime()` is attach-only unless
`autoStart: true` is passed.

SDK auto-start allows `daemonStartupTimeoutMs` (default 60 seconds) and
`daemonConnectTimeoutMs`. The longer startup budget covers cold machines and
concurrent test/desktop startup without weakening PID, endpoint, token, or
runtime-identity validation.

### Worker-hosted embedded usage

```ts
import { createKodaXRuntime } from '@kodax-ai/kodax/runtime';

const runtime = await createKodaXRuntime({
  mode: 'embedded',
  isolation: 'worker',
  worker: {
    resourceLimits: { maxOldGenerationSizeMb: 1024 },
    shutdownTimeoutMs: 2000,
  },
});

try {
  console.log(runtime.identity.isolation);      // 'worker'
  console.log(runtime.identity.workerThreadId); // Node Worker thread id
  // runtime.sessions/runs/events/... are identical to inline and daemon.
} finally {
  await runtime.close();
}
```

`mode` describes ownership and sharing; `isolation` describes where a private
embedded owner executes. Inline is the lowest-latency default. Worker is useful
for Electron/Space-style hosts that need private state and deterministic V8
disposal. Daemon is for durable multi-client sharing and already uses an OS
process, so daemon + worker is rejected.

Worker `resourceLimits` bound parts of the V8 heap only. They do not cover every
kind of native/external memory and do not make Node code safe to treat as
untrusted. Worker isolation is a fault boundary, not a security sandbox.

Callers that cannot accept a silent fallback can require the capability:

```ts
await createKodaXRuntime({
  mode: 'embedded',
  isolation: 'worker',
  requirements: { hardDispose: true },
});
```

Daemon hosts advertise `hardDispose: false`; Worker hosts advertise true.

### Close, abort, and ownership semantics

The same method name deliberately has deployment-specific ownership effects:

| Form | `runtime.close()` | Run abort | After owner crash/termination |
|---|---|---|---|
| embedded / inline | Cancels owned runs and permissions and closes private runtime state. It cannot recover a host event loop blocked by arbitrary inline code. | `runs.abort(runId)` settles the Runtime handle and forwards cancellation to coding. | The embedding process owns recovery. |
| embedded / Worker | Requests shutdown, waits up to `shutdownTimeoutMs`, then always terminates the Worker. | Same Runtime abort API; closing the Runtime is the hard-disposal escalation for the whole isolate. | Pending transport requests reject; create a new Runtime explicitly. |
| daemon client | Detaches only this client transport. Other REPL/Space/SDK clients and runs remain owned by the daemon. | Aborts only the addressed run. | The client connection rejects; reconnect explicitly after the daemon is healthy. |

`close()` is idempotent. It is not a shared-daemon stop command. Use
`kodax daemon stop`, `kodax daemon restart`, or an authenticated low-level
`runtime.shutdown` request for administrative shutdown. KodaX does not
automatically retry or replay an in-flight run after a Worker/daemon owner dies,
because provider and tool side effects may already have happened.

### Daemon ownership and state

Daemon ownership is scoped by `homeDir + profile`.

- Default `homeDir` is the OS user home directory.
- Default `profile` is `default`.
- State lives under `.kodax/runtime/daemon/{profile}/`.
- Default runtime session storage is also scoped under `<homeDir>/.kodax/sessions`
  when `sessionsDir` is omitted.
- Windows uses a named pipe; Linux/macOS use a Unix domain socket.
- The daemon opens no public TCP listener.

For a given profile, one owner wins an atomic lock. Concurrent starters wait for
the winner and connect once it is ready. Stale state is cleaned only after pid,
endpoint, token, and runtime identity checks. If ownership cannot be verified,
KodaX reports the daemon as unhealthy instead of killing an arbitrary process.
SDK auto-start launches a detached `kodax daemon serve` process; it never treats
an in-process socket listener as daemon mode. Closing the SDK client detaches
without stopping that shared process. Use `kodax daemon stop` or the explicit
runtime shutdown protocol to stop the owner.

### Daemon startup, conflict, and recovery behavior

REPL, Space, and SDK callers using the same resolved `homeDir + profile` target
the same daemon. Simultaneous startup is expected: candidates race only for the
atomic owner lock, then non-owners wait for and attach to the verified winner.
A client never owns a daemon merely because it caused auto-start.

On abnormal exit, the next start validates the saved PID, endpoint, token, and
runtime id before removing stale state. KodaX will not kill a process whose
ownership cannot be proven. Persisted queued/running/waiting-permission runs are
recovered as `interrupted` with a runtime event; they are not resumed
automatically. Session and bounded event records remain available for explicit
reconnect/retry decisions.

Operational guidance:

- use one stable profile for cooperating desktop clients;
- use a separate `homeDir` or profile for tests, previews, and incompatible
  configurations;
- test harnesses that auto-start a process daemon must send authenticated
  `runtime.shutdown` (or run `kodax daemon stop --home <dir> --profile <name>`)
  before deleting their temporary home; `runtime.close()` only detaches;
- query `kodax daemon status --json` before deciding to restart;
- inspect `kodax daemon logs --lines 100` when startup times out;
- custom endpoints and injected transports are attach-only unless the caller
  implements their owner lifecycle explicitly.

The matching CLI surface is:

```bash
kodax daemon start --profile default
kodax daemon status --profile default --json
kodax daemon logs --profile default --lines 100
kodax daemon stop --profile default --json
kodax daemon restart --profile default
kodax --runtime-mode daemon
```

Inside the REPL, `/status runtime` reports embedded/daemon mode, profile,
runtime id, endpoint/health when applicable, and active/queued counters.

### Runtime services

Every `KodaXRuntime` exposes the same service set in inline, Worker, and daemon mode:

| Service | Purpose |
|---|---|
| `identity` | Runtime id, mode, isolation, profile, started time, package version, optional Worker thread id. |
| `sessions` | Create/load/list/fork/transcript/settings/notice/rewind/compact/archive/delete. |
| `runs` | Start/await/get/list/abort runs; update provider/model/reasoning for supported phases. |
| `events` | Subscribe to live events and replay persisted bounded events. |
| `permissions` | Request/list/respond to tool permissions across clients. |
| `workflows` | Observe workflow process snapshots/events and lifecycle controls. |
| `config` | Read/patch/reload daemon or embedded profile config. |
| `catalog` | Providers, models, commands, skills, custom providers, extensions. |
| `mcp` | MCP server CRUD, validation, reload, and tool catalog listing. |
| `artifacts` | Create/get/delete runtime artifact references for file/image/video inputs. |
| `status` | Runtime snapshot with sessions, runs, permissions, workflows, and daemon counters. |
| `diagnostics` | Latest context-budget and tool-exposure decisions for GUI/debug surfaces. |
| `admin.agentRegistrations` | List/upsert/remove redacted external-agent registrations. With no plane, list is empty and mutations fail clearly. |
| `agents` | Check `enabled`, list/describe policy-filtered dispatchable agents, and preflight a selected route. |
| `agentTasks` | Start/list/get/wait/continue/cancel/reconcile durable external-agent tasks and read their ordered event stream. |

### Sessions, runs, and queueing

Runs are serialized per session and can run concurrently across different
sessions. Same-session prompts are FIFO queued. `runs.start()` returns a handle
with a `result` promise that always settles on completion, failure, abort, or
runtime close.

```ts
const session = await runtime.sessions.create({ title: 'Shared session' });

const sub = runtime.events.subscribe({ sessionId: session.id }, (event) => {
  if (event.type === 'assistant.delta') {
    // Render streaming text in the host UI.
  }
});

const artifact = await runtime.artifacts.create({
  kind: 'image',
  path: '/tmp/screenshot.png',
  mediaType: 'image/png',
});

const handle = await runtime.runs.start({
  sessionId: session.id,
  input: [
    { type: 'text', text: 'Review this screenshot.' },
    { type: 'artifact_ref', artifactId: artifact.id },
  ],
  options: {
    provider: 'zai-coding',
    effort: 'high',
  },
});

const result = await handle.result;
sub.close();
```

### Run options across Worker/daemon boundaries

`runs.start({ options })` is a DTO boundary in Worker and daemon forms. Do not
pass process-local objects such as `extensionRuntime`, callbacks, `AbortSignal`,
LSP services, class instances, or cyclic structures. KodaX rejects them before
transport instead of silently dropping fields.

Use the runtime APIs for cross-boundary behavior:

- cancellation: `runtime.runs.abort(runId)`;
- output/progress: `runtime.events.subscribe(...)`;
- approval: `runtime.permissions.respond(...)`;
- session defaults: `runtime.sessions.updateSettings(...)`;
- config/MCP/extensions: configure or reload them in the Runtime owner.

Host-bound extensions or callbacks that cannot be represented as owner-loaded
module/config descriptors require inline embedded mode. There is no fallback to
executing those objects in the client process.

For daemon mode, extension and MCP ownership follows daemon configuration.
Configure extensions in the daemon profile and call
`runtime.catalog.reloadExtensions()` or the matching config service. A CLI
`--extension <path>` is intentionally rejected in daemon mode because that
process-local object cannot become part of a durable shared owner. Worker mode
has the same DTO rule; use owner-readable config/module descriptors or inline
mode for host-created extension objects.

### Permissions across clients

Pending permission requests live in the runtime/daemon, not in one UI client. A
Space-style client can subscribe to permission events and answer a request
created by a REPL-style client.

```ts
const sub = runtime.events.subscribe({ type: 'permission.requested' }, (event) => {
  const payload = event.payload;
  if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string') {
    return;
  }
  void runtime.permissions.respond(
    payload.id,
    { type: 'allow_once' },
    { runId: payload.runId },
  );
});
```

Only the first valid response wins. Wrong-run or stale responses are rejected.
Abort, runtime close, daemon stop, and timeout reject unresolved permission
requests so tool approval promises do not hang forever.

### Config, catalogs, MCP, and Space-style admin APIs

Daemon-connected clients should not edit KodaX config files directly. Use the
runtime services instead:

```ts
await runtime.config.patch({ provider: 'zai-coding', model: 'glm-5.2' });
await runtime.config.reload();

await runtime.catalog.upsertCustomProvider({
  name: 'my-openai-compatible',
  protocol: 'openai',
  baseUrl: 'https://example.com/v1',
  apiKeyEnv: 'MY_LLM_API_KEY',
  model: 'my-model',
});

await runtime.mcp.upsertServer('filesystem', {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', process.cwd()],
});
await runtime.mcp.reloadServers();

const commands = await runtime.catalog.commands(process.cwd());
const skills = await runtime.catalog.skills({ projectRoot: process.cwd() });
```

This is the intended path for KodaX Space, IDE adapters, and settings UIs:
session defaults go through `sessions.updateSettings()`, one-turn overrides go
through `runs.start({ options })`, and daemon/profile config goes through
`config`, `catalog`, and `mcp`.

### Context optimization and diagnostics

The runtime carries the Hermes-inspired context-efficiency plane from the coding
engine:

- small-window schema pruning hides non-core deferred tool schemas while keeping
  bridge discovery resident;
- tool-search/describe/call-style bridge semantics keep tools reachable;
- repo-intelligence schemas remain discoverable under pressure;
- context-aware tool result budgets and compaction pressure events are surfaced
  as bounded diagnostics.

Hosts that set `capabilities.contextDiagnostics: true` can read:

```ts
const budget = await runtime.diagnostics.latestContextBudget({ sessionId });
const exposure = await runtime.diagnostics.latestToolExposure({ sessionId });
```

These diagnostics are designed for status panels and debugging. They should not
contain raw sensitive tool input/output.

### Protocol schema and versioning

The runtime subpath also exports daemon protocol metadata for clients that need
schema-aware IPC validation:

```ts
import {
  KODAX_DAEMON_PROTOCOL,
  KODAX_DAEMON_PROTOCOL_VERSION,
  RUNTIME_DAEMON_PROTOCOL_SCHEMA,
  listRuntimeDaemonSchemaMethods,
} from '@kodax-ai/kodax/runtime';
```

The schema is additive within this patch line. Removing or changing required
fields requires a protocol version bump.

### Current verification status

The v0.7.68 release validation covers the runtime migration, the Worker
isolation follow-ups delivered ahead of their original v0.7.71/v0.7.72
planning slots, the v0.7.67 external-agent/session additions, and the v0.7.68
experimental Memory Agent surface:

- complete repository test suite on Node 20 and Node 22;
- package builds, Worker sidecar builds, and self-contained
  `dist/sdk-runtime.d.ts` generation;
- runtime/daemon/SDK/ACP/REPL integration tests, including process-distinct SDK
  auto-start and multi-client sessions/permissions;
- Worker Runtime identity, service parity, hard close, capability requirements,
  and contradictory-option rejection;
- constructed-handler reverse tool RPC, abort bridging, CPU-loop termination,
  respawn, and revoke/dispose queue drainage;
- context/tool-exposure eval gate;
- embedded and hosted-daemon external-agent catalog/task parity, durable task
  recovery, policy/credential/artifact gates, and disabled-plane failure;
- exact session `surface` filtering plus opaque cursor continuation through the
  narrow `/session` API, embedded Runtime, and daemon transport;
- scoped zero-wait memory recall, read-only deliberate query, trace-only
  receipts, bounded episode review, governed consult-before-write promotion,
  and the self-contained `/experimental-memory` bundle/DTS surface;
- external fresh npm consumer installation of the `0.7.67` tarball, proving
  Worker isolation and a distinct daemon PID through the published subpath;
- Ubuntu Node 22 Unix-domain-socket daemon gate, including two clients sharing
  one runtime and cross-client permission resolution.

The portable manual gates remain in
`docs/test-guides/FEATURE_255_v0.7.66_TEST_GUIDE.md`,
`FEATURE_256_v0.7.71_TEST_GUIDE.md`, and
`FEATURE_257_v0.7.72_TEST_GUIDE.md` for release-machine verification; the latter
two filenames retain their original planning slots while their content records
the v0.7.66 delivery. v0.7.67 adds
`FEATURE_258_v0.7.67_TEST_GUIDE.md`, `FEATURE_259_v0.7.67_TEST_GUIDE.md`, and
`FEATURE_261_v0.7.67_TEST_GUIDE.md`. The final GitHub Actions run is recorded in
the v0.7.67 release after the release commit is pushed.

---

## 18. External-agent executor plane (FEATURE_258, v0.7.67)

FEATURE_258 lets an SDK host register remote agents without teaching the coding
runtime a specific A2A, MCP, or HTTP client. The public contracts live in
`@kodax-ai/kodax/agent`; the host-facing catalog and task services live on
`@kodax-ai/kodax/runtime`.

### Ownership rule

An `AgentExecutorFactory` contains functions, so it cannot cross a Worker or
daemon DTO boundary. Install factories where the Runtime owner executes:

| Desired owner | Supported construction |
|---|---|
| Private in-process owner | `createKodaXRuntime({ mode: 'embedded', isolation: 'inline', externalAgents })` |
| New locally hosted daemon owner | `createKodaXRuntime({ mode: 'daemon', profile: '<unique>', externalAgents })` |
| Existing daemon | Configure its owner, then attach with `connectKodaXRuntime({ requirements: { externalAgents: true } })`; a client cannot inject factories. |
| Runtime Worker | The Worker owner must install factories itself; passing `externalAgents` from the parent is rejected. |

When `mode: 'daemon'` and `externalAgents` are supplied, the caller must win a
new in-process daemon lease. KodaX rejects an already-running profile instead of
silently replacing its executor configuration. Closing that owner facade shuts
down the host it created; closing an ordinary attached client only detaches.

### Minimal owner and task flow

The reference executor below is a contract/conformance adapter. Replace it with
your own `AgentExecutorFactory` for a real remote protocol.

```ts
import {
  createReferenceAgentExecutorFactory,
  type ExternalAgentRegistration,
} from '@kodax-ai/kodax/agent';
import { createKodaXRuntime } from '@kodax-ai/kodax/runtime';

const runtime = await createKodaXRuntime({
  mode: 'embedded',
  isolation: 'inline',
  externalAgents: {
    factories: [createReferenceAgentExecutorFactory({
      executorId: 'example-http',
      protocol: 'http',
    })],
    policy: ({ registration, query }) => ({
      allowed: registration.enabled && query.readOnly === true,
      reasons: query.readOnly === true ? [] : ['This host allows read-only dispatch only.'],
    }),
    defaultContext: { actorId: 'desktop-host' },
  },
});

const registration: ExternalAgentRegistration = {
  agentId: 'external:reviewer',
  displayName: 'Remote Reviewer',
  enabled: true,
  executorId: 'example-http',
  protocol: 'http',
  configurationRevision: 'reviewer-config-v1',
  endpointIdentityHash: 'sha256:replace-with-stable-endpoint-identity',
  skills: ['code-review'],
  inputModalities: ['text'],
  outputModalities: ['text'],
  capabilities: {
    streaming: 'supported',
    durableTasks: 'supported',
    inputRequired: 'conditional',
    cancellation: 'supported',
    artifacts: 'unsupported',
  },
  effects: { remote: 'read', workspace: 'proposal' },
  maxConcurrency: 1,
};

try {
  await runtime.admin.agentRegistrations.upsert(registration);

  const query = {
    actorId: 'desktop-host',
    requiredSkills: ['code-review'],
    readOnly: true,
  } as const;
  const available = await runtime.agents.listDispatchable(query);
  const preflight = await runtime.agents.preflight({
    agentId: 'external:reviewer',
    query,
    expectedConfigurationRevision: registration.configurationRevision,
  });
  if (!preflight.ok) throw new Error(preflight.reasons.join('; '));

  const started = await runtime.agentTasks.start({
    agentId: 'external:reviewer',
    objective: 'Review the supplied immutable patch and return cited findings.',
    context: { actorId: 'desktop-host', runId: 'host-run-42' },
    readOnly: true,
    requiredSkills: ['code-review'],
    expectedConfigurationRevision: registration.configurationRevision,
  });
  const terminal = await runtime.agentTasks.wait(started.taskId, 60_000);
  console.log(available, terminal.state, terminal.output, terminal.usage);
} finally {
  await runtime.close();
}
```

`runtime.agents.enabled` is the cheap external-plane feature check. If it is
false, catalog queries can still return built-in local agents but no external
agents; registration and task lists are empty, while point reads and mutations
fail clearly. Set
`requirements.externalAgents: true` when absence must abort connection.

### Service reference

| Surface | Methods | Contract |
|---|---|---|
| `runtime.admin.agentRegistrations` | `list`, `upsert`, `remove` | Durable owner configuration. List results expose `credentialConfigured`, never a credential value. With no plane, `list()` is empty and mutations fail clearly. |
| `runtime.agents` | `enabled`, `listDispatchable`, `describe`, `preflight` | Applies health, capability, effect, concurrency, credential-presence, configuration-revision, and host-policy checks before dispatch. |
| `runtime.agentTasks` | `start`, `list`, `get`, `events`, `wait`, `sendInput`, `cancel`, `reconcile` | Durable snapshots and append-only events for external tasks. The task keeps the immutable registration/executor binding captured at start. |

`agentTasks.events(taskId, cursor)` uses the last seen numeric event `seq` as its
cursor and returns events with a greater sequence. `wait()` resolves only at a
terminal task state and rejects on a positive `timeoutMs` expiry. `sendInput()`
is valid only while the task reports `input-required` or `auth-required`.
`reconcile()` asks the bound executor for authoritative remote state after an
owner restart or uncertain failure.

The owner plane has a terminal close contract. Closing it rejects every pending
`wait()` (including a wait without `timeoutMs`), disposes its executor instances,
and makes subsequent registration, catalog, preflight, and task calls reject
with `Agent executor plane is closed.` Repeated `close()` calls are safe. SDK
hosts should stop accepting work before closing the owner and must not retain a
plane service as a reusable handle after Runtime shutdown.

Restricted Workflow scripts use the same route as direct SDK calls. Both
`wf.spawnAgent()` and `wf.runAgent()` validate and forward
`target: { agentId, expectedConfigurationRevision? }`; `phase` is forwarded as
well. A blank ID or revision is rejected at the script boundary instead of
silently falling back to the native child backend.

### Credential, artifact, and failure boundaries

- Put only a `credentialRef` in a registration. Resolve secret material through
  `AgentCredentialBroker.withCredential()`; do not place tokens in
  `executorConfig`, events, diagnostics, or task output.
- Remote artifacts are denied by default. Supply `artifactPolicy` to authorize
  each artifact before it materializes in the host boundary.
- External agents may declare workspace effect `none` or `proposal`; direct
  workspace mutation is intentionally not a valid external registration.
- Use `expectedConfigurationRevision` to prevent dispatching against a stale
  endpoint/configuration seen by an earlier catalog read.
- A remote start followed by uncertain local persistence is recorded as
  `unknown` with its executor reference preserved; reconcile it rather than
  blindly starting a duplicate. Stable idempotency keys protect retries.
- The durable plane records provider-reported usage when available. It never
  invents missing token or cost fields.

For a production adapter, implement `preflight?`, `start`, `events`, `get`,
`sendInput`, `cancel`, `reconcile`, and `dispose` on `AgentExecutor`. The factory
receives `withCredential()` and `authorizeArtifact()` callbacks so protocol code
cannot bypass the host's secret/artifact policies.

---

## 19. Session surface filtering and cursor pagination (FEATURE_261, v0.7.67)

The narrow session SDK and Runtime facade now share the same listing semantics:
`surface` is an exact filter applied before `limit`, and `cursor` is an opaque
continuation token carried by each returned summary.

### Narrow `/session` API

```ts
import { listSessions, type SessionSummary } from '@kodax-ai/kodax/session';

const all: SessionSummary[] = [];
let cursor: string | undefined;
do {
  const page = await listSessions({
    scope: 'user',
    surface: 'partner',
    limit: 50,
    ...(cursor ? { cursor } : {}),
  });
  all.push(...page);
  cursor = page.length === 50 ? page.at(-1)?.cursor : undefined;
} while (cursor);
```

### Embedded/daemon Runtime API

```ts
const first = await runtime.sessions.list({ surface: 'acp', limit: 25 });
const nextCursor = first.at(-1)?.cursor;
const second = nextCursor
  ? await runtime.sessions.list({ surface: 'acp', limit: 25, cursor: nextCursor })
  : [];
```

The filter also composes with `projectRoot`, `scope`, `includeArchived`, `before`,
and `tag`. Treat cursors as opaque: do not parse them, compare them to session
IDs, or manufacture them. An invalid cursor produces an empty page on the narrow
session API. A page shorter than the requested limit is terminal; a full page
may continue with its last item's cursor.

The interactive `kodax -r` picker is a consumer of these session semantics, not
a separate SDK API. Headless hosts should build their own UI on `listSessions()`
or `runtime.sessions.list()` and resume by the selected full session ID.

---

## 20. Cost-disciplined workflow routing and telemetry (FEATURE_259, v0.7.67)

FEATURE_259 adds a public cost/quality contract without making the authoring LLM
choose provider-specific model names. The SDK host maps semantic tiers to routes;
workflow/child briefs request intent.

### Configure tiers and bounded concurrency

```ts
import { join } from 'node:path';
import { runKodaX } from '@kodax-ai/kodax/coding';

const workflowRunsBaseDir = join(process.cwd(), '.kodax-host', 'workflow-runs');
const result = await runKodaX({
  provider: 'zai-coding',
  model: 'glm-5.2',
  agentMode: 'amaw',
  workflowRunsBaseDir,
  modelTiers: {
    fast: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    deep: { provider: 'zai-coding', model: 'glm-5.2' },
  },
  workflow: { maxConcurrency: 3 },
  events: {
    onWorkflowAgentDigest: ({ runId, event }) => {
      if (event.type === 'agent_completed' || event.type === 'agent_unverified'
        || event.type === 'agent_failed') {
        console.log(runId, event.data);
      }
    },
  },
}, 'Review this change using scoped evidence packets.');

console.log(result.lastText);
```

Tier rules are deliberately small:

- `fast`: mechanical read-only lookup. A write child is ineligible and safely
  inherits the parent route.
- `balanced`: ordinary implementation/investigation/review; uses the parent
  route, so there is no separate `balanced` mapping.
- `deep`: architecture, adversarial verification, severity calibration, and
  final synthesis.
- An unconfigured or selector-shadowed tier inherits the appropriate explicit,
  specialist, or parent route and records why; it does not silently claim the
  requested route was applied.

The workflow authoring contract also supports `scopeSummary`, `constraints`,
`evidenceRefs`, `verification`, `readOnly`, `outputSchema`, and `terseResult`.
Use those fields to transfer a compact immutable packet instead of asking every
child to rediscover the same repository context.

### Live route facts

Terminal `WorkflowEvent.data` may include `requestedTier`, `tierOutcome`,
`providerSource`, `modelSource`, initial/final provider and model,
`fallbackReason`, `iterations`, `durationMs`, `usage`, and `digestUsage`.
Treat absent fields as unknown. In particular, KodaX does not fabricate usage
for external executors that did not report it.

Direct child-dispatch consumers receive the typed `KodaXChildAgentResult.routeFacts`
surface, including resolved effort and input/cache-read/output/digest token
breakdown when known. Inline workflow consumers can subscribe to the raw
`onWorkflowAgentDigest` event as above; GUI progress remains available through
`onWorkflowProcessEvent` / `runtime.workflows`.

### Durable efficiency report

When `workflowRunsBaseDir` is supplied, every terminal workflow writes:

```text
<workflowRunsBaseDir>/<runId>/run.json
<workflowRunsBaseDir>/<runId>/events.jsonl
<workflowRunsBaseDir>/<runId>/artifacts/*.json
```

`run.json.efficiencyReport` includes:

- total/input/cache-read/output/digest tokens and wall-clock duration;
- total starts, child turns, starts by `role/tier`, and primary-review starts;
- duplicate primary packet reads plus verification/synthesis packet reads;
- review/fix/re-review waves and structured review quality-gate outcomes;
- `tokenCoverage.ok` plus missing local task IDs;
- `excludedExternalTaskIds` for external tasks whose executor reported no usage.

Do not interpret `totalModelTokens: 0` as free execution unless
`tokenCoverage.ok` is true and the relevant external task IDs are not excluded.
The report is an audit/optimization artifact; correctness still comes from the
workflow's structured findings, verification results, and quality gates.

---

## 21. Experimental governed memory — `/experimental-memory` (FEATURE_260, v0.7.68)

KodaX has one durable memory plane: the F228 Memory Control Plane. FEATURE_260
adds a thin, opt-in agent/session API over that plane; it does not add a second
database, filesystem memory actions, a resident memory specialist, or online
self-modification.

Top-level `runKodaX()` coding runs wire this lifecycle automatically. They build
an exact-scoped memory pack at session start, keep passive recall off the
blocking hot path, expose `memory_recall` only when the memory session starts,
record bounded observations/outcomes, and close the session at the run boundary.
Use the direct SDK below when a custom host needs to own those boundaries.

### Minimal direct session

```ts
import { createMemoryControlPlane } from '@kodax-ai/kodax/agent';
import { createMemoryAgent } from '@kodax-ai/kodax/experimental-memory';

const identity = {
  tenantId: 'tenant:acme',
  workspaceId: 'workspace:desktop',
  userId: 'user:42',
  agentId: 'agent:reviewer',
  projectId: 'project:kodax',
  sessionId: 'session:20260712',
};

const controlPlane = createMemoryControlPlane({
  cwd: process.cwd(),
  identity,
  projectDocs: [],
  discoverSkills: false,
});
const memory = createMemoryAgent({ controlPlane });
const session = await memory.startSession({
  identity,
  objective: 'Review the runtime shutdown change',
});

const immediate = session.recall({
  decisionRevision: 'decision:1',
  objective: 'Review the runtime shutdown change',
  decisionContext: 'Choosing the first verification step',
  decisionIntent: 'runtime shutdown regression',
  throughSequence: 0,
});
const deliberate = await session.query({
  decisionRevision: 'decision:2',
  need: 'What uncommon daemon cleanup failure happened before?',
  throughSequence: 0,
});

await session.complete({
  status: 'succeeded',
  summary: 'Shutdown state replacement verified',
  evidence: [],
});
await session.close();
```

`recall()` is synchronous: exact observations/hints can be returned immediately,
while an optional semantic prefetch finishes for a later matching decision.
`query()` is deliberate and read-only; one distinct query is admitted per
decision epoch, and the result is bounded to at most three prompt-safe hints and
512 estimated tokens. `undefined` means there is no governed reminder to inject.

### Evidence, tracing, and persistence boundaries

- Recalled content is low-authority evidence. Current repository/config/runtime
  facts must still come from current tools or host state.
- `observe()` accepts monotonic, evidence-linked observations and rejects secret
  material. `rewind()` removes observations after a sequence boundary.
- `complete()` can emit an Outcome Digest through `persistOutcomeDigest` and run
  bounded episode review through `reviewEpisode`; cancellation creates neither.
- `onTrace` receives policy-versioned `MemoryDecisionReceipt` metadata that links
  candidates, selection, injection, and later outcome influence. Receipts are
  trace-only and contain no hidden reasoning.
- Durable memory mutation remains owned by F228's
  proposal/preview/fingerprint/apply flow. `/memory` is the CLI governance
  surface; direct file/shell writes to managed memory roots are denied.
- Identity/applicability matching is exact and fail-closed. Hosts should supply
  stable tenant/workspace/user/agent/project/session identifiers and must not put
  credentials into those identifiers.

The subpath is experimental and ESM-only. Treat its exported types as opt-in
v0.7.x contracts; keep persistence and product policy behind your own adapter.

---

## 22. Bidirectional A2A 1.0 — `/a2a` (FEATURE_267, v0.7.69)

`@kodax-ai/kodax/a2a` is the protocol edge for the A2A 1.0 JSON-RPC/SSE
profile. It composes the protocol-neutral F258 executor plane with the Runtime
facade; `/agent` and `/coding` remain free of A2A wire types and dependencies.

### Call an A2A Agent through F258

Discovery is an explicit host action. The URL must match `allowedOrigins`, and
the safe fetch path revalidates DNS and redirects, rejects public plain HTTP,
bounds time/body/redirects, and strips authorization on a cross-origin redirect.

```ts
import {
  createA2AAgentExecutorFactory,
  discoverA2ARegistration,
} from '@kodax-ai/kodax/a2a';
import { createKodaXRuntime } from '@kodax-ai/kodax/runtime';

const client = {
  networkPolicy: {
    allowedOrigins: ['https://reviewer.example'],
    allowPrivateAddresses: false,
    requestTimeoutMs: 10_000,
    maxResponseBytes: 1_048_576,
    maxRedirects: 2,
  },
  pollIntervalMs: 500,
} as const;

const discovered = await discoverA2ARegistration({
  agentId: 'external:a2a-reviewer',
  agentCardUrl: 'https://reviewer.example/.well-known/agent-card.json',
  credentialRef: 'a2a/reviewer',
  effects: { remote: 'read' },
}, client);

const runtime = await createKodaXRuntime({
  mode: 'embedded',
  isolation: 'inline',
  externalAgents: {
    factories: [createA2AAgentExecutorFactory(client)],
    credentialBroker: {
      async withCredential(ref, use) {
        if (ref !== 'a2a/reviewer') throw new Error('Unknown credential reference.');
        return use(process.env.A2A_REVIEWER_TOKEN ?? '');
      },
    },
    policy: ({ registration }) => ({ allowed: registration.effects.remote === 'read' }),
    defaultContext: { actorId: 'a2a-host' },
  },
});

await runtime.admin.agentRegistrations.upsert(discovered.registration);
const started = await runtime.agentTasks.start({
  agentId: discovered.registration.agentId,
  objective: 'Review this change and return cited findings.',
  context: { actorId: 'a2a-host' },
  readOnly: true,
  expectedConfigurationRevision: discovered.registration.configurationRevision,
});
const terminal = await runtime.agentTasks.wait(started.taskId, 60_000);
```

The executor supports durable task start/get, input continuation, cancel,
reconcile, SSE events, and polling fallback. An ambiguous start is not retried
automatically. A `credentialRef` is resolved just in time by the F258 broker;
the registration, task store, and diagnostics never contain the credential.

### Built-in configured path (no host code)

The CLI product path stores one user document at
`~/.kodax/integrations/a2a.json` and uses the same F258 plane:

```bash
kodax a2a add reviewer https://reviewer.example/.well-known/agent-card.json \
  --credential-env A2A_REVIEWER_TOKEN --effect read
kodax a2a test reviewer
kodax a2a call reviewer "Review this document"
```

Embedded CLI Runtimes and the user-owned daemon automatically reconcile these
entries as `external:<name>`. Discovery/update failure retains that entry's
last-known-good registration; another entry can still update. The environment
broker resolves `credentialEnv` only at call time. Automatic Runtime
registration accepts public HTTPS and exact loopback targets; explicit private
network access remains an operator action on the direct CLI/SDK path.

Inbound publication is also no-code:

```bash
export KODAX_A2A_TOKEN='replace-with-a-long-random-token'
kodax a2a expose                    # Runtime default Agent
kodax a2a expose document-agent     # ~/.kodax/agents/document-agent.md
kodax a2a serve --port 8765
```

`expose` validates a named user Markdown Agent before writing its reference.
`serve` loads configured MCP and Extensions before it resolves the execution
binding or opens a socket. Native workspace read tools are admitted by
workspace access; writes, narrow Extension Tools, MCP capabilities, subagents,
and isolated Skill scripts require their corresponding exact `toolPolicy`
authority. Internal Skills come from `~/.kodax/skills`, `~/.agents/skills`,
plugins, and built-ins; public Agent Card skills are a separate explicit
projection and never reveal the private Skill inventory.

The running server pins Agent, Skill, workspace, tool registration, process and
store revisions. Card/auth/limits can hot reload; execution-authority changes
require an explicit restart. Managed contexts live below
`~/kodax_a2a_server_workspace/<profile>/contexts/`. Exact Skill scripts require
`process: isolated`, an admitted `scripts/...` path, and a passing
`kodax sandbox doctor`; KodaX never falls back to an unsandboxed shell.

### Publish one KodaX Agent

Publication is host-owned and opt-in. The public card describes only the
configured Agent, media types, and skills. Authentication runs before task
lookup; authorization runs per operation; task visibility is principal-scoped.

```ts
import { createKodaXA2AServer } from '@kodax-ai/kodax/a2a';
import { createKodaXRuntime } from '@kodax-ai/kodax/runtime';

const runtime = await createKodaXRuntime({ mode: 'embedded', isolation: 'inline' });
const server = createKodaXA2AServer({
  runtime,
  dataDir: '/var/lib/kodax/a2a',
  agent: {
    name: 'KodaX Reviewer',
    description: 'Reviews bounded code changes.',
    version: '1.0.0',
    publicBaseUrl: 'https://kodax.example',
    skills: [{ id: 'review', name: 'Review', description: 'Review code.', tags: ['code'] }],
    inputModes: ['text/plain'],
    outputModes: ['text/plain'],
  },
  authentication: {
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    async authenticate(request) {
      return request.headers.get('authorization') === `Bearer ${process.env.KODAX_A2A_TOKEN}`
        ? { subject: 'trusted-orchestrator', scopes: ['a2a'] }
        : null;
    },
  },
  async authorize({ principal }) { return principal.scopes.includes('a2a'); },
  limits: {
    maxRequestBytes: 1_048_576,
    maxPartBytes: 524_288,
    maxConcurrentTasks: 8,
    maxTasksPerPrincipal: 64,
  },
});

// Development only: the built-in listener refuses non-loopback hosts.
const localBaseUrl = await server.listen({ hostname: '127.0.0.1', port: 0 });
```

Production hosts route `GET /.well-known/agent-card.json` and JSON-RPC `POST /`
to `server.handle(request)` behind their own TLS terminator. `POST /a2a` remains
an accepted compatibility alias. The durable edge store supports get/list,
continuation, cancellation, ordered SSE subscription, and surviving Runtime-run
reattachment after an edge restart. Push notifications, A2A 0.3, gRPC, and
HTTP+JSON are not advertised; unsupported push methods return the standard
`PushNotificationNotSupportedError`.

Remote messages are ordinary user inputs. They cannot select provider, model,
profile, tools, working directory, permission mode, or Runtime configuration.
URL parts are rejected; inline raw/data parts are bounded and materialized under
the server-owned data directory. Responses expose final approved output only,
not system prompts, reasoning deltas, tool payloads, credentials, or local paths.

The normative baseline is A2A repository commit
`2183794bfb9b67af4aee1be0a0ef726050642873`, protocol `1.0`, with
`specification/a2a.proto` SHA-256
`e195bf96ab630c69797851970203e1b2b6b19528f2e9803b7d904b91a5104016`.

---

## See also

- [README.md](../README.md) — end-user CLI quick start
- [docs/ADR.md ADR-024](ADR.md#adr-024-npm-发布物正名-kodax-aikodax--sdk-subpath-exports-形式化-v0739) — SDK subpath architecture rationale
- [docs/ADR.md ADR-032](ADR.md#adr-032-sdk-embedder-surface-closure-feature_186-v0742) — FEATURE_186 design record (all 8 phases)
- [docs/features/v0.7.42.md FEATURE_186](features/v0.7.42.md#feature_186-sdk-embedder-surface-closure--kodax-space-gap-list--mcp-popout) — gap-by-gap landing matrix
