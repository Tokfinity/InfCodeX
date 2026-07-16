import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { A2AOAuth2JwtAuthenticationConfig } from './config.js';
import { createOAuth2JwtA2AAuthentication } from './server-auth.js';

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function accessToken(
  privateKey: KeyObject,
  claims: Readonly<Record<string, unknown>>,
  kid = 'test-key',
  typ = 'at+jwt',
): string {
  const signingInput = `${base64Url({ alg: 'RS256', kid, typ })}.${base64Url(claims)}`;
  return `${signingInput}.${createSign('RSA-SHA256').update(signingInput).sign(privateKey).toString('base64url')}`;
}

function fixture(fetchOverride?: typeof fetch) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const issuer = 'http://127.0.0.1:44101/';
  const audience = 'http://127.0.0.1:44102/a2a';
  const fetches: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    fetches.push(String(input));
    if (fetchOverride) return fetchOverride(input, init);
    return new Response(JSON.stringify({ keys: [jwk] }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const authentication = createOAuth2JwtA2AAuthentication({
    type: 'oauth2-jwt',
    scheme: 'enterprise-oauth',
    issuer,
    audience,
    jwksUrl: `${issuer}.well-known/jwks.json`,
    tokenUrl: `${issuer}oauth/token`,
    metadataUrl: `${issuer}.well-known/oauth-authorization-server`,
    requiredScopes: ['a2a.invoke'],
  }, fetchImpl);
  return { authentication, privateKey, issuer, audience, fetches };
}

function claims(issuer: string, audience: string, scope = 'a2a.invoke'): Readonly<Record<string, unknown>> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: issuer,
    sub: 'service-client',
    aud: audience,
    exp: now + 300,
    iat: now,
    jti: 'token-1',
    client_id: 'kodax-client',
    scope,
  };
}

