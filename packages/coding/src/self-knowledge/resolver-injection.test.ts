import { describe, expect, it } from 'vitest';

import { MANUAL_TOPIC_MAX_BYTES, resolveKodaXManual } from './resolver.js';
import { buildSelfKnowledgeRoutingRule } from './routing-rule.js';
import {
  KODAX_UNDERLYING_CAPABILITY_TOPICS,
  MANUAL_REGISTRY,
  MANUAL_TOPIC_IDS,
} from './registry.js';
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

  it('drops the KodaX config-path clause for a re-branded product (keeps it for KodaX)', () => {
    const consumer = buildSelfKnowledgeRoutingRule('KodaX-Space');
    // No KodaX config-path leak in a white-labeled routing rule.
    expect(consumer).not.toContain('~/.kodax');
    expect(consumer).not.toContain('KODAX_');
    expect(consumer).toContain('does not match KodaX-Space.');
    // Anti-Claude-Code/Codex framing is still present.
    expect(consumer).toContain('Only bring up Claude Code or Codex');
    // KodaX's own rule keeps the config-path clause (default byte-identical).
    const kodax = buildSelfKnowledgeRoutingRule();
    expect(kodax).toContain('does not match KodaX — KodaX uses');
    expect(kodax).toContain('~/.kodax/config.json and KODAX_* env vars');
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

describe('FEATURE_221 baseTopics seed control (curate / replace)', () => {
  it('undefined baseTopics seeds the full base (byte-identical default)', () => {
    const withUndefined = resolveKodaXManual({}, { extraTopics: SPACE_TOPICS });
    const index = withUndefined.content;
    for (const id of MANUAL_TOPIC_IDS) expect(index).toContain(id);
    expect(index).toContain('space-settings'); // extras still appended
  });

  it('baseTopics: [] is a full white-label replace — zero base topics seeded', () => {
    const opts = { extraTopics: SPACE_TOPICS, productName: 'KodaX-Space', baseTopics: [] as const };
    // A base-only id no longer resolves (not seeded).
    expect(resolveKodaXManual({ topic: 'providers' }, opts).matchedTopic).not.toBe('providers');
    // The index carries only the injected topics.
    const index = resolveKodaXManual({}, opts).content;
    expect(index).toContain('space-settings');
    expect(index).toContain('overview'); // injected override id
    expect(index).not.toContain('troubleshooting'); // base id, dropped
    expect(index).not.toContain('- install:'); // base id, dropped
  });

  it('baseTopics: subset seeds exactly those base ids + injected', () => {
    const opts = { extraTopics: SPACE_TOPICS, baseTopics: ['providers', 'config'] as const };
    expect(resolveKodaXManual({ topic: 'providers' }, opts).matchedTopic).toBe('providers');
    expect(resolveKodaXManual({ topic: 'config' }, opts).matchedTopic).toBe('config');
    // A base id NOT in the subset is no longer reachable.
    expect(resolveKodaXManual({ topic: 'install' }, opts).matchedTopic).not.toBe('install');
    expect(resolveKodaXManual({ topic: 'space-settings' }, opts).matchedTopic).toBe('space-settings');
  });

  it('KODAX_UNDERLYING_CAPABILITY_TOPICS keeps the mechanism topics, drops CLI/UX ones', () => {
    const r = resolveKodaXManual({}, {
      extraTopics: SPACE_TOPICS,
      baseTopics: KODAX_UNDERLYING_CAPABILITY_TOPICS,
    });
    // Mechanism topics a product inherits are retained…
    expect(resolveKodaXManual({ topic: 'mcp' }, { baseTopics: KODAX_UNDERLYING_CAPABILITY_TOPICS }).matchedTopic).toBe('mcp');
    expect(r.content).toContain('providers');
    expect(r.content).toContain('config');
    // …while KodaX-CLI-specific UX topics are excluded.
    expect(KODAX_UNDERLYING_CAPABILITY_TOPICS).not.toContain('install');
    expect(KODAX_UNDERLYING_CAPABILITY_TOPICS).not.toContain('doctor');
    expect(KODAX_UNDERLYING_CAPABILITY_TOPICS).not.toContain('commands');
    // Every id in the constant is a real base topic id.
    for (const id of KODAX_UNDERLYING_CAPABILITY_TOPICS) {
      expect(MANUAL_TOPIC_IDS).toContain(id);
    }
  });

  it('MANUAL_REGISTRY exposes every base topic body for build-time consumer docs', () => {
    for (const id of MANUAL_TOPIC_IDS) {
      const topic = MANUAL_REGISTRY[id];
      expect(topic, `MANUAL_REGISTRY missing ${id}`).toBeDefined();
      expect(topic.body.length, `${id} body empty`).toBeGreaterThan(0);
    }
  });
});
