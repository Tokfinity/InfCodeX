import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseBingResults, toolWebSearch } from './web-search.js';

describe('toolWebSearch', () => {
  let server: ReturnType<typeof createServer> | undefined;
  let previousEndpoint: string | undefined;

  beforeEach(() => {
    previousEndpoint = process.env.KODAX_WEB_SEARCH_ENDPOINT;
  });

  afterEach(async () => {
    if (previousEndpoint === undefined) {
      delete process.env.KODAX_WEB_SEARCH_ENDPOINT;
    } else {
      process.env.KODAX_WEB_SEARCH_ENDPOINT = previousEndpoint;
    }

    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
      server = undefined;
    }
  });

  it('parses lightweight html search results', async () => {
    server = createServer((request, response) => {
      const q = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('q');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end([
        '<html><body>',
        `<a href="https://example.com/a">${q} result A</a>`,
        '<a href="https://example.com/b">Result B</a>',
        '</body></html>',
      ].join(''));
    });

    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', () => {
        const address = server?.address();
        if (address && typeof address === 'object') {
          process.env.KODAX_WEB_SEARCH_ENDPOINT = `http://127.0.0.1:${address.port}/search`;
        }
        resolve();
      });
    });

    const result = await toolWebSearch({
      query: 'kodax',
      limit: 2,
    }, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(result).toContain('Retrieval result for web_search');
    expect(result).toContain('kodax result A');
    expect(result).toContain('https://example.com/a');
  });

  it('extracts organic results from bing heading anchors', () => {
    const html = [
      '<html><body>',
      // Navigation chrome the generic anchor scanner would otherwise pick up.
      '<a href="https://cn.bing.com/images/search?q=x">图片</a>',
      // Paid ad stacked above the organic block must be skipped.
      '<li class="b_ad"><h2><a href="https://ad.example/buy">广告 Ad</a></h2></li>',
      '<li class="b_algo"><h2><a href="https://www.typescriptlang.org/">TypeScript</a></h2></li>',
      '<li class="b_algo"><h2><a href="https://www.runoob.com/typescript/?a=1&amp;b=2">菜鸟教程</a></h2></li>',
      '</body></html>',
    ].join('');

    const items = parseBingResults(html, 5);

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: 'TypeScript',
      locator: 'https://www.typescriptlang.org/',
    });
    // HTML entity in the href is decoded back to a usable URL.
    expect(items[1]?.locator).toBe('https://www.runoob.com/typescript/?a=1&b=2');
  });

  it('uses provider-backed search when requested', async () => {
    const result = await toolWebSearch({
      query: 'kodax',
      provider_id: 'provider-1',
    }, {
      backups: new Map(),
      executionCwd: process.cwd(),
      extensionRuntime: {
        searchCapabilities: async () => ([
          { title: 'Provider Result', url: 'https://provider.example/result' },
        ]),
      } as never,
    });

    expect(result).toContain('Provider: provider-1');
    expect(result).toContain('Provider Result');
  });

  it('probes one extra provider result and marks an explicit limit', async () => {
    let requestedLimit: number | undefined;
    const result = await toolWebSearch({
      query: 'kodax',
      provider_id: 'provider-1',
      limit: 2,
    }, {
      backups: new Map(),
      executionCwd: process.cwd(),
      extensionRuntime: {
        searchCapabilities: async (_provider: string, _query: string, options: { limit?: number }) => {
          requestedLimit = options.limit;
          return [
            { title: 'Provider Result 1', url: 'https://provider.example/one' },
            { title: 'Provider Result 2', url: 'https://provider.example/two' },
            { title: 'Provider Result 3', url: 'https://provider.example/three' },
          ];
        },
      } as never,
    });

    expect(requestedLimit).toBe(3);
    expect(result).toContain('RESULT_LIMIT_REACHED');
    expect(result).toContain('Provider Result 2');
    expect(result).not.toContain('Provider Result 3');
  });

  it('marks search evidence incomplete when the network acquisition safety limit is reached', async () => {
    server = createServer((_, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`${' '.repeat(256 * 1024)}<a href="https://after-limit.test">late result</a>`);
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', () => {
        const address = server?.address();
        if (address && typeof address === 'object') {
          process.env.KODAX_WEB_SEARCH_ENDPOINT = `http://127.0.0.1:${address.port}/search`;
        }
        resolve();
      });
    });

    const result = await toolWebSearch({ query: 'late' }, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(result).toContain('SOURCE_INCOMPLETE');
    expect(result).toContain('- truncated: true');
    expect(result).not.toContain('late result');
  });
});
