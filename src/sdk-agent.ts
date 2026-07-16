/**
 * SDK subpath entry — `@kodax-ai/kodax/agent`
 *
 * Re-exports the entire `@kodax-ai/agent` public API so SDK consumers
 * can pull agent primitives directly without going through the broader
 * `runKodaX` surface.
 *
 * Usage:
 * ```ts
 * import { Runner } from '@kodax-ai/kodax/agent';
 * ```
 *
 * See docs/ADR.md ADR-024 for the SDK formalization decision.
 */

export * from '@kodax-ai/agent';
