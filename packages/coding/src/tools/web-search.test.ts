import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBingResults, toolWebSearch } from './web-search.js';

describe('toolWebSearch', () => {
  let server: ReturnType<typeof createServer> | undefined;
  let previousEndpoint: string | undefined;

  beforeEach(() => {
    previousEndpoint = process.env.KODAX_WEB_SEARCH_ENDPOINT;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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

  it('uses DuckDuckGo HTML results before contacting a fallback engine', async () => {
    delete process.env.KODAX_WEB_SEARCH_ENDPOINT;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain('html.duckduckgo.com/html/');
      return new Response([
        '<html><body>',
        '<div class="result results_links">',
        '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Ficetomoyo%2FKodaX&amp;rut=ignored">KodaX &amp; GitHub</a>',
        '<a class="result__snippet">A lightweight <b>coding agent</b> with CAPTCHA guidance.</a>',
        '</div>',
        '</body></html>',
      ].join(''), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await toolWebSearch({ query: 'kodax', limit: 5 }, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toContain('KodaX & GitHub');
    expect(result).toContain('Locator: https://github.com/icetomoyo/KodaX');
    expect(result).toContain('Snippet: A lightweight coding agent with CAPTCHA guidance.');
    expect(result).toContain('- engine: duckduckgo');
    expect(result).toContain('- transport: html');
    expect(result).toContain('Freshness: unknown');
  });

  it('deduplicates DuckDuckGo targets before applying the result limit', async () => {
    delete process.env.KODAX_WEB_SEARCH_ENDPOINT;
    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone">One</a>',
      '<a class="result__snippet">First copy.</a>',
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone">One duplicate</a>',
      '<a class="result__snippet">Duplicate copy.</a>',
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ftwo">Two</a>',
      '<a class="result__snippet">Second result.</a>',
    ].join(''), { status: 200 })));

    const result = await toolWebSearch({ query: 'examples', limit: 2 }, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(result).toContain('1. One');
    expect(result).toContain('2. Two');
    expect(result).not.toContain('One duplicate');
  });

  it('does not fall back when DuckDuckGo returns a recognized empty result page', async () => {
    delete process.env.KODAX_WEB_SEARCH_ENDPOINT;
    const fetchMock = vi.fn(async () => new Response(
      '<html><div class="no-results">No results found.</div></html>',
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await toolWebSearch({ query: 'definitely absent' }, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toContain('No web search results for "definitely absent".');
    expect(result).toContain('- attempts: ["duckduckgo-html"]');
  });

  it('falls back from a DuckDuckGo challenge page to Bing RSS', async () => {
    delete process.env.KODAX_WEB_SEARCH_ENDPOINT;
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes('html.duckduckgo.com')) {
        return new Response('<html><form id="challenge-form">bots use this form</form></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      expect(url).toContain('www.bing.com/search');
      expect(url).toContain('format=rss');
      return new Response([
        '<?xml version="1.0" encoding="utf-8"?>',
        '<rss version="2.0"><channel>',
        '<item><title>KodaX repository</title>',
        '<link>https://github.com/icetomoyo/KodaX</link>',
        '<description>Lightweight coding agent &amp; SDK.</description></item>',
        '</channel></rss>',
      ].join(''), {
        status: 200,
        headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await toolWebSearch({ query: 'kodax' }, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(requestedUrls).toHaveLength(2);
    expect(result).toContain('KodaX repository');
    expect(result).toContain('Snippet: Lightweight coding agent & SDK.');
    expect(result).toContain('- engine: bing');
    expect(result).toContain('- transport: rss');
    expect(result).toContain('- attempts: ["duckduckgo-html","bing-rss"]');
    expect(result).toContain('duckduckgo-html:challenge');
  });

  it('falls back from invalid Bing RSS to Bing HTML with snippets', async () => {
    delete process.env.KODAX_WEB_SEARCH_ENDPOINT;
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes('duckduckgo.com')) {
        return new Response('rate limited', { status: 429 });
      }
      if (url.includes('format=rss')) {
        return new Response('<rss version="2.0"><channel>', { status: 200 });
      }
      return new Response([
        '<html><body>',
        '<li class="b_algo">',
        '<h2><a href="https://www.typescriptlang.org/">TypeScript</a></h2>',
        '<div class="b_caption"><p>Typed JavaScript at any scale.</p></div>',
        '</li>',
        '</body></html>',
      ].join(''), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }));

    const result = await toolWebSearch({ query: 'typescript' }, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(requestedUrls).toHaveLength(3);
    expect(result).toContain('TypeScript');
    expect(result).toContain('Snippet: Typed JavaScript at any scale.');
    expect(result).toContain('- attempts: ["duckduckgo-html","bing-rss","bing-html"]');
    expect(result).toContain('duckduckgo-html:http-429');
    expect(result).toContain('bing-rss:unrecognized-response');
  });

  it('reports every failed default attempt instead of returning a false empty result', async () => {
    delete process.env.KODAX_WEB_SEARCH_ENDPOINT;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>unexpected</html>', { status: 200 })));

    const result = await toolWebSearch({ query: 'kodax' }, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(result).toContain('[Tool Error] web_search: all default search attempts failed');
    expect(result).toContain('duckduckgo-html:unrecognized-response');
    expect(result).toContain('bing-rss:unrecognized-response');
    expect(result).toContain('bing-html:unrecognized-response');
    expect(result).not.toContain('No web search results');
  });

  it('bounds all default attempts within one twelve-second search budget', async () => {
    delete process.env.KODAX_WEB_SEARCH_ENDPOINT;
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      })
    ));
    vi.stubGlobal('fetch', fetchMock);

    const pending = toolWebSearch({ query: 'slow' }, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });
    await vi.advanceTimersByTimeAsync(12_000);
    const result = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toContain('duckduckgo-html:timeout');
    expect(result).toContain('bing-rss:timeout');
    expect(result).toContain('bing-html:timeout');
  });

  it('never leaks an explicit custom endpoint failure into public fallbacks', async () => {
    process.env.KODAX_WEB_SEARCH_ENDPOINT = 'https://search.internal.test/?q={query}';
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe('https://search.internal.test/?q=private%20query');
      return new Response('unavailable', { status: 503 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await toolWebSearch({ query: 'private query' }, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toBe('[Tool Error] web_search: http-503');
  });

  it('accepts an empty custom endpoint page that discusses CAPTCHA', async () => {
    process.env.KODAX_WEB_SEARCH_ENDPOINT = 'https://search.internal.test/?q={query}';
    const fetchMock = vi.fn(async () => new Response(
      '<html><body>No results for CAPTCHA documentation.</body></html>',
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await toolWebSearch({ query: 'CAPTCHA documentation' }, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toContain('No web search results for "CAPTCHA documentation".');
    expect(result).not.toContain('[Tool Error]');
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
      '<li class="b_algo"><h2><a href="https://">Invalid</a></h2></li>',
      '<li class="b_algo"><h2><a href="https://www.typescriptlang.org:443/a/../">TypeScript</a></h2></li>',
      '<li class="b_algo"><h2><a href="https://www.typescriptlang.org/">TypeScript duplicate</a></h2></li>',
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
