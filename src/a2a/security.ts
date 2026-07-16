type SupportedSecurityKind = 'http-bearer' | 'oauth2-client-credentials';

export interface A2AHttpBearerSecurityScheme {
  readonly name: string;
  readonly kind: 'http-bearer';
  readonly bearerFormat?: string;
}

export interface A2AOAuth2ClientCredentialsSecurityScheme {
  readonly name: string;
  readonly kind: 'oauth2-client-credentials';
  readonly tokenUrl: string;
  readonly scopes: readonly string[];
}

export interface A2AUnsupportedSecurityScheme {
  readonly name: string;
  readonly kind: 'unsupported';
  readonly protocol: string;
  readonly oauthScopes?: readonly string[];
  readonly acceptsOAuthScopes?: boolean;
}

export type A2ASecurityScheme =
  | A2AHttpBearerSecurityScheme
  | A2AOAuth2ClientCredentialsSecurityScheme
  | A2AUnsupportedSecurityScheme;

export interface A2ARequiredSecurityScheme {
  readonly scheme: A2ASecurityScheme;
  readonly scopes: readonly string[];
}

export interface A2ASecurityRequirement {
  readonly schemes: readonly A2ARequiredSecurityScheme[];
}

export interface A2ASecurityDeclaration {
  readonly schemes: Readonly<Record<string, A2ASecurityScheme>>;
  readonly requirements: readonly A2ASecurityRequirement[];
}

export interface A2AClientSecurityCapability {
  readonly schemeName: string;
  readonly kind: SupportedSecurityKind;
  readonly scopes?: readonly string[];
}

const SCHEME_FIELDS = [
  'apiKeySecurityScheme',
  'httpAuthSecurityScheme',
  'oauth2SecurityScheme',
  'openIdConnectSecurityScheme',
  'mtlsSecurityScheme',
] as const;

const OAUTH_FLOW_FIELDS = [
  'authorizationCode',
  'clientCredentials',
  'implicit',
  'password',
  'deviceCode',
] as const;

const OAUTH_SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/u;

export function assertOAuthScopeToken(value: string, label: string): void {
  if (!OAUTH_SCOPE_TOKEN.test(value)) {
    throw new Error(`${label} must be an RFC 6749 scope-token.`);
  }
}

export function parseOAuthScopeValue(value: string, label: string): readonly string[] {
  const scopes = value.split(' ');
  for (const scope of scopes) assertOAuthScopeToken(scope, label);
  return [...new Set(scopes)];
}

export function parseOAuthScopeList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings.`);
  const scopes = value.map((scope, index) => {
    if (typeof scope !== 'string') throw new Error(`${label}[${index}] must be a string.`);
    assertOAuthScopeToken(scope, `${label}[${index}]`);
    return scope;
  });
  if (new Set(scopes).size !== scopes.length) throw new Error(`${label} must not contain duplicates.`);
  return scopes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requireNonEmptyString(value, label);
}

function trimmedUri(value: unknown, label: string): string {
  return requireNonEmptyString(value, label).trim();
}

function hasAuthorityUserinfo(value: string): boolean {
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/u.exec(value)?.[1];
  return authority?.includes('@') === true;
}

export function isExactOAuthLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function secureOAuthHttpUrl(value: unknown, label: string): { readonly raw: string; readonly url: URL } {
  const raw = trimmedUri(value, label);
  const authority = /^https?:\/\/([^/?#]*)/iu.exec(raw)?.[1];
  if (!authority) {
    throw new Error(`${label} must be an absolute HTTP(S) URL.`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL.`);
  }
  if (hasAuthorityUserinfo(raw) || url.username || url.password || raw.includes('#')) {
    throw new Error(`${label} must not contain userinfo or a fragment.`);
  }
  if (url.protocol === 'http:' && !isExactOAuthLoopbackHostname(url.hostname)) {
    throw new Error(`${label} must use HTTPS or exact loopback HTTP.`);
  }
  return { raw, url };
}

export function parseOAuthIssuerIdentifier(value: unknown, label: string): string {
  const parsed = secureOAuthHttpUrl(value, label);
  if (parsed.raw.includes('?')) {
    throw new Error(`${label} must not contain a query or fragment.`);
  }
  return parsed.raw;
}

export function parseOAuthEndpointUrl(value: unknown, label: string): URL {
  return secureOAuthHttpUrl(value, label).url;
}

