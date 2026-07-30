# FEATURE_281 v0.7.79 Test Guide

## Scope

Verify that outbound A2A private-address access and non-loopback plaintext HTTP
are independent, explicit, persisted permissions across CLI, Runtime discovery,
and task execution.

## Automated Regression

From the repository root:

```powershell
npx vitest run src/a2a/safe-fetch.test.ts src/a2a/config.test.ts src/a2a/runtime-config.test.ts src/integration-cli.test.ts
npm run config:templates:check
npm run build
```

Expected: every command exits zero. The focused suites cover strict parsing,
the protocol/address matrix, CLI persistence, registration fingerprinting, and
real private-HTTP external Actor dispatch through a trusted fetch harness.

## Manual Matrix

Use a disposable Agent name and an A2A test server that is reachable at the
stated address.

### Exact loopback HTTP remains implicit

```powershell
kodax a2a add local-http http://127.0.0.1:19103/.well-known/agent-card.json --effect read
kodax a2a test local-http
```

Expected: no network flags are required.

### Private HTTP requires both permissions

```powershell
kodax a2a add intranet-http http://10.20.30.40/.well-known/agent-card.json --allow-private --allow-insecure-http --effect read
kodax a2a list
kodax a2a test intranet-http
kodax a2a call intranet-http "reply with ok"
```

Expected: `a2a list` shows both persisted booleans as `true`; discovery and call
succeed.

Repeat with only one flag and a fresh Agent name. Expected:

- only `--allow-private`: rejected because non-loopback plaintext HTTP is not
  authorized;
- only `--allow-insecure-http`: rejected because the resolved address is
  private.

### Private HTTPS needs no plaintext permission

```powershell
kodax a2a add intranet-tls https://10.20.30.40/.well-known/agent-card.json --allow-private --effect read
kodax a2a test intranet-tls
```

Expected: private-address authority is sufficient when TLS validation succeeds.

### OAuth token endpoints remain stricter

Configure an OAuth client-credentials Agent with a non-loopback HTTP
`tokenUrl`, even when both network permissions are true.

Expected: configuration/Card validation rejects the token endpoint. The
plaintext permission applies to Agent Card/interface transport and does not
weaken OAuth's HTTPS-or-exact-loopback boundary.

## Cleanup

```powershell
kodax a2a remove local-http
kodax a2a remove intranet-http
kodax a2a remove intranet-tls
```

Remove any extra one-flag Agent names created during negative testing.
