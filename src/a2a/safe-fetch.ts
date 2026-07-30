import { lookup } from 'node:dns/promises';
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

import { A2AError } from './errors.js';
import type { A2ANetworkPolicy } from './types.js';

const LOOPBACK_ADDRESSES = new BlockList();
LOOPBACK_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK_ADDRESSES.addAddress('::1', 'ipv6');

function isLoopbackAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? LOOPBACK_ADDRESSES.check(address, 'ipv4')
    : family === 6 && LOOPBACK_ADDRESSES.check(address, 'ipv6');
}

function isExactLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1';
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  const [a, b, c, d] = octets;
  if (octets.length !== 4 || a === undefined || b === undefined || c === undefined || d === undefined) return true;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 0 && d !== 9 && d !== 10)
    || (a === 192 && b === 0 && c === 2)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function isPrivateIpv6(address: string): boolean {
  if (isLoopbackAddress(address)) return true;
  const normalized = address.toLowerCase();
  const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
  if (mappedDotted) return isPrivateIpv4(mappedDotted);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (mappedHex?.[1] && mappedHex[2]) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
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

interface ValidatedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

async function validateA2AUrl(url: URL, policy: A2ANetworkPolicy): Promise<ValidatedAddress> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new A2AError(-32602, 'A2A URL must use HTTP or HTTPS.');
  }
  if (!policy.allowedOrigins.includes(url.origin)) {
    throw new A2AError(-32602, `A2A origin is not allowed: ${url.origin}`);
  }
  if (url.username || url.password) throw new A2AError(-32602, 'A2A URL must not include credentials.');
  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new A2AError(-32602, 'A2A hostname did not resolve.');
  if (hostname.toLowerCase() === 'localhost'
    && !addresses.every((entry) => isLoopbackAddress(entry.address))) {
    throw new A2AError(-32602, 'A2A localhost target must resolve only to loopback addresses.');
  }
  const exactLoopbackHttp = isExactLoopbackHostname(hostname)
    && addresses.every((entry) => isLoopbackAddress(entry.address));
  if (url.protocol === 'http:' && !exactLoopbackHttp && policy.allowInsecureHttp !== true) {
    throw new A2AError(-32602, 'Non-loopback A2A targets must use HTTPS unless plaintext HTTP is explicitly allowed.');
  }
  if (!policy.allowPrivateAddresses && addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new A2AError(-32602, 'A2A private network targets are not allowed.');
  }
  const selected = addresses[0];
  if (selected === undefined || (selected.family !== 4 && selected.family !== 6)) {
    throw new A2AError(-32602, 'A2A hostname returned an unsupported address.');
  }
  return { address: selected.address, family: selected.family };
}

export async function assertSafeA2AUrl(url: URL, policy: A2ANetworkPolicy): Promise<void> {
  await validateA2AUrl(url, policy);
}

function encodeRequestBody(body: RequestInit['body']): string | Uint8Array | undefined {
  if (body === undefined || body === null || typeof body === 'string') return body ?? undefined;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new A2AError(-32602, 'A2A request body type is not supported by the safe transport.');
}

function pinnedLookup(address: ValidatedAddress): LookupFunction {
  return ((_hostname, options, callback) => {
    if (typeof options === 'object' && options.all) {
      callback(null, [address]);
      return;
    }
    callback(null, address.address, address.family);
  }) as LookupFunction;
}

function requestValidatedAddress(
  url: URL,
  init: RequestInit,
  address: ValidatedAddress,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const requestHeaders = new Headers(init.headers);
    requestHeaders.set('accept-encoding', 'identity');
    const request = (url.protocol === 'https:' ? requestHttps : requestHttp)(url, {
      method: init.method,
      headers: Object.fromEntries(requestHeaders),
      lookup: pinnedLookup(address),
      signal: init.signal ?? undefined,
    }, (incoming) => {
      const headers = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        const name = incoming.rawHeaders[index];
        const value = incoming.rawHeaders[index + 1];
        if (name !== undefined && value !== undefined) headers.append(name, value);
      }
      const status = incoming.statusCode ?? 500;
      const hasBody = init.method !== 'HEAD' && status !== 204 && status !== 205 && status !== 304;
      const body = hasBody
        ? Readable.toWeb(incoming) as ReadableStream<Uint8Array>
        : null;
      resolve(new Response(body, {
        status,
        statusText: incoming.statusMessage,
        headers,
      }));
    });
    request.once('error', reject);
    request.end(encodeRequestBody(init.body));
  });
}

export async function openSafeA2AResponse(
  url: URL,
  init: RequestInit,
  policy: A2ANetworkPolicy,
  fetchImpl?: typeof fetch,
): Promise<Response> {
  const address = await validateA2AUrl(url, policy);
  if (fetchImpl !== undefined) {
    return fetchImpl(url, init);
  }
  return requestValidatedAddress(url, init, address);
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

function combineAbortSignals(
  caller: AbortSignal | null | undefined,
  deadline: AbortSignal,
): { readonly signal: AbortSignal; readonly cleanup: () => void } {
  if (!caller) return { signal: deadline, cleanup: () => undefined };
  const combined = new AbortController();
  const abortFromCaller = (): void => combined.abort(caller.reason);
  const abortFromDeadline = (): void => combined.abort(deadline.reason);
  if (caller.aborted) abortFromCaller();
  else caller.addEventListener('abort', abortFromCaller, { once: true });
  if (deadline.aborted) abortFromDeadline();
  else deadline.addEventListener('abort', abortFromDeadline, { once: true });
  return {
    signal: combined.signal,
    cleanup: () => {
      caller.removeEventListener('abort', abortFromCaller);
      deadline.removeEventListener('abort', abortFromDeadline);
    },
  };
}

export async function safeA2AFetch(
  input: URL,
  init: RequestInit,
  policy: A2ANetworkPolicy,
  fetchImpl?: typeof fetch,
): Promise<SafeFetchResult> {
  let current = input;
  let authorization = new Headers(init.headers).get('authorization');
  for (let redirect = 0; redirect <= policy.maxRedirects; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('A2A request timed out.')), policy.requestTimeoutMs);
    const combinedSignal = combineAbortSignals(init.signal, controller.signal);
    const headers = new Headers(init.headers);
    if (authorization === null) headers.delete('authorization');
    else headers.set('authorization', authorization);
    try {
      const response = await openSafeA2AResponse(current, {
        ...init,
        headers,
        redirect: 'manual',
        signal: combinedSignal.signal,
      }, policy, fetchImpl);
      if (response.status < 300 || response.status >= 400) {
        return { response, body: await boundedBody(response, policy.maxResponseBytes), url: current };
      }
      const location = response.headers.get('location');
      if (!location || redirect === policy.maxRedirects) {
        throw new A2AError(-32603, 'A2A redirect limit exceeded.');
      }
      const next = new URL(location, current);
      await response.body?.cancel();
      if (next.origin !== current.origin) authorization = null;
      current = next;
    } finally {
      clearTimeout(timer);
      combinedSignal.cleanup();
    }
  }
  throw new A2AError(-32603, 'A2A redirect limit exceeded.');
}

export function decodeUtf8(body: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(body);
}
