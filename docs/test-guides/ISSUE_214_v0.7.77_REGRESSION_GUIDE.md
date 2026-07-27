# Issue 214 v0.7.77 Regression Guide

## Scope

Validate the opt-in Runtime Shell Execution Contract without changing legacy
unconfigured command behavior.

## Windows PowerShell directory toolchain

1. Configure a Session with `version: 1`, `shell.kind: "powershell"`,
   `shell.profile: "default"`, and a trusted `environment.setup` that activates
   the repository's configured Node version.
2. Start the Run with `executionCwd` set to that repository.
3. Execute `node --version` through the built-in `bash` tool.
4. Verify the repository-selected version is returned.
5. Repeat in a second repository with a different configured Node version and
   verify the two results do not cross.

PowerShell profiles are loaded during environment resolution. Directory switch
logic that normally runs only from a prompt hook must be invoked explicitly by
`environment.setup`, because the resolver is non-interactive.

## Persistent Windows PATH

1. Set `environment.windowsPath: "registry"`.
2. Add or update a persistent User PATH entry after the daemon starts,
   including `%PATH%` and a referenced variable such as `%VOLTA_HOME%\bin`.
3. Change `cache.refreshToken` (or wait beyond `cache.ttlMs`).
4. Execute a command supplied by the new PATH entry and verify it resolves
   without restarting the daemon.
5. Verify neither the old daemon PATH nor an old/missing `VOLTA_HOME` value is
   present in the resolved environment.

## Cache and daemon reuse

1. Set `cache.ttlMs` to 30 seconds and run a command twice in one cwd.
2. Change the project environment source and confirm the cached value remains
   until expiry.
3. Change `cache.refreshToken` and confirm the next command waits for and uses a
   fresh environment.
4. Restart the daemon and confirm its first command performs a fresh probe.

## Security and failure

1. Start the daemon with disposable credentials for two Providers, including
   an inactive custom/runtime Provider whose `apiKeyEnv` has a non-standard
   name such as `TEST_PROVIDER_AUTH`.
2. Under a configured shell contract using the other Provider, run a command
   that prints both variables.
3. Verify both are absent and neither diagnostics nor error messages contain
   their values.
4. Configure a nonexistent shell executable and verify the command is not
   executed and a visible resolution error is returned.
5. Remove `shellExecution` and verify the established legacy command path still
   behaves as before.
6. Set daemon `NODE_OPTIONS` to an invalid option and verify a configured-shell
   command still starts because the probe helper does not inherit it.
7. Deny `KODAX_*` and verify `KODAX_SESSION_TMP` is not reintroduced.
8. Cancel a Run while its only environment probe is still loading and verify
   the profile/setup process is terminated without running delayed side
   effects.
9. Repeat with two commands sharing the same probe, cancel one, and verify the
   remaining command still receives the resolved environment.

## PowerShell and Git Bash argv

1. Verify Windows PowerShell accepts only `default` and `none` profile modes.
2. Verify PowerShell `/Command`, `-Command`, encoded-command, file, login,
   no-profile, and no-exit overrides are rejected from host fixed args.
3. On Linux/macOS, verify `pwsh -Login` is the first argument; on Windows,
   verify login mode fails closed instead of being silently ignored.
4. Execute a valid heredoc through explicit Git Bash and verify its successful
   result does not include a Windows-cmd warning.

## Child inheritance and permissions

1. Spawn a native child Agent and a nested grandchild; run `node --version` in
   each and verify the root Session contract is inherited.
2. Complete a todo carrying a deterministic build/test/lint evaluator and
   verify the check uses the same project-selected Node environment.
3. Approve one exact command under cmd.
4. Switch the Session contract to PowerShell or Bash.
5. Verify the old grant does not auto-authorize the command under the new
   interpreter.
6. Persist a Session shell contract, start a Run whose context explicitly
   carries `shellExecution: undefined`, and verify the Session contract remains
   effective.
