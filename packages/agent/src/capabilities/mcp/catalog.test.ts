import { describe, expect, it } from 'vitest';
import {
  createMcpCapabilityId,
  normalizeMcpCapabilityId,
  parseMcpCapabilityId,
  sanitizeMcpIcons,
} from './catalog.js';

describe('MCP capability ids', () => {
  it('creates and parses canonical mcp:<server>:<kind>:<name> ids', () => {
    const id = createMcpCapabilityId('git-nexus', 'tool', 'list_branches');

    expect(id).toBe('mcp:git-nexus:tool:list_branches');
    expect(parseMcpCapabilityId(id)).toEqual({
      serverId: 'git-nexus',
      kind: 'tool',
      name: 'list_branches',
    });
  });

  it('normalizes the common missing-scheme form from model tool calls', () => {
    const id = 'git-nexus:tool:list_branches';

    expect(normalizeMcpCapabilityId(id)).toBe('mcp:git-nexus:tool:list_branches');
    expect(parseMcpCapabilityId(id)).toEqual({
      serverId: 'git-nexus',
      kind: 'tool',
      name: 'list_branches',
    });
  });

  it('normalizes legacy mcp:// URI capability ids', () => {
    const id = 'mcp://git-nexus/resource/memory%3A%2F%2Fguide';

    expect(normalizeMcpCapabilityId(id)).toBe('mcp:git-nexus:resource:memory%3A%2F%2Fguide');
    expect(parseMcpCapabilityId(id)).toEqual({
      serverId: 'git-nexus',
      kind: 'resource',
      name: 'memory://guide',
    });
  });
});

describe('sanitizeMcpIcons', () => {
  it('keeps http(s) and data URIs and normalizes optional fields', () => {
    const icons = sanitizeMcpIcons([
      { src: 'https://example.com/a.png', mimeType: 'image/png', sizes: ['48x48', ''], theme: 'dark' },
      { src: 'data:image/svg+xml;base64,AAAA' },
    ]);
    expect(icons).toEqual([
      { src: 'https://example.com/a.png', mimeType: 'image/png', sizes: ['48x48'], theme: 'dark' },
      { src: 'data:image/svg+xml;base64,AAAA' },
    ]);
  });

  it('drops unsafe-scheme, relative, and malformed icons', () => {
    expect(sanitizeMcpIcons([
      { src: 'javascript:alert(1)' },
      { src: 'file:///etc/passwd' },
      { src: 'ftp://host/x.png' },
      { src: 'ws://host/x.png' },
      { src: '/relative/icon.png' },
      { src: '' },
      { nope: true },
      42,
      null,
    ])).toBeUndefined();
  });

  it('returns undefined for non-array input', () => {
    expect(sanitizeMcpIcons(undefined)).toBeUndefined();
    expect(sanitizeMcpIcons({ src: 'https://x/y.png' })).toBeUndefined();
  });

  it('ignores invalid theme and non-string sizes', () => {
    expect(sanitizeMcpIcons([
      { src: 'https://x/y.png', theme: 'rainbow', sizes: ['16x16', 5, null] },
    ])).toEqual([{ src: 'https://x/y.png', sizes: ['16x16'] }]);
  });
});
