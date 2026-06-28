# Repointel Legacy Host Integration

> v0.7.57 direction: KodaX repo intelligence is built into KodaX. Normal KodaX
> users should not install or start a standalone `repointel` daemon.

## KodaX Users

Use the built-in repo-intelligence tools and REPL diagnostics:

```text
/repo-intel status
/repo-intel mode auto|full|light|off
/repo-intel trace on|off|toggle
```

CLI mode names use the same public vocabulary:

```bash
kodax --repo-intelligence full --repo-intelligence-trace
```

The old `premium-native`, `premium-shared`, and `oss` mode names no longer
control runtime behavior. If old env vars are present, KodaX warns and uses the
new `auto`, `full`, `light`, and `off` vocabulary.

The old endpoint/bin controls are not part of the normal KodaX runtime path.
They should not appear in setup instructions.

## External Hosts

The standalone `repointel` frontdoor (the former `clients/repointel/` host-skill
directory, its `SKILL.md` / `reference.md`, and the `install`/`doctor`/`demo`
scripts) has been removed. It depended on a daemon endpoint and a private
`repointel-cli` build that the KodaX runtime no longer honors — the
`KODAX_REPOINTEL_BIN`, `KODAX_REPOINTEL_ENDPOINT`, and `premium-native` controls
are ignored with a warning.

External hosts (Claude Code, Codex, OpenCode) that want KodaX repo intelligence
should drive built-in KodaX rather than a standalone frontdoor.

## Removal Rules

- Do not route any user to a standalone `repointel` frontdoor; it no longer
  exists.
- Do not document standalone daemon warmup as a KodaX setup step.
- Keep `/repointel status` and `/ri` only as short-lived deprecated aliases.
- Do not keep `/repointel mode`, `/repointel trace`, `/repointel warm`,
  `/repointel endpoint`, or `/repointel bin` as runtime controls. They should
  point users to `/repo-intel` diagnostics/configuration without mutating
  config.
