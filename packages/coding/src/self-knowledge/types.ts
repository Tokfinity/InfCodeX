/**
 * FEATURE_218 — KodaX Self-Knowledge Manual types.
 *
 * A bundled, version-bound product manual that answers "how do I use /
 * configure / install / troubleshoot KodaX?" questions. Pure data + a
 * deterministic resolver — no RAG, no vector store, no network fetch.
 */

export type KodaXManualTopicId =
  | 'overview'
  | 'license'
  | 'install'
  | 'quickstart'
  | 'providers'
  | 'custom-providers'
  | 'config'
  | 'permissions'
  | 'commands'
  | 'tools'
  | 'agents'
  | 'skills'
  | 'extensions'
  | 'mcp'
  | 'a2a'
  | 'repo-intelligence'
  | 'sessions'
  | 'memory'
  | 'doctor'
  | 'sdk'
  | 'troubleshooting';

/** A pointer to the code/doc the topic is derived from (for traceability). */
export interface KodaXManualSource {
  readonly label: string;
  readonly path: string;
}

/** Lightweight index metadata; topic bodies stay behind exact-topic lookup. */
export interface KodaXManualIndexTopic {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
}

export interface KodaXManualTopic {
  readonly id: KodaXManualTopicId;
  /** Human title, shown as the answer heading. */
  readonly title: string;
  /** Lookup aliases (English + Chinese high-frequency terms). */
  readonly aliases: readonly string[];
  /** One-line summary, shown in the index listing. */
  readonly summary: string;
  /** Exact topic body. Dynamic parts read live constants so it cannot drift from code. */
  readonly body: string;
  readonly sources: readonly KodaXManualSource[];
  readonly nextTopics: readonly KodaXManualTopicId[];
}

export interface ResolveKodaXManualInput {
  /** Exact topic id or alias. Takes precedence over `query`. */
  readonly topic?: string;
  /** Free-text question; resolved by alias + token overlap. */
  readonly query?: string;
}

/**
 * FEATURE_221 — a topic an SDK consumer (e.g. a product built on KodaX)
 * injects via `KodaXOptions.selfManual.topics`. Same shape as a KodaX base
 * topic but `id` is a free string (new id = add; existing base id = override),
 * and aliases/nextTopics/sources are optional to lower the authoring burden.
 * Exact-topic bodies are returned completely; normal tool-result admission
 * owns any request-level capacity fallback.
 */
export interface KodaXManualTopicInput {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly aliases?: readonly string[];
  readonly nextTopics?: readonly string[];
  readonly sources?: readonly KodaXManualSource[];
}

/** Per-call resolver options — consumer topic injection + product re-branding. */
export interface ResolveKodaXManualOptions {
  /** Injected consumer topics, merged over the seeded base (override by id, then append). */
  readonly extraTopics?: readonly KodaXManualTopicInput[];
  /** Product name used in the scope anchor (default "KodaX"). */
  readonly productName?: string;
  /**
   * FEATURE_221 — which KodaX base topics to SEED before `extraTopics` is
   * layered on top. Orthogonal to `extraTopics` (whose override-by-id/append
   * semantics are unchanged).
   *
   *   - `undefined` → seed all base topics (`MANUAL_TOPIC_IDS`), preserving the
   *     legacy topic selection behavior.
   *   - `[]` → seed ZERO base topics; only `extraTopics` populate the manual
   *     (full white-label replace).
   *   - `KodaXManualTopicId[]` → seed exactly this curated subset (e.g.
   *     `KODAX_UNDERLYING_CAPABILITY_TOPICS`), so a replacing consumer can still
   *     keep the mechanism topics its product inherits from KodaX.
   */
  readonly baseTopics?: readonly KodaXManualTopicId[];
}

export interface ResolveKodaXManualResult {
  /** A topic id (KodaX base or injected consumer topic), or 'index'. */
  readonly matchedTopic: string;
  readonly title: string;
  /** Complete exact-topic content, or a short index/search instruction. */
  readonly content: string;
  /** Structured index candidates; empty for an exact-topic result. */
  readonly topics: readonly KodaXManualIndexTopic[];
  readonly sources: readonly KodaXManualSource[];
  readonly nextTopics: readonly string[];
}
