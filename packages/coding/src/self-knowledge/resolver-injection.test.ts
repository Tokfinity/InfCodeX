import { describe, expect, it } from 'vitest';

import { MANUAL_TOPIC_MAX_BYTES, resolveKodaXManual } from './resolver.js';
import { buildSelfKnowledgeRoutingRule } from './routing-rule.js';
import type { KodaXManualTopicInput } from './types.js';

const SPACE_TOPICS: readonly KodaXManualTopicInput[] = [
  {
    id: 'space-settings',
    title: 'KodaX-Space Settings',
    summary: 'How to configure KodaX-Space.',
    body: 'Open Settings → Providers in KodaX-Space and ...',
    aliases: ['space config', '空间设置'],
  },
  {
    // overrides the KodaX base 'overview' topic
    id: 'overview',
    title: 'KodaX-Space Overview',
    summary: 'What KodaX-Space is.',
    body: 'KodaX-Space is a desktop product built on KodaX.',
  },
];

const SPACE = { extraTopics: SPACE_TOPICS, productName: 'KodaX-Space' };

describe('FEATURE_221 injectable self-manual', () => {
  it('resolves an injected consumer topic by id', () => {
    const r = resolveKodaXManual({ topic: 'space-settings' }, SPACE);
    expect(r.matchedTopic).toBe('space-settings');
    expect(r.content).toContain('KodaX-Space');
    expect(r.content).toContain('Settings → Providers');
  });

  it('resolves an injected topic by alias (incl. Chinese)', () => {
    expect(resolveKodaXManual({ topic: '空间设置' }, SPACE).matchedTopic).toBe('space-settings');
  });

  it('injected topic overrides a base topic with the same id', () => {
    const r = resolveKodaXManual({ topic: 'overview' }, SPACE);
    expect(r.title).toBe('KodaX-Space Overview');
    expect(r.content).toContain('built on KodaX');
  });

  it('extends (keeps) base KodaX topics alongside injected ones', () => {
    // 'providers' is a KodaX base topic, still reachable.
    expect(resolveKodaXManual({ topic: 'providers' }, SPACE).matchedTopic).toBe('providers');
    // index lists both injected and base topics.
    const index = resolveKodaXManual({}, SPACE).content;
    expect(index).toContain('space-settings');
    expect(index).toContain('troubleshooting');
  });

  it('re-brands the scope anchor and index title with productName', () => {
    expect(resolveKodaXManual({ topic: 'providers' }, SPACE).content).toContain(
      'about KodaX-Space itself',
    );
    expect(resolveKodaXManual({}, SPACE).title).toBe('KodaX-Space Manual — Index');
  });

  it('does not leak the ~/.kodax config path into a re-branded consumer manual', () => {
    // A white-labeled consumer topic must not carry KodaX's config-path hint.
    expect(resolveKodaXManual({ topic: 'space-settings' }, SPACE).content).not.toContain('~/.kodax');
    // …but KodaX's own manual still keeps it (default byte-identity preserved).
    expect(resolveKodaXManual({ topic: 'providers' }).content).toContain('~/.kodax/config.json');
  });

  it('byte-caps an oversized injected topic body', () => {
    const huge = 'x'.repeat(20000);
    const r = resolveKodaXManual(
      { topic: 'big' },
      { extraTopics: [{ id: 'big', title: 'Big', summary: 's', body: huge }] },
    );
    expect(Buffer.byteLength(r.content, 'utf-8')).toBeLessThanOrEqual(MANUAL_TOPIC_MAX_BYTES);
  });

  it('is backward compatible — no options resolves the default KodaX manual', () => {
    const r = resolveKodaXManual({ topic: 'providers' });
    expect(r.matchedTopic).toBe('providers');
    expect(r.content).toContain('about KodaX itself');
  });

  it('buildSelfKnowledgeRoutingRule substitutes the product name', () => {
    expect(buildSelfKnowledgeRoutingRule('KodaX-Space')).toContain('KodaX-Space self-knowledge');
    expect(buildSelfKnowledgeRoutingRule()).toContain('KodaX self-knowledge');
  });

  it('re-brands the config-path clause too (no leftover "KodaX uses" for a consumer)', () => {
    const rule = buildSelfKnowledgeRoutingRule('KodaX-Space');
    expect(rule).toContain('does not match KodaX-Space — KodaX-Space uses');
    // Default stays byte-identical at the clause.
    expect(buildSelfKnowledgeRoutingRule()).toContain('does not match KodaX — KodaX uses');
  });

  it('tolerates an injected topic with a missing (null) body — no raw TypeError', () => {
    const r = resolveKodaXManual(
      { topic: 'broken' },
      // A plain-JS SDK consumer may pass null/undefined fields.
      { extraTopics: [{ id: 'broken', title: 'Broken', summary: undefined as never, body: null as never }] },
    );
    expect(r.matchedTopic).toBe('broken');
    expect(typeof r.content).toBe('string');
  });
});
