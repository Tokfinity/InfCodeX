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

## See also

- [README.md](../README.md) — end-user CLI quick start
- [docs/ADR.md ADR-024](ADR.md#adr-024-npm-发布物正名-kodax-aikodax--sdk-subpath-exports-形式化-v0739) — SDK subpath architecture rationale
- [docs/ADR.md ADR-032](ADR.md#adr-032-sdk-embedder-surface-closure-feature_186-v0742) — FEATURE_186 design record (all 8 phases)
- [docs/features/v0.7.42.md FEATURE_186](features/v0.7.42.md#feature_186-sdk-embedder-surface-closure--kodax-space-gap-list--mcp-popout) — gap-by-gap landing matrix
