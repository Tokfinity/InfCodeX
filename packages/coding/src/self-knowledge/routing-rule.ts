/**
 * FEATURE_218 — the single short prompt rule that routes product questions to
 * the kodax_manual tool. Kept ≤250 tokens so the base/system prompt cache
 * region stays clean (no manual content injected here — read on demand).
 * FEATURE_221 — `productName` re-brands the rule for SDK consumers (e.g. a
 * product built on KodaX); defaults to "KodaX".
 */

export function buildSelfKnowledgeRoutingRule(productName = 'KodaX'): string {
  return [
    `${productName} self-knowledge: when the user asks how to use, install, configure,`,
    `troubleshoot, or extend ${productName} itself — providers, custom providers, config,`,
    'permissions, slash commands, tools, custom agents, skills, MCP, repo',
    'intelligence, sessions, the doctor command, or the SDK — call the',
    'kodax_manual tool first and answer from it.',
    '',
    `Treat kodax_manual as the version-bound source of truth for ${productName} product`,
    'behavior. Do not answer these from pretraining, because pretraining mixes in',
    `Claude Code and Codex CLI knowledge that does not match ${productName} — KodaX uses`,
    '~/.kodax/config.json and KODAX_* env vars, not .claude/settings.json or',
    'config.toml. Only bring up Claude Code or Codex when the user explicitly asks',
    'to compare. Project AGENTS.md still governs work in the current repo; the',
    `manual governs questions about ${productName} as a product.`,
  ].join('\n');
}

/** Default KodaX routing rule (backward-compatible const). */
export const SELF_KNOWLEDGE_ROUTING_RULE = buildSelfKnowledgeRoutingRule();
