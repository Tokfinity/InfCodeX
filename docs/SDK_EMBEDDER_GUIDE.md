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
8. [Electron + `stdio: 'inherit'` on Windows — PowerShell input hijack](#8-electron--stdio-inherit-on-windows--powershell-input-hijack)
9. [Model capabilities — context window, reasoning, descriptors](#9-model-capabilities--context-window-reasoning-descriptors)

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
| `execute(id, input)` | `Promise<CapabilityResult>` | Invoke a tool by capability id (`mcp://<serverId>/tool/<name>`). |
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
session.setReasoning('medium');

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

### The canonical fix

```ts
import { runKodaX } from '@kodax-ai/kodax/coding';
import { createSessionManager } from '@kodax-ai/kodax/repl';

// One manager per host process; reuse across runs so the
// per-session write queue + append-watermark caches stay coherent.
const { storage, listSessions, loadSession } = createSessionManager();

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
const recent = await listSessions({ scope: 'user', limit: 50 });
const replay = await loadSession('s_my_chat');
```

### What `createSessionManager()` returns (v0.7.43+)

```ts
interface SessionManager {
  // Read side (FEATURE_173 v0.7.42)
  listSessions(...): Promise<SessionSummary[]>;
  loadSession(id): Promise<...>;
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
`"name": "@kodax-ai/kodax"` is baked in along with all 7 SDK subpath
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

## 8. Electron + `stdio: 'inherit'` on Windows — PowerShell input hijack

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

## 9. Model capabilities — context window, reasoning, descriptors

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

v0.7.43 promotes this metadata into `KODAX_PROVIDER_SNAPSHOTS` (a plain
const map) and adds getters that read directly from it — no provider
instance, no API key, no env vars touched.

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
  supportsThinking: boolean;        // native reasoning?
  reasoningCapability: 'native-budget' | 'native-effort' | 'native-toggle' | 'prompt-only' | 'none' | 'unknown';
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
// → { contextWindow: 256_000, supportsThinking: true, reasoningCapability: 'native-effort', ... }
```

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

Snapshot values are encoded in
[`packages/llm/src/providers/registry.ts`](../packages/llm/src/providers/registry.ts)
(`KODAX_PROVIDER_SNAPSHOTS`). When upstream providers publish a new
model or change a context-window cap, that file is the patch site —
the new value flows to runtime (via `buildProviderConfig`) AND to SDK
consumers (via the getters) in a single edit. The test suite at
[`packages/llm/src/providers/model-capabilities.test.ts`](../packages/llm/src/providers/model-capabilities.test.ts)
locks in specific values (e.g. kimi-k2.6 at 256K, deepseek-v4-pro at 1M)
so accidental drift is caught at PR time.

The probe scripts that surveyed upstream APIs live at
[`scripts/probe-upstream-model-metadata.mjs`](../scripts/probe-upstream-model-metadata.mjs)
and [`scripts/probe-ark-tokens.mjs`](../scripts/probe-ark-tokens.mjs) —
re-run them periodically; if a provider starts returning richer model
metadata, we can promote the snapshot to derive from it.

---

## 10. Provider credential verification — `verifyProviderCredential` (FEATURE_216, v0.7.45)

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

`models-list` is NOT used as a universal default because (a) some providers' `/v1/models` is publicly accessible (so a bad key returns 200 — false positive), and (b) some compat layers don't implement it (404) or 401 even for valid keys (false negative). The 2026-05-28 provider probe matrix captured these empirically (12 providers at the time; 14 built-in aliases as of 2026-06-13); opencode's `setup-recording-env.ts` makes the same per-provider decision across its 20+ providers.

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

## 11. Inject your product's manual — `selfManual` (FEATURE_221, v0.7.47)

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

### Topic shape (`KodaXManualTopicInput`)

`{ id, title, summary, body }` required; `aliases?`, `nextTopics?`, `sources?` optional. Keep `body` short (a few lines) — it is a bounded on-demand answer, not a document.

### Reference

- Types/exports: `KodaXManualTopicInput`, `KodaXSelfManualConfig`, `ResolveKodaXManualOptions`, `buildSelfKnowledgeRoutingRule` from `@kodax-ai/coding`.
- Design: [docs/features/v0.7.47.md FEATURE_221](features/v0.7.47.md#feature_221-injectable-self-manual-for-sdk-consumers).

---

## See also

- [README.md](../README.md) — end-user CLI quick start
- [docs/ADR.md ADR-024](ADR.md#adr-024-npm-发布物正名-kodax-aikodax--sdk-subpath-exports-形式化-v0739) — SDK subpath architecture rationale
- [docs/ADR.md ADR-032](ADR.md#adr-032-sdk-embedder-surface-closure-feature_186-v0742) — FEATURE_186 design record (all 8 phases)
- [docs/features/v0.7.42.md FEATURE_186](features/v0.7.42.md#feature_186-sdk-embedder-surface-closure--kodax-space-gap-list--mcp-popout) — gap-by-gap landing matrix
