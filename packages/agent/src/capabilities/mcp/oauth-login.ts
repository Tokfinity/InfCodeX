/**
 * FEATURE_222 — MCP OAuth interactive login (discovery-based, zero-config).
 *
 * Composes the discovery layer ({@link ./oauth-discovery}) with PKCE, dynamic
 * client registration (RFC 7591), the RFC 8707 `resource` indicator, a loopback
 * redirect, and token persistence into one `performOAuthLogin` orchestrator:
 *
 *   discover endpoints → load-or-register client → PKCE authorize (host shows
 *   the URL + consents) → loopback callback → token exchange → persist.
 *
 * The host never has the browser opened for it automatically: it is handed the
 * authorization URL through a consent callback (anti-phishing), exactly like a
 * url elicitation. KodaX never embeds a secret it was not issued.
 */
import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { getAgentConfigPath } from '../../runtime/agent-home.js';
import {
  generatePKCE,
  isTokenExpired,
  loadToken,
  parseTokenResponse,
  safeParseJsonResponse,
  saveToken,
  startCallbackServer,
  type OAuthToken,
} from './oauth.js';
import { discoverOAuthEndpoints } from './oauth-discovery.js';

/** Default loopback port for the OAuth callback (override per server in config). */
export const DEFAULT_OAUTH_REDIRECT_PORT = 33418;

/** A dynamically-registered (or pre-configured) OAuth client. */
export interface OAuthClientInfo {
  readonly clientId: string;
  readonly clientSecret?: string;
}

function getClientDir(): string {
  return getAgentConfigPath('mcp-clients');
}

function getClientPath(serverId: string): string {
  return path.join(getClientDir(), `${serverId}.json`);
}

