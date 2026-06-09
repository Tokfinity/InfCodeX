/**
 * FEATURE_218 — KodaX Self-Knowledge Manual types.
 *
 * A bundled, version-bound product manual that answers "how do I use /
 * configure / install / troubleshoot KodaX?" questions. Pure data + a
 * deterministic resolver — no RAG, no vector store, no network fetch.
 */

export type KodaXManualTopicId =
  | 'overview'
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
  | 'mcp'
  | 'repo-intelligence'
  | 'sessions'
  | 'doctor'
  | 'sdk'
  | 'troubleshooting';

/** A pointer to the code/doc the topic is derived from (for traceability). */
export interface KodaXManualSource {
  readonly label: string;
  readonly path: string;
}

export interface KodaXManualTopic {
  readonly id: KodaXManualTopicId;
  /** Human title, shown as the answer heading. */
  readonly title: string;
  /** Lookup aliases (English + Chinese high-frequency terms). */
  readonly aliases: readonly string[];
  /** One-line summary, shown in the index listing. */
  readonly summary: string;
  /**
   * Bounded topic body. Built at module load — dynamic parts (e.g. the
   * provider list) read live constants so the manual cannot drift from code.
   */
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
 * Bodies are still byte-capped by the resolver (no unbounded items).
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
  /** Injected consumer topics, merged over the KodaX base (override by id). */
  readonly extraTopics?: readonly KodaXManualTopicInput[];
  /** Product name used in the scope anchor (default "KodaX"). */
  readonly productName?: string;
}

export interface ResolveKodaXManualResult {
  /** A topic id (KodaX base or injected consumer topic), or 'index'. */
  readonly matchedTopic: string;
  readonly title: string;
  /** Assembled, byte-capped content (scope anchor + body, or index list). */
  readonly content: string;
  readonly sources: readonly KodaXManualSource[];
  readonly nextTopics: readonly string[];
}
