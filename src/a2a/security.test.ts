import { describe, expect, it } from 'vitest';

import {
  parseA2ASecurity,
  selectA2ASecurityRequirement,
} from './security.js';

describe('A2A security declarations', () => {
  it('parses protobuf JSON wrappers for HTTP Bearer and OAuth2 client credentials', () => {
    const security = parseA2ASecurity(
      {
        bearer: {
          httpAuthSecurityScheme: { scheme: 'Bearer', bearerFormat: 'JWT' },
        },
        serviceOauth: {
          oauth2SecurityScheme: {
            flows: {
              clientCredentials: {
                tokenUrl: 'https://identity.example.com/oauth/token',
                scopes: {
                  'a2a.invoke': 'Invoke the agent',
                  'a2a.read': 'Read task state',
                },
              },
            },
          },
        },
      },
      [
        { schemes: { bearer: { list: [] } } },
        { schemes: { serviceOauth: { list: ['a2a.invoke'] } } },
      ],
    );

    expect(security.schemes.bearer).toEqual({
      name: 'bearer',
      kind: 'http-bearer',
      bearerFormat: 'JWT',
    });
    expect(security.schemes.serviceOauth).toEqual({
      name: 'serviceOauth',
      kind: 'oauth2-client-credentials',
      tokenUrl: 'https://identity.example.com/oauth/token',
      scopes: ['a2a.invoke', 'a2a.read'],
    });
  });

  it('uses OR between requirements and requires every scheme in an AND requirement', () => {
    const security = parseA2ASecurity(
      {
        bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } },
        serviceOauth: {
          oauth2SecurityScheme: {
            flows: {
              clientCredentials: {
                tokenUrl: 'https://identity.example.com/oauth/token',
                scopes: { 'a2a.invoke': 'Invoke the agent' },
              },
            },
          },
        },
      },
      [
        {
          schemes: {
            bearer: { list: [] },
            serviceOauth: { list: ['a2a.invoke'] },
          },
        },
        { schemes: { serviceOauth: { list: ['a2a.invoke'] } } },
      ],
    );

    const selected = selectA2ASecurityRequirement(security, [
      { schemeName: 'serviceOauth', kind: 'oauth2-client-credentials', scopes: ['a2a.invoke'] },
    ]);

    expect(selected).toEqual({
      schemes: [{
        scheme: security.schemes.serviceOauth,
        scopes: ['a2a.invoke'],
      }],
    });
  });

  it('does not partially downgrade an unsupported AND requirement', () => {
    const security = parseA2ASecurity(
      {
        bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } },
        apiKey: {
          apiKeySecurityScheme: { location: 'header', name: 'X-API-Key' },
        },
      },
      [{
        schemes: {
          bearer: { list: [] },
          apiKey: { list: [] },
        },
      }],
    );

    expect(selectA2ASecurityRequirement(security, [
      { schemeName: 'bearer', kind: 'http-bearer' },
    ])).toBeNull();
  });

  it('selects an empty requirement as an anonymous alternative', () => {
    const security = parseA2ASecurity(
      { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
      [
        { schemes: { bearer: { list: [] } } },
        { schemes: {} },
      ],
    );

    expect(selectA2ASecurityRequirement(security, [])).toEqual({ schemes: [] });
  });

  it('treats omitted or empty requirements as anonymous', () => {
    const omitted = parseA2ASecurity(undefined, undefined);
    const empty = parseA2ASecurity({}, []);

    expect(selectA2ASecurityRequirement(omitted, [])).toEqual({ schemes: [] });
    expect(selectA2ASecurityRequirement(empty, [])).toEqual({ schemes: [] });
  });

  it('rejects a requirement that references an unknown scheme', () => {
    expect(() => parseA2ASecurity(
      {},
      [{ schemes: { missing: { list: [] } } }],
    )).toThrow('securityRequirements[0] references unknown security scheme "missing"');
  });

  it('does not resolve unknown scheme names through Object.prototype', () => {
    for (const name of ['constructor', '__proto__']) {
      expect(() => parseA2ASecurity(
        {},
        [{ schemes: { [name]: { list: [] } } }],
      )).toThrow(`references unknown security scheme "${name}"`);
    }
  });

  it('rejects undeclared OAuth scopes', () => {
    expect(() => parseA2ASecurity(
      {
        oauth: {
          oauth2SecurityScheme: {
            flows: {
              clientCredentials: {
                tokenUrl: 'https://identity.example.com/oauth/token',
                scopes: { 'a2a.invoke': 'Invoke the agent' },
              },
            },
          },
        },
      },
      [{ schemes: { oauth: { list: ['a2a.admin'] } } }],
    )).toThrow('scope "a2a.admin" is not declared by security scheme "oauth"');
  });

  it('requires an explicit Client Credentials scopes object while allowing it to be empty', () => {
    const withoutScopes = {
      oauth: {
        oauth2SecurityScheme: {
          flows: {
            clientCredentials: { tokenUrl: 'https://identity.example.com/oauth/token' },
          },
        },
      },
    };
    expect(() => parseA2ASecurity(withoutScopes, [])).toThrow(/scopes.*object/i);

    expect(parseA2ASecurity({
      oauth: {
        oauth2SecurityScheme: {
          flows: {
            clientCredentials: {
              tokenUrl: 'https://identity.example.com/oauth/token',
              scopes: {},
            },
          },
        },
      },
    }, []).schemes.oauth).toMatchObject({ scopes: [] });
  });

  it('does not select OAuth when the client is missing a required scope', () => {
    const security = parseA2ASecurity({
      oauth: {
        oauth2SecurityScheme: {
          flows: {
            clientCredentials: {
              tokenUrl: 'https://identity.example.com/oauth/token',
              scopes: { 'a2a.invoke': 'Invoke the agent' },
            },
          },
        },
      },
    }, [{ schemes: { oauth: { list: ['a2a.invoke'] } } }]);

    expect(selectA2ASecurityRequirement(security, [{
      schemeName: 'oauth', kind: 'oauth2-client-credentials', scopes: [],
    }])).toBeNull();
  });

  it('rejects OAuth scopes on non-OAuth schemes', () => {
    expect(() => parseA2ASecurity(
      { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
      [{ schemes: { bearer: { list: ['a2a.invoke'] } } }],
    )).toThrow('security scheme "bearer" does not accept OAuth scopes');
  });

  it('rejects OAuth scope names and requirements outside the RFC 6749 scope-token grammar', () => {
    expect(() => parseA2ASecurity({
      oauth: {
        oauth2SecurityScheme: {
          flows: {
            clientCredentials: {
              tokenUrl: 'https://identity.example.com/token',
              scopes: { 'bad scope': 'Invalid scope' },
            },
          },
        },
      },
    }, [])).toThrow(/scope-token/i);

    expect(() => parseA2ASecurity({
      oauth: {
        oauth2SecurityScheme: {
          flows: {
            clientCredentials: {
              tokenUrl: 'https://identity.example.com/token',
              scopes: { 'a2a.invoke': 'Invoke' },
            },
          },
        },
      },
    }, [{ schemes: { oauth: { list: ['a2a.invoke\r\nX-Injected: true'] } } }]))
      .toThrow(/scope-token/i);
  });

  it('rejects malformed protobuf oneof and StringList wrappers', () => {
    expect(() => parseA2ASecurity(
      {
        invalid: {
          httpAuthSecurityScheme: { scheme: 'Bearer' },
          mtlsSecurityScheme: {},
        },
      },
      [],
    )).toThrow('securitySchemes.invalid must contain exactly one security scheme');

    expect(() => parseA2ASecurity(
      { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
      [{ schemes: { bearer: [] } }],
    )).toThrow('securityRequirements[0].schemes.bearer must be a StringList object');
  });

  it('recognizes non-Bearer and non-client-credentials schemes as unsupported', () => {
    const security = parseA2ASecurity(
      {
        basic: { httpAuthSecurityScheme: { scheme: 'Basic' } },
        authorizationCode: {
          oauth2SecurityScheme: {
            flows: {
              authorizationCode: {
                authorizationUrl: 'https://identity.example.com/oauth/authorize',
                tokenUrl: 'https://identity.example.com/oauth/token',
                scopes: { openid: 'Sign in' },
              },
            },
          },
        },
      },
      [{ schemes: { basic: { list: [] } } }],
    );

    expect(security.schemes.basic).toMatchObject({ kind: 'unsupported', protocol: 'http:basic' });
    expect(security.schemes.authorizationCode).toMatchObject({
      kind: 'unsupported',
      protocol: 'oauth2:authorizationCode',
    });
    expect(selectA2ASecurityRequirement(security, [])).toBeNull();
  });
});
