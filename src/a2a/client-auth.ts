import * as oauth from 'oauth4webapi';

import { decodeUtf8, safeA2AFetch } from './safe-fetch.js';
import {
  parseOAuthEndpointUrl,
  parseOAuthIssuerIdentifier,
  parseOAuthResourceIdentifier,
  parseOAuthScopeList,
  requireNonEmptyString,
} from './security.js';
import type { A2ANetworkPolicy } from './types.js';

const MAX_EARLY_EXPIRY_MS = 60_000;
const MIN_EARLY_EXPIRY_MS = 1_000;
const EARLY_EXPIRY_RATIO = 0.1;

export interface OAuth2ClientCredentialsTokenManagerOptions {
  readonly issuer: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly scopes?: readonly string[];
  readonly resource?: string;
  readonly clientAuthenticationMethod: 'basic' | 'post';
  readonly networkPolicy: A2ANetworkPolicy;
  /** Trusted transport override. Safe URL validation is still applied before it is invoked. */
  readonly fetch?: typeof globalThis.fetch;
  /** Clock injection for deterministic expiry tests. */
  readonly now?: () => number;
}

export interface OAuth2ClientCredentialsTokenManager {
  getAuthorization(clientSecret: string): Promise<string>;
  /** Pass a rejected value for compare-and-clear; omit it only for an explicit full reset. */
  invalidate(rejectedAuthorization?: string): void;
}

interface CachedAuthorization {
  readonly value: string;
  readonly expiresAt: number;
}

function oauthResponse(response: Response, body: Uint8Array): Response {
  return new Response(body.byteLength === 0 ? null : decodeUtf8(body), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function cacheExpiry(now: number, expiresIn: number | undefined): number {
  if (expiresIn === undefined || expiresIn <= 0) return now;
  const lifetimeMs = expiresIn * 1_000;
  const earlyExpiryMs = Math.min(
    MAX_EARLY_EXPIRY_MS,
    Math.max(MIN_EARLY_EXPIRY_MS, lifetimeMs * EARLY_EXPIRY_RATIO),
  );
  return now + Math.max(0, lifetimeMs - earlyExpiryMs);
}

/**
 * Creates a process-local client-credentials token manager.
 *
 * The secret is supplied only when a refresh is needed so callers can resolve a
 * rotated credential immediately before use. Tokens and secrets are never persisted.
 */
export function createOAuth2ClientCredentialsTokenManager(
  options: OAuth2ClientCredentialsTokenManagerOptions,
): OAuth2ClientCredentialsTokenManager {
  const clientId = requireNonEmptyString(options.clientId, 'OAuth 2.0 clientId');
  if (options.clientAuthenticationMethod !== 'basic' && options.clientAuthenticationMethod !== 'post') {
    throw new Error('OAuth 2.0 clientAuthenticationMethod must be basic or post.');
  }
  const clientAuthenticationMethod = options.clientAuthenticationMethod;
  const scopes = options.scopes === undefined
    ? undefined
    : parseOAuthScopeList(options.scopes, 'OAuth 2.0 scopes');
  const issuer = parseOAuthIssuerIdentifier(options.issuer, 'OAuth 2.0 issuer');
  const tokenUrl = parseOAuthEndpointUrl(options.tokenUrl, 'OAuth 2.0 token endpoint');
  const resource = options.resource === undefined
    ? undefined
    : parseOAuthResourceIdentifier(options.resource, 'OAuth 2.0 resource');
  const authorizationServer: oauth.AuthorizationServer = {
    issuer,
    token_endpoint: tokenUrl.href,
  };
  const client: oauth.Client = { client_id: clientId };
  const policy: A2ANetworkPolicy = { ...options.networkPolicy, maxRedirects: 0 };
  const now = options.now ?? Date.now;
  let cached: CachedAuthorization | undefined;
  let inFlight: Promise<string> | undefined;
  let generation = 0;

  async function requestAuthorization(clientSecret: string): Promise<CachedAuthorization> {
    const clientAuthentication = clientAuthenticationMethod === 'post'
      ? oauth.ClientSecretPost(clientSecret)
      : oauth.ClientSecretBasic(clientSecret);
    const parameters = new URLSearchParams();
    if (scopes && scopes.length > 0) {
      parameters.set('scope', scopes.join(' '));
    }
    if (resource !== undefined) parameters.set('resource', resource);
    const requestOptions: oauth.ClientCredentialsGrantRequestOptions = {
      [oauth.customFetch]: async (url, init) => {
        if (new URL(url).href !== tokenUrl.href) {
          throw new Error('OAuth 2.0 token request targeted an unexpected endpoint.');
        }
        const result = await safeA2AFetch(tokenUrl, {
          method: init.method,
          headers: init.headers,
          body: init.body,
          redirect: 'manual',
          ...(init.signal !== undefined ? { signal: init.signal } : {}),
        }, policy, options.fetch);
        return oauthResponse(result.response, result.body);
      },
    };
    if (tokenUrl.protocol === 'http:') requestOptions[oauth.allowInsecureRequests] = true;

    let token: oauth.TokenEndpointResponse;
    try {
      const response = await oauth.clientCredentialsGrantRequest(
        authorizationServer,
        client,
        clientAuthentication,
        parameters,
        requestOptions,
      );
      token = await oauth.processClientCredentialsResponse(authorizationServer, client, response);
    } catch {
      throw new Error('OAuth 2.0 client credentials token request failed.');
    }
    if (token.token_type !== 'bearer') {
      throw new Error('OAuth 2.0 token endpoint did not return a Bearer access token.');
    }
    const issuedAt = now();
    return {
      value: `Bearer ${token.access_token}`,
      expiresAt: cacheExpiry(issuedAt, token.expires_in),
    };
  }

  return {
    async getAuthorization(clientSecret) {
      if (clientSecret.length === 0) throw new Error('OAuth 2.0 client secret is required.');
      const current = now();
      if (cached !== undefined && cached.expiresAt > current) return cached.value;
      if (inFlight !== undefined) return inFlight;

      const requestGeneration = generation;
      let request!: Promise<string>;
      request = requestAuthorization(clientSecret)
        .then((authorization) => {
          if (generation === requestGeneration && authorization.expiresAt > now()) {
            cached = authorization;
          }
          return authorization.value;
        })
        .finally(() => {
          if (inFlight === request) inFlight = undefined;
        });
      inFlight = request;
      return request;
    },
    invalidate(rejectedAuthorization) {
      if (rejectedAuthorization !== undefined) {
        if (cached?.value === rejectedAuthorization) cached = undefined;
        return;
      }
      generation += 1;
      cached = undefined;
      inFlight = undefined;
    },
  };
}