describe('A2A OAuth2 JWT resource server authentication', () => {
  it('advertises OAuth2 client credentials and maps a validated subject to a principal', async () => {
    const { authentication, privateKey, issuer, audience, fetches } = fixture();
    const token = accessToken(privateKey, claims(issuer, audience));
    const principal = await authentication.authenticate(new Request(audience, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    }));

    expect(principal).toEqual({ subject: 'service-client', scopes: ['a2a.invoke'] });
    expect(authentication.securityRealm).toBe(`oauth2-jwt:${issuer}`);
    expect(fetches).toHaveLength(1);
    expect(authentication.securitySchemes).toEqual({
      'enterprise-oauth': {
        oauth2SecurityScheme: {
          flows: {
            clientCredentials: {
              tokenUrl: `${issuer}oauth/token`,
              scopes: { 'a2a.invoke': 'Required to invoke this Agent.' },
            },
          },
          oauth2MetadataUrl: `${issuer}.well-known/oauth-authorization-server`,
        },
      },
    });
    expect(authentication.securityRequirements).toEqual([
      { schemes: { 'enterprise-oauth': { list: ['a2a.invoke'] } } },
    ]);
  });

  it('fails closed for an invalid audience and distinguishes insufficient scope', async () => {
    const { authentication, privateKey, issuer, audience } = fixture();
    const wrongAudience = accessToken(privateKey, claims(issuer, `${audience}/other`));
    await expect(authentication.authenticate(new Request(audience, {
      headers: { authorization: `Bearer ${wrongAudience}` },
    }))).rejects.toMatchObject({ httpStatus: 401 });

    const missingScope = accessToken(privateKey, claims(issuer, audience, 'a2a.read'));
    const result = authentication.authenticate(new Request(audience, {
      headers: { authorization: `Bearer ${missingScope}` },
    }));
    await expect(result).rejects.toMatchObject({
      httpStatus: 403,
      headers: { 'www-authenticate': 'Bearer error="insufficient_scope", scope="a2a.invoke"' },
    });
  });

  it('rejects wrong issuer, expired, not-yet-valid, and incorrectly signed access tokens', async () => {
    const { authentication, privateKey, issuer, audience } = fixture();
    const now = Math.floor(Date.now() / 1000);
    const invalidClaims = [
      { ...claims(issuer, audience), iss: `${issuer}other` },
      { ...claims(issuer, audience), exp: now - 60 },
      { ...claims(issuer, audience), nbf: now + 300 },
    ];
    for (const payload of invalidClaims) {
      await expect(authentication.authenticate(new Request(audience, {
        headers: { authorization: `Bearer ${accessToken(privateKey, payload)}` },
      }))).rejects.toMatchObject({ httpStatus: 401 });
    }

    const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    await expect(authentication.authenticate(new Request(audience, {
      headers: { authorization: `Bearer ${accessToken(otherKey, claims(issuer, audience))}` },
    }))).rejects.toMatchObject({ httpStatus: 401 });
  });

  it('does not accept an OIDC ID Token-shaped JWT as an access token', async () => {
    const { authentication, privateKey, issuer, audience } = fixture();
    const token = accessToken(privateKey, claims(issuer, audience), 'test-key', 'JWT');
    await expect(authentication.authenticate(new Request(audience, {
      headers: { authorization: `Bearer ${token}` },
    }))).rejects.toMatchObject({ httpStatus: 401 });
  });

  it('rejects malformed optional scope claims as invalid tokens', async () => {
    const { authentication, privateKey, issuer, audience } = fixture();
    for (const scope of [123, ['a2a.invoke'], 'a2a.invoke\r\nX-Injected: true']) {
      const token = accessToken(privateKey, { ...claims(issuer, audience), scope });
      await expect(authentication.authenticate(new Request(audience, {
        headers: { authorization: `Bearer ${token}` },
      }))).rejects.toMatchObject({
        httpStatus: 401,
        headers: { 'www-authenticate': 'Bearer error="invalid_token"' },
      });
    }
  });

  it('reports JWKS transport and response failures as service unavailable', async () => {
    const cases: readonly {
      readonly name: string;
      readonly fetchImpl: typeof fetch;
    }[] = [
      {
        name: 'DNS failure',
        fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error('getaddrinfo ENOTFOUND')),
      },
      {
        name: 'request timeout',
        fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new DOMException('timed out', 'AbortError')),
      },
      {
        name: 'non-success response',
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response('unavailable', {
          status: 503,
          headers: { 'content-type': 'text/plain' },
        })),
      },
      {
        name: 'malformed JSON',
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response('{', {
          headers: { 'content-type': 'application/json' },
        })),
      },
      {
        name: 'malformed JWKS shape',
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ keys: 'invalid' }), {
          headers: { 'content-type': 'application/json' },
        })),
      },
      {
        name: 'malformed JWK entry',
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ keys: [{}] }), {
          headers: { 'content-type': 'application/json' },
        })),
      },
      {
        name: 'invalid JWKS media type',
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ keys: [] }), {
          headers: { 'content-type': 'text/plain' },
        })),
      },
    ];

    for (const entry of cases) {
      const { authentication, privateKey, issuer, audience } = fixture(entry.fetchImpl);
      const token = accessToken(privateKey, claims(issuer, audience));
      await expect(authentication.authenticate(new Request(audience, {
        headers: { authorization: `Bearer ${token}` },
      })), entry.name).rejects.toMatchObject({ httpStatus: 503, headers: undefined });
    }
  });

  it('rejects unsafe configured scopes when the public factory is called directly', () => {
    expect(() => createOAuth2JwtA2AAuthentication({
      type: 'oauth2-jwt',
      scheme: 'oauth',
      issuer: 'https://identity.example.com',
      audience: 'https://agent.example.com',
      jwksUrl: 'https://identity.example.com/jwks',
      tokenUrl: 'https://identity.example.com/token',
      requiredScopes: ['bad scope'],
    })).toThrow(/scope-token/i);
  });

  it('rejects invalid public resource-server discriminators and required-scope arrays', () => {
    const base: A2AOAuth2JwtAuthenticationConfig = {
      type: 'oauth2-jwt',
      scheme: 'oauth',
      issuer: 'https://identity.example.com',
      audience: 'https://agent.example.com',
      jwksUrl: 'https://identity.example.com/jwks',
      tokenUrl: 'https://identity.example.com/token',
      requiredScopes: ['a2a.invoke'],
    };
    const cases: readonly {
      readonly config: A2AOAuth2JwtAuthenticationConfig;
      readonly pattern: RegExp;
    }[] = [
      {
        config: { ...base, type: 'bearer-env' } as unknown as A2AOAuth2JwtAuthenticationConfig,
        pattern: /type.*oauth2-jwt/i,
      },
      { config: { ...base, scheme: '   ' }, pattern: /scheme.*non-empty/i },
      { config: { ...base, audience: '' }, pattern: /audience.*non-empty/i },
      {
        config: { ...base, requiredScopes: 'a2a.invoke' as unknown as readonly string[] },
        pattern: /requiredScopes.*array/i,
      },
      {
        config: { ...base, requiredScopes: [123] as unknown as readonly string[] },
        pattern: /requiredScopes.*string/i,
      },
      {
        config: { ...base, requiredScopes: ['a2a.invoke', 'a2a.invoke'] },
        pattern: /requiredScopes.*duplicates/i,
      },
    ];
    const fetchImpl = vi.fn<typeof fetch>();

    for (const entry of cases) {
      expect(() => createOAuth2JwtA2AAuthentication(entry.config, fetchImpl))
        .toThrow(entry.pattern);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('snapshots validated required scopes at public factory construction', () => {
    const requiredScopes = ['a2a.invoke'];
    const authentication = createOAuth2JwtA2AAuthentication({
      type: 'oauth2-jwt',
      scheme: 'oauth',
      issuer: 'https://identity.example.com',
      audience: 'https://agent.example.com',
      jwksUrl: 'https://identity.example.com/jwks',
      tokenUrl: 'https://identity.example.com/token',
      requiredScopes,
    });

    requiredScopes.push('late.scope');
    expect(authentication.securityRequirements).toEqual([
      { schemes: { oauth: { list: ['a2a.invoke'] } } },
    ]);
  });

  it('rejects unsafe OAuth URLs when the public resource-server factory is called directly', () => {
    const base = {
      type: 'oauth2-jwt',
      scheme: 'oauth',
      issuer: 'https://identity.example.com',
      audience: 'https://agent.example.com',
      jwksUrl: 'https://identity.example.com/jwks',
      tokenUrl: 'https://identity.example.com/token',
      metadataUrl: 'https://identity.example.com/.well-known/oauth-authorization-server',
      requiredScopes: [],
    } as const;

    for (const issuer of [
      'http://identity.example.com',
      'file:///identity',
      'https://@identity.example.com',
      'https://identity.example.com?',
      'https://identity.example.com#',
    ]) {
      expect(() => createOAuth2JwtA2AAuthentication({ ...base, issuer })).toThrow(/issuer/i);
    }
    for (const jwksUrl of [
      'http://identity.example.com/jwks',
      'file:///jwks',
      'https://@identity.example.com/jwks',
      'https://identity.example.com/jwks#',
    ]) {
      expect(() => createOAuth2JwtA2AAuthentication({ ...base, jwksUrl })).toThrow(/JWKS/i);
    }
    for (const tokenUrl of [
      'http://identity.example.com/token',
      'file:///token',
      'https://@identity.example.com/token',
      'https://identity.example.com/token#',
    ]) {
      expect(() => createOAuth2JwtA2AAuthentication({ ...base, tokenUrl })).toThrow(/token/i);
    }
    for (const metadataUrl of [
      'http://identity.example.com/metadata',
      'file:///metadata',
      'https://@identity.example.com/metadata',
      'https://identity.example.com/metadata#',
    ]) {
      expect(() => createOAuth2JwtA2AAuthentication({ ...base, metadataUrl })).toThrow(/metadata/i);
    }
  });

  it('accepts OAuth endpoint queries in the public resource-server factory', () => {
    const authentication = createOAuth2JwtA2AAuthentication({
      type: 'oauth2-jwt',
      scheme: 'oauth',
      issuer: 'https://identity.example.com',
      audience: 'https://agent.example.com',
      jwksUrl: 'https://identity.example.com/jwks?tenant=one',
      tokenUrl: 'https://identity.example.com/token?tenant=one',
      metadataUrl: 'https://identity.example.com/metadata?tenant=one',
      requiredScopes: [],
    });

    expect(authentication.securitySchemes.oauth).toMatchObject({
      oauth2SecurityScheme: {
        flows: { clientCredentials: { tokenUrl: 'https://identity.example.com/token?tenant=one' } },
        oauth2MetadataUrl: 'https://identity.example.com/metadata?tenant=one',
      },
    });
  });
});
