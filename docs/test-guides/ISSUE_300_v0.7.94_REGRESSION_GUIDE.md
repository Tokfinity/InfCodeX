# Issue 300 / v0.7.94 Sandboxed Git Trust Regression Guide

## Automated gates

Run:

```text
npx vitest run -c vitest.system.config.ts src/sandbox-runtime.test.ts
npx vitest run packages/coding/src/tools/edit.test.ts
npx vitest run packages/coding/src/tools/worktree.test.ts
npx vitest run -c vitest.system.config.ts src/sdk-runtime.test.ts -t "starts a Run without a text sandbox"
```

Required assertions:

1. The public v4 capability reports `gitSafeDirectory: 'authorized-repo-roots'`.
2. Windows git trust never emits `safe.directory=*`, even when no authorized
   root survives, and rejects malformed `GIT_CONFIG_*` shapes.
3. The eight-root budget keeps cwd and repo-bearing read grants ahead of
   ordinary write roots. Read-authorized roots outside write grants are
   trusted when the permission review admitted them.
4. Linked-worktree metadata must prove `commondir` / `gitdir` backlinks
   before the main `.git` receives a read ACE. Submodules must prove
   `core.worktree`. Arbitrary real `.git` targets stay untrusted.
5. Broker and bundled rewriting share one implementation; the production
   minified broker still applies the same trust set.
6. A missing workspace directory starts a Runtime Run without attaching the
   concurrent text-mutation sandbox instead of aborting option construction.

## Windows manual acceptance

1. Open a linked worktree whose main `.git` is outside the session write
   grants. From the sandboxed shell, `git status` and `git -C <main> status`
   must not fail with `detected dubious ownership`.
2. Repeat in a home-directory workspace that expands past eight write roots.
   `GIT_CONFIG_*` must list exact authorized roots, never `safe.directory=*`.
3. Start an idle Runtime, launch a long-running Bash command, and edit a
   workspace file. The edit must complete without waiting for the shell to
   exit. A hard-linked workspace target must be rejected.
4. Schedule a daemon stop whose cleanup fails. The public stop must report
   the failed shutdown outcome rather than a safe stop.
