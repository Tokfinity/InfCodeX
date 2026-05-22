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

All three surfaces land in v0.7.42 under FEATURE_186 (see
[ADR-032](ADR.md#adr-032-sdk-embedder-surface-closure-feature_186-v0742)).

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

## See also

- [README.md](../README.md) — end-user CLI quick start
- [docs/ADR.md ADR-024](ADR.md#adr-024-npm-发布物正名-kodax-aikodax--sdk-subpath-exports-形式化-v0739) — SDK subpath architecture rationale
- [docs/ADR.md ADR-032](ADR.md#adr-032-sdk-embedder-surface-closure-feature_186-v0742) — FEATURE_186 design record (all 8 phases)
- [docs/features/v0.7.42.md FEATURE_186](features/v0.7.42.md#feature_186-sdk-embedder-surface-closure--kodax-space-gap-list--mcp-popout) — gap-by-gap landing matrix
