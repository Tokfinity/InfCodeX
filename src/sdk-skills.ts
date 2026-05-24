/**
 * SDK subpath entry — `@kodax-ai/kodax/skills`
 *
 * Re-exports the entire `@kodax-ai/agent` public API — skill loader,
 * resolver, registry, frontmatter parser, etc. The `@kodax-ai/agent`
 * package has zero external dependencies, making it the cheapest
 * subpath for SDK consumers to pull in.
 *
 * Usage:
 * ```ts
 * import { loadSkill, SkillRegistry } from '@kodax-ai/kodax/skills';
 * ```
 *
 * See docs/ADR.md ADR-024 for the SDK formalization decision.
 */

export * from '@kodax-ai/agent';
