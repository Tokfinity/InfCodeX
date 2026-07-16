/**
 * FEATURE_222 — MCP OAuth discovery (server→authorization-server resolution).
 *
 * The modern MCP auth flow does NOT require the user to hand-configure
 * authorization/token endpoints. Instead the client discovers them at runtime:
 *
 *   401 WWW-Authenticate (resource_metadata=...)         [RFC 9728 pointer]
 *     → GET /.well-known/oauth-protected-resource        [RFC 9728 PRM]
 *       → authorization_servers[0]
 *         → GET /.well-known/oauth-authorization-server  [RFC 8414]
 *            (fallback /.well-known/openid-configuration) [OIDC]
 *           → authorization_endpoint / token_endpoint / registration_endpoint
 *
 * This module is the pure-HTTP discovery layer (no PKCE, no browser, no token
 * storage — those compose on top). The path-aware fallback ordering mirrors
 * Claude Code's MCP client so KodaX resolves the same servers it does.
 */

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => readString(item))
    .filter((item): item is string => item !== undefined);
  return items.length > 0 ? items : undefined;
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/** GET a discovery document; resolves to its JSON object, or undefined on any
 *  non-200 / non-object / network error (callers try the next candidate URL). */
async function fetchJsonObject(
  fetchFn: typeof fetch,
  url: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetchFn(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return undefined;
    const json: unknown = await response.json();
    return json && typeof json === 'object' && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// WWW-Authenticate (RFC 7235) parsing — the 401/403 challenge carries both the
// RFC 9728 resource_metadata pointer and the step-up `scope` for insufficient
// scope errors.
// ---------------------------------------------------------------------------

export interface WwwAuthenticateChallenge {
  readonly scheme: string;
  readonly params: Record<string, string>;
}

/** Parse a single `Scheme key="value", key=value` challenge. Returns undefined
 *  for an empty header. Only the first scheme is parsed (sufficient for Bearer). */
export function parseWwwAuthenticate(header: string | undefined): WwwAuthenticateChallenge | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  const spaceIdx = trimmed.indexOf(' ');
  const scheme = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1);
  const params: Record<string, string> = {};
  const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(rest)) !== null) {
    params[match[1].toLowerCase()] = match[2] !== undefined ? match[2] : match[3];
  }
  return { scheme, params };
}

/** The RFC 9728 `resource_metadata` URL a 401 challenge points at, if any. */
export function extractResourceMetadataUrl(header: string | undefined): string | undefined {
  return readString(parseWwwAuthenticate(header)?.params.resource_metadata);
}

/**
 * For a 403 `error="insufficient_scope"` challenge, the `scope` the server now
 * requires (space-separated). Undefined when the challenge is not a step-up.
 */
export function extractInsufficientScope(header: string | undefined): string | undefined {
  const challenge = parseWwwAuthenticate(header);
  if (challenge?.params.error !== 'insufficient_scope') return undefined;
  return readString(challenge.params.scope);
}

// ---------------------------------------------------------------------------
// RFC 9728 — Protected Resource Metadata
// ---------------------------------------------------------------------------

export interface ProtectedResourceMetadata {
  readonly authorizationServers: string[];
  readonly resource?: string;
  readonly scopesSupported?: string[];
}

/**
 * Discover the protected-resource metadata for an MCP server URL. Prefers the
 * `resource_metadata` URL from the 401 challenge; otherwise probes the
 * path-specific then root `/.well-known/oauth-protected-resource`.
 */
