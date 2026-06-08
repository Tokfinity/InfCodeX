import { describe, expect, it } from 'vitest';

import { resolveKodaXManual } from './resolver.js';
import { MANUAL_PROVIDER_NAMES, MANUAL_REGISTRY, MANUAL_TOPIC_IDS } from './registry.js';

describe('FEATURE_218 manual registry', () => {
  it('has a topic for every id and the topic.id matches its key', () => {
    for (const id of MANUAL_TOPIC_IDS) {
      const topic = MANUAL_REGISTRY[id];
      expect(topic, `missing topic ${id}`).toBeDefined();
      expect(topic.id).toBe(id);
    }
    expect(Object.keys(MANUAL_REGISTRY).length).toBe(MANUAL_TOPIC_IDS.length);
  });

  it('has no duplicate aliases across topics', () => {
    const seen = new Map<string, string>();
    for (const id of MANUAL_TOPIC_IDS) {
      for (const alias of MANUAL_REGISTRY[id].aliases) {
        const key = alias.toLowerCase();
        const prior = seen.get(key);
        expect(prior, `alias "${alias}" used by both ${prior} and ${id}`).toBeUndefined();
        seen.set(key, id);
      }
    }
  });

  it('has non-empty title/summary/body for every topic', () => {
    for (const id of MANUAL_TOPIC_IDS) {
      const t = MANUAL_REGISTRY[id];
      expect(t.title.length, id).toBeGreaterThan(0);
      expect(t.summary.length, id).toBeGreaterThan(0);
      expect(t.body.length, id).toBeGreaterThan(0);
    }
  });

  it('only references valid topic ids in nextTopics', () => {
    const valid = new Set<string>(MANUAL_TOPIC_IDS);
    for (const id of MANUAL_TOPIC_IDS) {
      for (const next of MANUAL_REGISTRY[id].nextTopics) {
        expect(valid.has(next), `${id} -> unknown nextTopic ${next}`).toBe(true);
      }
    }
  });

  it('drift guard: providers topic covers every provider in provider-capabilities.json', () => {
    expect(MANUAL_PROVIDER_NAMES.length).toBeGreaterThan(0);
    const content = resolveKodaXManual({ topic: 'providers' }).content;
    for (const name of MANUAL_PROVIDER_NAMES) {
      expect(content, `providers topic missing "${name}"`).toContain(name);
    }
  });
});
