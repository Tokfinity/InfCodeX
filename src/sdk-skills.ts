/**
 * SDK subpath entry — `@kodax-ai/kodax/skills`
 *
 * Re-exports the skill loader / resolver / registry / frontmatter parser
 * surface. Post-FEATURE_194 (v0.7.43) skills lives inside
 * `@kodax-ai/agent` at `capabilities/skills/`; this subpath remains as a
 * stable consumer-facing alias.
 *
 * Usage:
 * ```ts
 * import { loadSkill, SkillRegistry } from '@kodax-ai/kodax/skills';
 * ```
 *
 * See docs/ADR.md ADR-024 (SDK subpath formalization) and ADR-036
 * (FEATURE_194 package consolidation 9 → 4).
 */

export * from '@kodax-ai/agent';
