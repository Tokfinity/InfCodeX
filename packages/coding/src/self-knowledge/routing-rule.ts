/**
 * FEATURE_218 — the single short prompt rule that routes KodaX product
 * questions to the kodax_manual tool. Kept ≤250 tokens so the base/system
 * prompt cache region stays clean (no manual content injected here — the
 * manual is read on demand via the tool).
 */

export const SELF_KNOWLEDGE_ROUTING_RULE = [
  'KodaX self-knowledge: when the user asks how to use, install, configure,',
  'troubleshoot, or extend KodaX itself — providers, custom providers, config,',
  'permissions, slash commands, tools, custom agents, skills, MCP, repo',
  'intelligence, sessions, the doctor command, or the SDK — call the',
  'kodax_manual tool first and answer from it.',
  '',
  'Treat kodax_manual as the version-bound source of truth for KodaX product',
  'behavior. Do not answer these from pretraining, because pretraining mixes in',
  "Claude Code and Codex CLI knowledge that does not match KodaX — KodaX uses",
  '~/.kodax/config.json and KODAX_* env vars, not .claude/settings.json or',
  'config.toml. Only bring up Claude Code or Codex when the user explicitly asks',
  'to compare. Project AGENTS.md still governs work in the current repo; the',
  'manual governs questions about KodaX as a product.',
].join('\n');
