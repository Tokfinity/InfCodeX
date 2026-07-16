import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  convertCapabilityReadResult,
  convertProviderSearchResults,
  finalizeRetrievalResult,
  renderRetrievalResult,
} from './retrieval.js';
import { TOOL_OUTPUT_DIR_ENV } from './truncate.js';

describe('finalizeRetrievalResult', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-retrieval-finalize-'));
    process.env[TOOL_OUTPUT_DIR_ENV] = tempDir;
  });

  afterEach(async () => {
    delete process.env[TOOL_OUTPUT_DIR_ENV];
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('renders the complete result without applying an internal capacity guard', async () => {
    const content = Array.from({ length: 3_000 }, (_, index) => `evidence-${index}`).join('\n');
    const result = await finalizeRetrievalResult({
      tool: 'web_fetch',
      scope: 'remote',
      trust: 'provider',
      freshness: 'unknown',
      summary: 'complete provider response',
      content,
      items: [],
    }, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(result).toContain('evidence-0');
    expect(result).toContain('evidence-2999');
    expect(result).not.toContain('Full output saved to:');
    expect(await fs.readdir(tempDir)).toEqual([]);
  });

  it('does not shorten locators, snippets, artifacts, or metadata before the batch guard', () => {
    const locator = `https://example.test/${'path/'.repeat(80)}end`;
    const snippet = `begin-${'evidence '.repeat(80)}-end`;
    const artifact = `C:/evidence/${'nested/'.repeat(60)}result.txt`;
    const metadata = `first-${'detail-'.repeat(80)}last`;

    const result = renderRetrievalResult({
      tool: 'web_fetch',
      scope: 'remote',
      trust: 'open-world',
      freshness: 'fresh',
      summary: 'complete fields',
      items: [{
        title: 'result',
        locator,
        snippet,
        metadata: { first: metadata, second: 'kept', third: 'kept', fourth: 'also-kept' },
      }],
      artifacts: [{ kind: 'path', label: 'full artifact', value: artifact }],
      metadata: { response: metadata },
    });

    expect(result).toContain(locator);
    expect(result).toContain(snippet);
    expect(result).toContain(artifact);
    expect(result).toContain(metadata);
    expect(result).toContain('- fourth: also-kept');
  });

  it('renders projected provider fields once while preserving distinct metadata', () => {
    const [item] = convertProviderSearchResults([{
      title: 'Canonical title',
      url: 'https://example.test/result',
      snippet: 'Canonical snippet',
      score: 0.75,
      category: 'reference',
    }], 1);

    expect(item?.metadata).toEqual({ category: 'reference' });
    const rendered = renderRetrievalResult({
      tool: 'web_search',
      scope: 'remote',
      trust: 'provider',
      freshness: 'unknown',
      summary: 'one result',
      items: item ? [item] : [],
    });

    expect(rendered.match(/Canonical title/g)).toHaveLength(1);
    expect(rendered.match(/https:\/\/example\.test\/result/g)).toHaveLength(1);
    expect(rendered.match(/Canonical snippet/g)).toHaveLength(1);
    expect(rendered).toContain('- category: reference');
    expect(rendered).not.toContain('- title:');
    expect(rendered).not.toContain('- url:');
    expect(rendered).not.toContain('- snippet:');
    expect(rendered).not.toContain('- score:');
  });

  it('keeps provider capability text byte-for-byte in the content field', () => {
    const result = convertCapabilityReadResult(
      'web_fetch',
      'provider',
      'resource',
      { kind: 'resource', content: '  leading\nbody\ntrailing  ' },
      'fetched',
    );

    expect(result.content).toBe('  leading\nbody\ntrailing  ');
  });

  it('omits an artifact that exactly repeats an item title and locator', () => {
    const rendered = renderRetrievalResult({
      tool: 'semantic_lookup',
      scope: 'workspace',
      trust: 'workspace',
      freshness: 'snapshot',
      summary: 'canonical handles',
      items: [{ title: 'Module A', locator: 'packages/a' }],
      artifacts: [
        { kind: 'module', label: 'Module A', value: 'packages/a' },
        { kind: 'path', label: 'Detailed report', value: 'reports/a.txt' },
      ],
    });

    expect(rendered.match(/packages\/a/g)).toHaveLength(1);
    expect(rendered).not.toContain('- module: Module A -> packages/a');
    expect(rendered).toContain('- path: Detailed report -> reports/a.txt');
  });
});
