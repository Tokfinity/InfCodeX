import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { A2AError } from './errors.js';
import type { A2ANetworkPolicy } from './types.js';

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  const [a, b] = octets;
  if (octets.length !== 4 || a === undefined || b === undefined) return true;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224;
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb')
    || normalized.startsWith('ff');
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? isPrivateIpv4(address) : family === 6 ? isPrivateIpv6(address) : true;
}

export async function assertSafeA2AUrl(url: URL, policy: A2ANetworkPolicy): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new A2AError(-32602, 'A2A URL must use HTTP or HTTPS.');
  }
  if (!policy.allowedOrigins.includes(url.origin)) {
    throw new A2AError(-32602, `A2A origin is not allowed: ${url.origin}`);
  }
  if (url.username || url.password) throw new A2AError(-32602, 'A2A URL must not include credentials.');
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new A2AError(-32602, 'A2A hostname did not resolve.');
  if (url.protocol === 'http:' && !addresses.every((entry) => isPrivateAddress(entry.address))) {
    throw new A2AError(-32602, 'Public A2A targets must use HTTPS.');
  }
  if (!policy.allowPrivateAddresses && addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new A2AError(-32602, 'A2A private network targets are not allowed.');
  }
}

async function boundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) throw new A2AError(-32603, 'A2A response is too large.');
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new A2AError(-32603, 'A2A response is too large.');
    }
    chunks.push(next.value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export interface SafeFetchResult {
  readonly response: Response;
  readonly body: Uint8Array;
  readonly url: URL;
}

export async function safeA2AFetch(
  input: URL,
  init: RequestInit,
  policy: A2ANetworkPolicy,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<SafeFetchResult> {
  let current = input;
  let authorization = new Headers(init.headers).get('authorization');
  for (let redirect = 0; redirect <= policy.maxRedirects; redirect += 1) {
    await assertSafeA2AUrl(current, policy);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('A2A request timed out.')), policy.requestTimeoutMs);
    const headers = new Headers(init.headers);
    if (authorization === null) headers.delete('authorization');
    else headers.set('authorization', authorization);
    try {
      const response = await fetchImpl(current, {
        ...init,
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.status < 300 || response.status >= 400) {
        return { response, body: await boundedBody(response, policy.maxResponseBytes), url: current };
      }
      const location = response.headers.get('location');
      if (!location || redirect === policy.maxRedirects) {
        throw new A2AError(-32603, 'A2A redirect limit exceeded.');
      }
      const next = new URL(location, current);
      if (next.origin !== current.origin) authorization = null;
      current = next;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new A2AError(-32603, 'A2A redirect limit exceeded.');
}

export function decodeUtf8(body: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(body);
}
