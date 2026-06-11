/**
 * FEATURE_222 — MCP 2025-11-25 reverse capabilities (server→client).
 *
 * KodaX's MCP client historically advertised `capabilities: {}` and answered
 * every server→client request with `-32601`. This module is the host-injected
 * seam that lets the client actually serve the reverse capabilities — roots,
 * elicitation, sampling (and, later, tasks).
 *
 * Core principle (spec MUST: "both sides only use capabilities they
 * negotiated"): a capability is advertised in `initialize.capabilities` ONLY
 * when its handler is injected. An absent handler stays unadvertised, so a
 * conformant server never sends the corresponding request. `buildInitialize-
 * Capabilities` assembles that declaration from the handlers actually present,
 * which is what makes the feature incrementally shippable, slice by slice.
 */

/** A workspace root exposed to a server. The spec requires a `file://` URI. */
export interface McpRoot {
  readonly uri: string;
  readonly name?: string;
}

/** A server-initiated elicitation request (form mode now; url mode in Slice C). */
export interface McpElicitRequest {
  readonly mode: 'form' | 'url';
  /** The MCP server making the request. The host MUST show this to the user so
   *  they know who is asking (anti-phishing). Enriched by the runtime. */
  readonly serverId?: string;
  readonly message?: string;
  /** form mode: a flat object of primitive properties to collect. */
  readonly requestedSchema?: Record<string, unknown>;
  /** url mode: the URL the user must be shown + asked to consent to. */
  readonly url?: string;
  /** url mode: correlation id echoed in `notifications/elicitation/complete`. */
  readonly elicitationId?: string;
}

/** The three-state elicitation response defined by the spec. */
export type McpElicitResult =
  | { readonly action: 'accept'; readonly content: Record<string, unknown> }
  | { readonly action: 'decline' }
  | { readonly action: 'cancel' };

/** A server-initiated sampling request (`sampling/createMessage`). */
export interface McpSamplingRequest {
  readonly messages: readonly unknown[];
  readonly systemPrompt?: string;
  readonly maxTokens?: number;
  readonly modelPreferences?: Record<string, unknown>;
  /** The server id asking — for the host's user-visible prompt + guardrails. */
  readonly serverId: string;
}

/** A sampling response bridged back from the user's LLM. */
export interface McpSamplingResult {
  readonly role: 'assistant';
  readonly content: { readonly type: 'text'; readonly text: string };
  readonly model: string;
  readonly stopReason?: string;
}

/**
 * Host-injected reverse-capability handlers. Each present handler lights up its
 * capability; an absent one stays unadvertised (server won't ask). Handlers are
 * provided by the host (REPL / ACP / CLI) because only it owns the workspace,
 * the user-interaction channel, and the LLM. A headless host injects nothing
 * and the client behaves exactly as before (all reverse requests → -32601).
 */
export interface McpReverseCapabilities {
  /** Slice A — current workspace roots (a function so it reflects live state). */
  readonly listRoots?: () => readonly McpRoot[] | Promise<readonly McpRoot[]>;
  /** Whether to advertise `roots.listChanged` (default false). */
  readonly rootsListChanged?: boolean;
  /**
   * Slice B/C — ask the user (form or url elicitation). For `mode:'url'` the
   * host MUST show the full URL + its domain, require explicit consent, and
   * MUST NOT auto-open the browser or expose the URL/contents to the model
   * (anti-phishing). It resolves `accept` when the user consents to open the
   * URL; the server later signals completion via {@link onElicitationComplete}.
   */
  readonly elicit?: (request: McpElicitRequest) => Promise<McpElicitResult>;
  /** Which elicitation modes the injected `elicit` actually supports. Defaults
   *  to form-only (url is gated on the anti-phishing handler from Slice C). */
  readonly elicitationModes?: { readonly form?: boolean; readonly url?: boolean };
  /**
   * Slice C — the server finished a url elicitation (the user completed the
   * external flow in their browser); the host can dismiss its waiting state.
   * Correlated by the `elicitationId` from the original url request.
   */
  readonly onElicitationComplete?: (elicitationId: string) => void;
  /** Slice D — run a sampling request via the user's LLM. Security-sensitive:
   *  the host injects this ONLY when the user opted in, and applies guardrails. */
  readonly sample?: (request: McpSamplingRequest) => Promise<McpSamplingResult>;
}

/**
 * Build the `initialize.capabilities` object from the injected handlers —
 * advertise only what we can actually handle.
 */
export function buildInitializeCapabilities(
  reverse: McpReverseCapabilities | undefined,
): Record<string, unknown> {
  const capabilities: Record<string, unknown> = {};
  if (!reverse) return capabilities;

  if (reverse.listRoots) {
    capabilities.roots = { listChanged: reverse.rootsListChanged ?? false };
  }

  if (reverse.elicit) {
    const modes = reverse.elicitationModes;
    const form = modes?.form ?? true;
    const url = modes?.url === true;
    const elicitation: Record<string, unknown> = {};
    // Default to form-only; url is advertised only when the host declares it
    // (it requires the Slice C anti-phishing browser-open handler).
    if (form) elicitation.form = {};
    if (url) elicitation.url = {};
    if (form || url) capabilities.elicitation = elicitation;
  }

  if (reverse.sample) {
    capabilities.sampling = {};
  }

  return capabilities;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Parse a raw `elicitation/create` params object into a typed request. */
export function parseElicitRequest(params: Record<string, unknown> | undefined): McpElicitRequest {
  const p = params ?? {};
  const message = typeof p.message === 'string' ? p.message : undefined;
  if (p.mode === 'url') {
    return {
      mode: 'url',
      message,
      url: typeof p.url === 'string' ? p.url : undefined,
      elicitationId: typeof p.elicitationId === 'string' ? p.elicitationId : undefined,
    };
  }
  return { mode: 'form', message, requestedSchema: asObject(p.requestedSchema) };
}

/** Whether the injected host handler is allowed to receive this elicitation mode. */
export function canHandleElicitMode(
  reverse: McpReverseCapabilities,
  mode: McpElicitRequest['mode'],
): boolean {
  const modes = reverse.elicitationModes;
  if (mode === 'url') return modes?.url === true;
  return modes?.form ?? true;
}

/** Parse a raw `sampling/createMessage` params object into a typed host request. */
export function parseSamplingRequest(
  params: Record<string, unknown> | undefined,
  serverId: string,
): McpSamplingRequest {
  const p = params ?? {};
  return {
    serverId,
    messages: Array.isArray(p.messages) ? p.messages : [],
    systemPrompt: typeof p.systemPrompt === 'string' ? p.systemPrompt : undefined,
    maxTokens: typeof p.maxTokens === 'number' && Number.isFinite(p.maxTokens)
      ? p.maxTokens
      : undefined,
    modelPreferences: asObject(p.modelPreferences),
  };
}

/**
 * Validate a host-supplied elicit result into the wire response. A malformed
 * result degrades to `{ action: 'cancel' }` — the safe default (the server
 * treats cancel as "user dismissed", never as data).
 */
export function normalizeElicitResult(result: McpElicitResult): Record<string, unknown> {
  if (result?.action === 'accept') {
    return { action: 'accept', content: asObject(result.content) ?? {} };
  }
  if (result?.action === 'decline') {
    return { action: 'decline' };
  }
  return { action: 'cancel' };
}