/** Load a persisted dynamically-registered client, if any. */
export async function loadClientInfo(serverId: string): Promise<OAuthClientInfo | null> {
  try {
    const data = await fs.readFile(getClientPath(serverId), 'utf-8');
    const parsed = JSON.parse(data) as OAuthClientInfo;
    return typeof parsed.clientId === 'string' && parsed.clientId.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist a dynamically-registered client (owner-only file perms). */
export async function saveClientInfo(serverId: string, info: OAuthClientInfo): Promise<void> {
  await fs.mkdir(getClientDir(), { recursive: true, mode: 0o700 });
  const target = getClientPath(serverId);
  await fs.writeFile(target, JSON.stringify(info, null, 2), 'utf-8');
  if (process.platform !== 'win32') {
    await fs.chmod(target, 0o600);
  }
}

/**
 * RFC 7591 Dynamic Client Registration. Registers a public client (PKCE, no
 * secret) for the loopback redirect and returns the issued client_id.
 */
export async function registerOAuthClient(options: {
  registrationEndpoint: string;
  redirectUri: string;
  clientName: string;
  scope?: string;
  fetchFn?: typeof fetch;
}): Promise<OAuthClientInfo> {
  const fetchFn = options.fetchFn ?? fetch;
  const body: Record<string, unknown> = {
    client_name: options.clientName,
    redirect_uris: [options.redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
  if (options.scope) body.scope = options.scope;

  const response = await fetchFn(options.registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OAuth dynamic client registration failed (${response.status}): ${text}`);
  }
  const data = await safeParseJsonResponse(response, 'OAuth client registration');
  const clientId = typeof data.client_id === 'string' ? data.client_id : '';
  if (!clientId) throw new Error('OAuth client registration response had no client_id');
  return {
    clientId,
    clientSecret: typeof data.client_secret === 'string' ? data.client_secret : undefined,
  };
}

/** Build the authorization redirect URL (PKCE S256 + optional RFC 8707 resource). */
export function buildAuthorizeUrl(options: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scope?: string;
  resource?: string;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    state: options.state,
    code_challenge: options.challenge,
    code_challenge_method: 'S256',
  });
  if (options.scope) params.set('scope', options.scope);
  if (options.resource) params.set('resource', options.resource);
  return `${options.authorizationEndpoint}?${params.toString()}`;
}

/** Exchange an authorization code for tokens (with RFC 8707 resource). */
export async function exchangeCodeForTokenWithResource(options: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  code: string;
  verifier: string;
  redirectUri: string;
  resource?: string;
  fetchFn?: typeof fetch;
}): Promise<OAuthToken> {
  const fetchFn = options.fetchFn ?? fetch;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: options.clientId,
    code: options.code,
    redirect_uri: options.redirectUri,
    code_verifier: options.verifier,
  });
  if (options.clientSecret) body.set('client_secret', options.clientSecret);
  if (options.resource) body.set('resource', options.resource);

  const response = await fetchFn(options.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OAuth token exchange failed (${response.status}): ${text}`);
  }
  const data = await safeParseJsonResponse(response, 'OAuth token exchange');
  return parseTokenResponse(data);
}

/** Refresh a token against a discovered endpoint (with RFC 8707 resource). */
export async function refreshTokenWithResource(options: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  resource?: string;
  fetchFn?: typeof fetch;
}): Promise<OAuthToken> {
  const fetchFn = options.fetchFn ?? fetch;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: options.clientId,
    refresh_token: options.refreshToken,
  });
  if (options.clientSecret) body.set('client_secret', options.clientSecret);
  if (options.resource) body.set('resource', options.resource);

  const response = await fetchFn(options.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OAuth token refresh failed (${response.status}): ${text}`);
  }
  const data = await safeParseJsonResponse(response, 'OAuth token refresh');
  return parseTokenResponse(data);
}

/**
 * The host's consent gate for a login. Receives the authorization URL and must
 * return true to proceed (the user will open it in their browser). Returning
 * false aborts the login. KodaX never auto-opens the URL.
 */
export type OAuthLoginConsent = (authorizationUrl: string) => Promise<boolean>;

export interface PerformOAuthLoginOptions {
  serverId: string;
  /** The MCP server URL (resource) we are authenticating to. */
  serverUrl: string;
  /** resource_metadata URL from a 401 challenge, if one was seen. */
  resourceMetadataUrl?: string;
  /** A pre-configured client_id (skips dynamic registration). */
  configuredClientId?: string;
  /** Pre-configured scopes (override discovery). */
  configuredScopes?: readonly string[];
  /** For an insufficient_scope step-up: the elevated scope to request. */
  stepUpScope?: string;
  /** Host consent gate (anti-phishing) — receives the authorization URL. */
  consent: OAuthLoginConsent;
  /** Loopback callback port (defaults to {@link DEFAULT_OAUTH_REDIRECT_PORT}). */
  redirectPort?: number;
  fetchFn?: typeof fetch;
}

/**
 * Run the full interactive login and persist the resulting token. Returns the
 * token, or undefined when discovery fails, no client can be obtained, or the
 * user declines consent. Throws only on a hard protocol error (bad exchange).
 */
export async function performOAuthLogin(
  options: PerformOAuthLoginOptions,
): Promise<OAuthToken | undefined> {
  const endpoints = await discoverOAuthEndpoints({
    serverUrl: options.serverUrl,
    resourceMetadataUrl: options.resourceMetadataUrl,
    fetchFn: options.fetchFn,
  });
  if (!endpoints) return undefined;

  const scope = options.stepUpScope
    ?? (options.configuredScopes && options.configuredScopes.length > 0
      ? options.configuredScopes.join(' ')
      : undefined)
    ?? (endpoints.resourceScopesSupported ?? endpoints.scopesSupported)?.join(' ');

  const port = options.redirectPort ?? DEFAULT_OAUTH_REDIRECT_PORT;
  const redirectUri = `http://localhost:${port}/callback`;

  const client = await resolveClient(options, endpoints.registrationEndpoint, redirectUri, scope);
  if (!client) return undefined;

  const pkce = generatePKCE();
  const state = randomBytes(16).toString('base64url');
  const authorizationUrl = buildAuthorizeUrl({
    authorizationEndpoint: endpoints.authorizationEndpoint,
    clientId: client.clientId,
    redirectUri,
    state,
    challenge: pkce.challenge,
    scope,
    resource: endpoints.resource,
  });

  if (!(await options.consent(authorizationUrl))) return undefined;

  const callback = await startCallbackServer(port);
  try {
    if (callback.state !== state) {
      throw new Error('OAuth callback state mismatch (possible CSRF) — login aborted.');
    }
    const token = await exchangeCodeForTokenWithResource({
      tokenEndpoint: endpoints.tokenEndpoint,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      code: callback.code,
      verifier: pkce.verifier,
      redirectUri,
      resource: endpoints.resource,
      fetchFn: options.fetchFn,
    });
    await saveToken(options.serverId, token);
    return token;
  } finally {
    callback.server.close();
  }
}

/** Resolve the OAuth client: configured id, a cached DCR client, or a fresh DCR. */
async function resolveClient(
  options: PerformOAuthLoginOptions,
  registrationEndpoint: string | undefined,
  redirectUri: string,
  scope: string | undefined,
): Promise<OAuthClientInfo | undefined> {
  if (options.configuredClientId) {
    return { clientId: options.configuredClientId };
  }
  const cached = await loadClientInfo(options.serverId);
  if (cached) return cached;
  if (!registrationEndpoint) return undefined;
  const registered = await registerOAuthClient({
    registrationEndpoint,
    redirectUri,
    clientName: `KodaX (${options.serverId})`,
    scope,
    fetchFn: options.fetchFn,
  });
  await saveClientInfo(options.serverId, registered);
  return registered;
}

/**
 * Return a still-valid cached token for a server, or undefined. (Discovery-based
 * refresh on expiry is driven by the connect flow, which knows the endpoints.)
 */
export async function loadValidToken(serverId: string): Promise<OAuthToken | undefined> {
  const cached = await loadToken(serverId);
  return cached && !isTokenExpired(cached) ? cached : undefined;
}
