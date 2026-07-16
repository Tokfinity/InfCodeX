import { describe, expect, it, vi } from 'vitest';

import {
  createOAuth2ClientCredentialsTokenManager,
  type OAuth2ClientCredentialsTokenManagerOptions,
} from './client-auth.js';

const TOKEN_URL = 'http://localhost/oauth/token';

function options(
  fetchImpl: typeof fetch,
  overrides: Partial<OAuth2ClientCredentialsTokenManagerOptions> = {},
): OAuth2ClientCredentialsTokenManagerOptions {
  return {
    issuer: 'http://localhost',
    tokenUrl: TOKEN_URL,
    clientId: 'client-id',
    scopes: ['a2a.invoke', 'a2a.read'],
    resource: 'https://agent.example/a2a',
    clientAuthenticationMethod: 'basic',
    networkPolicy: {
      allowedOrigins: ['http://localhost'],
      allowPrivateAddresses: true,
      requestTimeoutMs: 1_000,
      maxResponseBytes: 8_192,
      maxRedirects: 5,
    },
    fetch: fetchImpl,
    ...overrides,
  };
}

function tokenResponse(accessToken: string, expiresIn = 120): Response {
  return Response.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
  });
}

async function requestBody(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<URLSearchParams> {
  return new URLSearchParams(await new Request(input, init).text());
}

describe('OAuth2 client credentials token manager', () => {
  it('uses client_secret_basic and sends the standard grant parameters', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const headers = new Headers(init?.headers);
      expect(String(input)).toBe(TOKEN_URL);
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('manual');
      expect(headers.get('authorization')).toBe(
        `Basic ${Buffer.from('client%2Did:top%2Dsecret').toString('base64')}`,
      );
      const body = await requestBody(input, init);
      expect(Object.fromEntries(body)).toEqual({
        grant_type: 'client_credentials',
        resource: 'https://agent.example/a2a',
        scope: 'a2a.invoke a2a.read',
      });
      return tokenResponse('access-one');
    });
    const manager = createOAuth2ClientCredentialsTokenManager(options(fetchImpl));

    await expect(manager.getAuthorization('top-secret')).resolves.toBe('Bearer access-one');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('supports client_secret_post without adding a Basic authorization header', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      const body = await requestBody(input, init);
      expect(body.get('client_id')).toBe('client-id');
      expect(body.get('client_secret')).toBe('rotated-secret');
      return tokenResponse('access-post');
    });
    const manager = createOAuth2ClientCredentialsTokenManager(options(fetchImpl, {
      clientAuthenticationMethod: 'post',
    }));

    await expect(manager.getAuthorization('rotated-secret')).resolves.toBe('Bearer access-post');
  });

  it('caches a usable token in memory and coalesces concurrent refreshes', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(() => response);
    const manager = createOAuth2ClientCredentialsTokenManager(options(fetchImpl));

    const first = manager.getAuthorization('secret');
    const second = manager.getAuthorization('secret');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    resolveResponse?.(tokenResponse('shared-token'));

    await expect(Promise.all([first, second])).resolves.toEqual([
      'Bearer shared-token',
      'Bearer shared-token',
    ]);
    await expect(manager.getAuthorization('secret')).resolves.toBe('Bearer shared-token');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refreshes at the bounded early-expiry threshold', async () => {
    let now = 0;
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse('first-token', 120))
      .mockResolvedValueOnce(tokenResponse('second-token', 120));
    const manager = createOAuth2ClientCredentialsTokenManager(options(fetchImpl, {
      now: () => now,
    }));

    await expect(manager.getAuthorization('secret')).resolves.toBe('Bearer first-token');
    now = 107_999;
    await expect(manager.getAuthorization('secret')).resolves.toBe('Bearer first-token');
    now = 108_000;
    await expect(manager.getAuthorization('new-secret')).resolves.toBe('Bearer second-token');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('invalidates both cached and in-flight generations', async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValueOnce(tokenResponse('fresh-token'));
    const manager = createOAuth2ClientCredentialsTokenManager(options(fetchImpl));

    const stale = manager.getAuthorization('old-secret');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    manager.invalidate();
    const fresh = manager.getAuthorization('new-secret');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    resolveFirst?.(tokenResponse('stale-token'));

    await expect(stale).resolves.toBe('Bearer stale-token');
    await expect(fresh).resolves.toBe('Bearer fresh-token');
    await expect(manager.getAuthorization('new-secret')).resolves.toBe('Bearer fresh-token');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not discard a newer refresh for a late rejection of an older authorization', async () => {
    let resolveFresh: ((response: Response) => void) | undefined;
    const freshResponse = new Promise<Response>((resolve) => {
      resolveFresh = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse('old-token'))
      .mockImplementationOnce(() => freshResponse);
    const manager = createOAuth2ClientCredentialsTokenManager(options(fetchImpl));

    const oldAuthorization = await manager.getAuthorization('secret');
    manager.invalidate(oldAuthorization);
    const refreshing = manager.getAuthorization('secret');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    manager.invalidate(oldAuthorization);
    const sharedRefresh = manager.getAuthorization('secret');
    resolveFresh?.(tokenResponse('fresh-token'));

    await expect(Promise.all([refreshing, sharedRefresh])).resolves.toEqual([
      'Bearer fresh-token',
      'Bearer fresh-token',
    ]);
    await expect(manager.getAuthorization('secret')).resolves.toBe('Bearer fresh-token');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['', 'empty'],
    ['two scopes', 'whitespace'],
    ['quoted"scope', 'quote'],
    ['path\\scope', 'backslash'],
    ['line\nscope', 'control character'],
  ])('rejects an invalid RFC 6749 scope-token at creation (%s)', (scope) => {
    const fetchImpl = vi.fn<typeof fetch>();

    expect(() => createOAuth2ClientCredentialsTokenManager(options(fetchImpl, {
      scopes: [scope],
    }))).toThrow(/scope/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['', '   '])('rejects an empty OAuth clientId at manager creation', (clientId) => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(() => createOAuth2ClientCredentialsTokenManager(options(fetchImpl, { clientId })))
      .toThrow(/clientId.*non-empty/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects invalid authentication methods and scope arrays at manager creation', () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(() => createOAuth2ClientCredentialsTokenManager(options(fetchImpl, {
      clientAuthenticationMethod: 'client-secret-jwt' as OAuth2ClientCredentialsTokenManagerOptions['clientAuthenticationMethod'],
    }))).toThrow(/clientAuthenticationMethod/i);
    for (const scopes of [
      'a2a.invoke' as unknown as readonly string[],
      [123] as unknown as readonly string[],
      ['a2a.invoke', 'a2a.invoke'],
    ]) {
      expect(() => createOAuth2ClientCredentialsTokenManager(options(fetchImpl, { scopes })))
        .toThrow(/scopes|scope/i);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('snapshots the validated method and scopes at manager construction', async () => {
    const scopes = ['a2a.invoke'];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(new Headers(init?.headers).has('authorization')).toBe(true);
      expect((await requestBody(input, init)).get('scope')).toBe('a2a.invoke');
      return tokenResponse('snapshot-token');
    });
    const managerOptions = options(fetchImpl, { scopes });
    const manager = createOAuth2ClientCredentialsTokenManager(managerOptions);

    scopes.push('late.scope');
    Object.assign(managerOptions, { clientAuthenticationMethod: 'post' });

    await expect(manager.getAuthorization('secret')).resolves.toBe('Bearer snapshot-token');
  });

  it.each([
    'http://identity.example.com',
    'file:///identity',
    'https://user:secret@identity.example.com',
    'https://@identity.example.com',
    'https://identity.example.com?',
    'https://identity.example.com#',
  ])('rejects an unsafe OAuth issuer at manager creation: %s', (issuer) => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(() => createOAuth2ClientCredentialsTokenManager(options(fetchImpl, { issuer })))
      .toThrow(/issuer/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    'http://identity.example.com/token',
    'file:///token',
    'https://user:secret@identity.example.com/token',
    'https://@identity.example.com/token',
    'https://identity.example.com/token#',
  ])('rejects an unsafe OAuth token endpoint at manager creation: %s', (tokenUrl) => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(() => createOAuth2ClientCredentialsTokenManager(options(fetchImpl, { tokenUrl })))
      .toThrow(/token endpoint/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    '/relative-resource',
    'urn:example:a2a#',
  ])('rejects an unsafe OAuth resource at manager creation: %s', (resource) => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(() => createOAuth2ClientCredentialsTokenManager(options(fetchImpl, { resource })))
      .toThrow(/resource/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accepts endpoint queries and sends an exact absolute URI resource indicator', async () => {
    const tokenUrl = `${TOKEN_URL}?tenant=one`;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(tokenUrl);
      expect((await requestBody(input, init)).get('resource')).toBe('urn:example:a2a:agent');
      return tokenResponse('query-token');
    });
    const manager = createOAuth2ClientCredentialsTokenManager(options(fetchImpl, {
      tokenUrl,
      resource: 'urn:example:a2a:agent',
    }));

    await expect(manager.getAuthorization('secret')).resolves.toBe('Bearer query-token');
  });

  it('rejects token endpoint redirects even when the A2A policy allows them', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 302,
      headers: { location: '/oauth/redirected-token' },
    }));
    const manager = createOAuth2ClientCredentialsTokenManager(options(fetchImpl));

    await expect(manager.getAuthorization('secret')).rejects.toThrow(
      'OAuth 2.0 client credentials token request failed.',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not expose credentials or returned tokens in errors', async () => {
    const secret = 'never-print-this-secret';
    const returnedToken = 'never-print-this-token';
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error(`transport echoed ${secret}`))
      .mockResolvedValueOnce(Response.json({
        access_token: returnedToken,
        token_type: 'DPoP',
        expires_in: 120,
      }));
    const manager = createOAuth2ClientCredentialsTokenManager(options(fetchImpl));

    const transportError = await manager.getAuthorization(secret).catch((error: unknown) => error);
    expect(transportError).toBeInstanceOf(Error);
    expect(String(transportError)).not.toContain(secret);

    const responseError = await manager.getAuthorization(secret).catch((error: unknown) => error);
    expect(responseError).toBeInstanceOf(Error);
    expect(String(responseError)).not.toContain(returnedToken);
    expect(String(responseError)).toContain('Bearer');
  });
});
