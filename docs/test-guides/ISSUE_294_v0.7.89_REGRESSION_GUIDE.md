# FEATURE_294 / v0.7.89 Host Tools Regression Guide

## Scope

Verify that daemon-bound Host Tools are visible and callable for exactly the
leased run, while remaining isolated from the global registry, unrelated CLI
runs, and unsafe plan-mode execution. The release also verifies the cached
capability catalog and A2A `host:` authorization surface.

## Automated gates

Run the focused suites from the repository root:

```text
npm test -- packages/coding/src/agent-runtime/run-scoped-tools.test.ts
npm test -- packages/coding/src/task-engine/runner-driven-tool-wiring.test.ts
npm test -- packages/coding/src/tools/tool-search.test.ts
npm test -- packages/coding/src/permissions/permission.test.ts
npm test -- src/runtime-daemon/reverse-bridge.test.ts
npm test -- src/runtime-daemon/server.test.ts
npm test -- src/runtime-agent-binding.test.ts
npm test -- src/a2a/config.test.ts
```

The coding and root TypeScript builds must also pass. The Windows Shell and
packaged Electron gates are required because this feature crosses the daemon
reverse bridge but does not change the Shell/sandbox implementation.

## Manual checks

### TC-001: catalog visibility is run-scoped

1. Bind a host provider with two valid tools to Run A.
2. Inspect the capability prompt context and model-facing tool table.
3. Start Run B without the binding and inspect both surfaces.

Expected:

- [ ] Run A contains one `Host Capability Provider (run-bound)` catalog block.
- [ ] Run A can see the bound tool names and schemas without first calling
      `mcp_search`.
- [ ] The catalog revision is stable when only the per-run lease id changes.
- [ ] Run B and unrelated CLI/ACP paths contain no Run A host tools.

### TC-002: side-effect and plan-mode policy is conservative

Bind one `none`, one `idempotent`, and one `non_idempotent` host tool.

- [ ] `none` is readonly and allowed in plan mode.
- [ ] `idempotent` and `non_idempotent` are mutating and blocked in plan mode.
- [ ] An unknown or unreachable host tool is blocked rather than guessed.

### TC-003: dispatch follows the model-visible registry

1. Bind a host tool whose name collides with a registered KodaX tool.
2. Attempt the binding and then invoke an ordinary registered tool with that
   name.
3. Bind a non-colliding host tool and invoke it through the model-facing path.

Expected:

- [ ] Colliding bindings fail with `invalid_params` before a host-tool run record
      is created.
- [ ] Registry-first dispatch executes the schema the model saw.
- [ ] A non-colliding host tool dispatches through the capability channel and
      renders through the normal MCP retrieval path.

### TC-004: revoke and transport uncertainty fail closed

1. Start a host-tool invocation, revoke its lease, and attempt another call.
2. Disconnect the host after a call has been durably dispatched.

Expected:

- [ ] Revocation removes the tool and catalog line from subsequent turns.
- [ ] A call after revoke is rejected and is never replayed.
- [ ] An unknown post-dispatch outcome remains unknown; the tool is not
      automatically retried.

### TC-005: lease and A2A authorization boundaries

- [ ] Lease ids accept only `[A-Za-z0-9][A-Za-z0-9_-]{0,127}`.
- [ ] Reserved `:` and malformed names are rejected.
- [ ] A2A role policy authorizes the exact `host:<leaseId>:<tool>` capability.
- [ ] A different host lease, provider, or capability kind is rejected.

## Test summary

| Area | Pass | Fail | Blocked |
|---|---:|---:|---:|
| Automated focused suites | - | - | - |
| Catalog and run isolation | - | - | - |
| Plan-mode and dispatch policy | - | - | - |
| Revoke and A2A boundaries | - | - | - |

**Release conclusion**: To be completed against the exact `v0.7.89` build.

*Guide created: 2026-08-16*  
*Feature: 294*