export async function discoverProtectedResourceMetadata(options: {
  serverUrl: string;
  resourceMetadataUrl?: string;
  fetchFn?: typeof fetch;
}): Promise<ProtectedResourceMetadata | undefined> {
  const fetchFn = options.fetchFn ?? fetch;
  const url = new URL(options.serverUrl);
  const pathname = url.pathname === '/' ? '' : url.pathname;
  const candidates = dedupe([
    ...(options.resourceMetadataUrl ? [options.resourceMetadataUrl] : []),
    ...(pathname ? [`${url.origin}/.well-known/oauth-protected-resource${pathname}`] : []),
    `${url.origin}/.well-known/oauth-protected-resource`,
  ]);

  for (const candidate of candidates) {
    const json = await fetchJsonObject(fetchFn, candidate);
    const authorizationServers = toStringArray(json?.authorization_servers);
    if (!authorizationServers) continue;
    return {
      authorizationServers,
      resource: readString(json?.resource),
      scopesSupported: toStringArray(json?.scopes_supported),
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// RFC 8414 / OIDC — Authorization Server Metadata
// ---------------------------------------------------------------------------

export interface AuthorizationServerMetadata {
  readonly issuer?: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint?: string;
  readonly scopesSupported?: string[];
  readonly codeChallengeMethodsSupported?: string[];
}

/**
 * The well-known discovery URLs to try for an authorization server, in order.
 * Mirrors Claude Code: oauth-authorization-server before openid-configuration,
 * and path-aware variants for multi-tenant issuers.
 */
export function buildAsDiscoveryUrls(authorizationServerUrl: string): string[] {
  const url = new URL(authorizationServerUrl);
  const pathname = url.pathname.replace(/\/$/, '');
  if (!pathname) {
    return [
      `${url.origin}/.well-known/oauth-authorization-server`,
      `${url.origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${url.origin}/.well-known/oauth-authorization-server${pathname}`,
    `${url.origin}/.well-known/openid-configuration${pathname}`,
    `${url.origin}${pathname}/.well-known/openid-configuration`,
  ];
}

/** Discover an authorization server's endpoints. The first candidate returning
 *  both an authorization + token endpoint wins. */
export async function discoverAuthorizationServerMetadata(options: {
  authorizationServerUrl: string;
  fetchFn?: typeof fetch;
}): Promise<AuthorizationServerMetadata | undefined> {
  const fetchFn = options.fetchFn ?? fetch;
  for (const candidate of buildAsDiscoveryUrls(options.authorizationServerUrl)) {
    const json = await fetchJsonObject(fetchFn, candidate);
    const authorizationEndpoint = readString(json?.authorization_endpoint);
    const tokenEndpoint = readString(json?.token_endpoint);
    if (!authorizationEndpoint || !tokenEndpoint) continue;
    return {
      issuer: readString(json?.issuer),
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint: readString(json?.registration_endpoint),
      scopesSupported: toStringArray(json?.scopes_supported),
      codeChallengeMethodsSupported: toStringArray(json?.code_challenge_methods_supported),
    };
  }
  return undefined;
}

/**
 * End-to-end endpoint discovery: PRM → first authorization server → AS metadata.
 * Returns the resolved endpoints plus the resource indicator (RFC 8707) and the
 * scopes the resource advertises. Undefined when discovery fails at any step.
 */
export interface DiscoveredOAuthEndpoints extends AuthorizationServerMetadata {
  /** RFC 8707 resource indicator (the MCP server's canonical URL). */
  readonly resource?: string;
  /** Scopes from the protected-resource document, when the AS omits them. */
  readonly resourceScopesSupported?: string[];
}

export async function discoverOAuthEndpoints(options: {
  serverUrl: string;
  resourceMetadataUrl?: string;
  fetchFn?: typeof fetch;
}): Promise<DiscoveredOAuthEndpoints | undefined> {
  const prm = await discoverProtectedResourceMetadata(options);
  if (!prm || prm.authorizationServers.length === 0) return undefined;
  const as = await discoverAuthorizationServerMetadata({
    authorizationServerUrl: prm.authorizationServers[0],
    fetchFn: options.fetchFn,
  });
  if (!as) return undefined;
  return {
    ...as,
    resource: prm.resource ?? options.serverUrl,
    resourceScopesSupported: prm.scopesSupported,
  };
}