export function parseOAuthResourceIdentifier(value: unknown, label: string): string {
  const raw = trimmedUri(value, label);
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(raw)) {
    throw new Error(`${label} must be an absolute URI.`);
  }
  try {
    new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute URI.`);
  }
  if (raw.includes('#')) throw new Error(`${label} must not contain a fragment.`);
  return raw;
}

function absoluteHttpUrl(value: unknown, label: string): string {
  return parseOAuthEndpointUrl(value, label).href;
}

function parseScopes(value: unknown, label: string): readonly string[] {
  if (!isRecord(value)) throw new Error(`${label} must be a scope-description object.`);
  return Object.entries(value).map(([scope, description]) => {
    if (scope.trim().length === 0 || typeof description !== 'string') {
      throw new Error(`${label} must map non-empty scope names to descriptions.`);
    }
    assertOAuthScopeToken(scope, `${label}.${scope}`);
    return scope;
  });
}

function parseHttpScheme(name: string, value: unknown): A2ASecurityScheme {
  if (!isRecord(value)) {
    throw new Error(`securitySchemes.${name}.httpAuthSecurityScheme must be an object.`);
  }
  const scheme = requireNonEmptyString(value.scheme, `securitySchemes.${name}.httpAuthSecurityScheme.scheme`);
  const bearerFormat = optionalString(
    value.bearerFormat,
    `securitySchemes.${name}.httpAuthSecurityScheme.bearerFormat`,
  );
  if (scheme.toLowerCase() !== 'bearer') {
    return { name, kind: 'unsupported', protocol: `http:${scheme.toLowerCase()}` };
  }
  return { name, kind: 'http-bearer', ...(bearerFormat ? { bearerFormat } : {}) };
}

function parseOAuthFlow(name: string, value: Record<string, unknown>): A2ASecurityScheme {
  const flows = value.flows;
  if (!isRecord(flows)) throw new Error(`securitySchemes.${name}.oauth2SecurityScheme.flows must be an object.`);
  const present = OAUTH_FLOW_FIELDS.filter((field) => flows[field] !== undefined);
  if (present.length !== 1) {
    throw new Error(`securitySchemes.${name}.oauth2SecurityScheme.flows must contain exactly one OAuth flow.`);
  }
  const flowName = present[0]!;
  const flow = flows[flowName];
  if (!isRecord(flow)) {
    throw new Error(`securitySchemes.${name}.oauth2SecurityScheme.flows.${flowName} must be an object.`);
  }
  const scopes = parseScopes(
    flow.scopes,
    `securitySchemes.${name}.oauth2SecurityScheme.flows.${flowName}.scopes`,
  );
  if (flowName === 'clientCredentials') {
    const tokenUrl = absoluteHttpUrl(
      flow.tokenUrl,
      `securitySchemes.${name}.oauth2SecurityScheme.flows.clientCredentials.tokenUrl`,
    );
    return { name, kind: 'oauth2-client-credentials', tokenUrl, scopes };
  }
  return { name, kind: 'unsupported', protocol: `oauth2:${flowName}`, oauthScopes: scopes };
}

function parseUnsupportedScheme(
  name: string,
  field: (typeof SCHEME_FIELDS)[number],
  value: unknown,
): A2AUnsupportedSecurityScheme {
  if (!isRecord(value)) throw new Error(`securitySchemes.${name}.${field} must be an object.`);
  if (field === 'apiKeySecurityScheme') {
    const location = requireNonEmptyString(value.location, `securitySchemes.${name}.${field}.location`);
    if (!['query', 'header', 'cookie'].includes(location)) {
      throw new Error(`securitySchemes.${name}.${field}.location must be query, header, or cookie.`);
    }
    requireNonEmptyString(value.name, `securitySchemes.${name}.${field}.name`);
    return { name, kind: 'unsupported', protocol: 'api-key' };
  }
  if (field === 'openIdConnectSecurityScheme') {
    absoluteHttpUrl(value.openIdConnectUrl, `securitySchemes.${name}.${field}.openIdConnectUrl`);
    return { name, kind: 'unsupported', protocol: 'openid-connect', acceptsOAuthScopes: true };
  }
  return { name, kind: 'unsupported', protocol: 'mutual-tls' };
}

function parseScheme(name: string, value: unknown): A2ASecurityScheme {
  if (!isRecord(value)) throw new Error(`securitySchemes.${name} must be an object.`);
  const present = SCHEME_FIELDS.filter((field) => value[field] !== undefined);
  if (present.length !== 1) {
    throw new Error(`securitySchemes.${name} must contain exactly one security scheme.`);
  }
  const field = present[0]!;
  if (field === 'httpAuthSecurityScheme') return parseHttpScheme(name, value[field]);
  if (field === 'oauth2SecurityScheme') {
    const oauth = value[field];
    if (!isRecord(oauth)) throw new Error(`securitySchemes.${name}.${field} must be an object.`);
    return parseOAuthFlow(name, oauth);
  }
  return parseUnsupportedScheme(name, field, value[field]);
}

function parseSchemes(value: unknown): Readonly<Record<string, A2ASecurityScheme>> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error('securitySchemes must be an object.');
  return Object.fromEntries(Object.entries(value).map(([name, scheme]) => {
    if (name.trim().length === 0) throw new Error('securitySchemes names must not be empty.');
    return [name, parseScheme(name, scheme)];
  }));
}

function parseScopeList(value: unknown, label: string): readonly string[] {
  if (!isRecord(value)) throw new Error(`${label} must be a StringList object.`);
  if (value.list === undefined) return [];
  if (!Array.isArray(value.list) || !value.list.every((scope) => (
    typeof scope === 'string' && scope.trim().length > 0
  ))) {
    throw new Error(`${label}.list must be an array of non-empty strings.`);
  }
  if (new Set(value.list).size !== value.list.length) {
    throw new Error(`${label}.list must not contain duplicate scopes.`);
  }
  for (const scope of value.list) assertOAuthScopeToken(scope, `${label}.list`);
  return value.list;
}

function validateRequiredScopes(scheme: A2ASecurityScheme, scopes: readonly string[]): void {
  if (scheme.kind === 'oauth2-client-credentials'
    || (scheme.kind === 'unsupported' && scheme.oauthScopes !== undefined)) {
    const declared = scheme.kind === 'oauth2-client-credentials'
      ? scheme.scopes
      : scheme.oauthScopes ?? [];
    for (const scope of scopes) {
      if (!declared.includes(scope)) {
        throw new Error(`scope "${scope}" is not declared by security scheme "${scheme.name}".`);
      }
    }
    return;
  }
  if (scopes.length > 0
    && !(scheme.kind === 'unsupported' && scheme.acceptsOAuthScopes)) {
    throw new Error(`security scheme "${scheme.name}" does not accept OAuth scopes.`);
  }
}

function parseRequirement(
  value: unknown,
  index: number,
  schemes: Readonly<Record<string, A2ASecurityScheme>>,
): A2ASecurityRequirement {
  if (!isRecord(value)) throw new Error(`securityRequirements[${index}] must be an object.`);
  const rawSchemes = value.schemes;
  if (rawSchemes !== undefined && !isRecord(rawSchemes)) {
    throw new Error(`securityRequirements[${index}].schemes must be an object.`);
  }
  const entries = Object.entries(rawSchemes ?? {});
  const required = entries.map(([name, scopeList]) => {
    if (!Object.hasOwn(schemes, name)) {
      throw new Error(`securityRequirements[${index}] references unknown security scheme "${name}".`);
    }
    const scheme = schemes[name]!;
    const scopes = parseScopeList(scopeList, `securityRequirements[${index}].schemes.${name}`);
    validateRequiredScopes(scheme, scopes);
    return { scheme, scopes };
  });
  return { schemes: required };
}

export function parseA2ASecurity(
  rawSchemes: unknown,
  rawRequirements: unknown,
): A2ASecurityDeclaration {
  const schemes = parseSchemes(rawSchemes);
  if (rawRequirements === undefined) return { schemes, requirements: [] };
  if (!Array.isArray(rawRequirements)) throw new Error('securityRequirements must be an array.');
  return {
    schemes,
    requirements: rawRequirements.map((requirement, index) => (
      parseRequirement(requirement, index, schemes)
    )),
  };
}

function capabilityMatches(
  capability: A2AClientSecurityCapability,
  required: A2ARequiredSecurityScheme,
): boolean {
  const { scheme, scopes } = required;
  return scheme.kind !== 'unsupported'
    && capability.schemeName === scheme.name
    && capability.kind === scheme.kind
    && scopes.every((scope) => capability.scopes?.includes(scope) === true);
}

export function selectA2ASecurityRequirement(
  security: A2ASecurityDeclaration,
  capabilities: readonly A2AClientSecurityCapability[],
): A2ASecurityRequirement | null {
  return satisfiableA2ASecurityRequirements(security, capabilities)[0] ?? null;
}

export function satisfiableA2ASecurityRequirements(
  security: A2ASecurityDeclaration,
  capabilities: readonly A2AClientSecurityCapability[],
): readonly A2ASecurityRequirement[] {
  const requirements = security.requirements.length === 0
    ? [{ schemes: [] }]
    : security.requirements;
  return requirements.filter((requirement) => requirement.schemes.every((required) => (
    capabilities.some((capability) => capabilityMatches(capability, required))
  )));
}
