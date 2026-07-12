import { describe, expect, it } from 'vitest';

import {
  MANUAL_INDEX_MAX_BYTES,
  MANUAL_TOPIC_MAX_BYTES,
  resolveKodaXManual,
} from './resolver.js';

describe('FEATURE_218 resolveKodaXManual', () => {
  it('resolves an exact topic id', () => {
    const r = resolveKodaXManual({ topic: 'providers' });
    expect(r.matchedTopic).toBe('providers');
    expect(r.content.toLowerCase()).toContain('provider');
    expect(r.nextTopics.length).toBeGreaterThan(0);
  });

  it('resolves an English alias', () => {
    expect(resolveKodaXManual({ topic: 'settings' }).matchedTopic).toBe('config');
  });

  it('resolves a Chinese alias', () => {
    expect(resolveKodaXManual({ topic: '供应商' }).matchedTopic).toBe('providers');
    expect(resolveKodaXManual({ topic: '权限' }).matchedTopic).toBe('permissions');
  });

  it('resolves a free-text query by token overlap', () => {
    const r = resolveKodaXManual({ query: 'how do I configure an openai provider' });
    expect(['providers', 'custom-providers', 'config']).toContain(r.matchedTopic);
  });

  it('resolves extension authoring questions', () => {
    const r = resolveKodaXManual({ query: 'how do I write a KodaX extension' });
    expect(r.matchedTopic).toBe('extensions');
    expect(r.content).toContain('~/.kodax/extensions');
    expect(r.content).toContain('/extensions');
  });

  it('resolves a Chinese free-text query', () => {
    const r = resolveKodaXManual({ query: '怎么 resume 上一次 session' });
    expect(r.matchedTopic).toBe('sessions');
  });

  it('routes memory capability questions to the governed memory topic', () => {
    const r = resolveKodaXManual({ query: '你好，你现在有记忆能力吗？' });

    expect(r.matchedTopic).toBe('memory');
    expect(r.content).toContain('memory_recall');
    expect(r.content).toContain('/memory');
  });

  it('returns the index (never fabricates) for an unknown topic', () => {
    const r = resolveKodaXManual({ topic: 'definitely-not-a-topic-xyz' });
    expect(r.matchedTopic).toBe('index');
    expect(r.content).toContain('topic');
  });

  it('returns the full index for empty input', () => {
    const r = resolveKodaXManual({});
    expect(r.matchedTopic).toBe('index');
    // index lists all bundled topic ids
    expect(r.content).toContain('overview');
    expect(r.content).toContain('extensions');
    expect(r.content).toContain('troubleshooting');
  });

  it('prepends an anti-confusion scope anchor on topic answers', () => {
    const r = resolveKodaXManual({ topic: 'config' });
    expect(r.content).toContain('not Claude Code or Codex CLI');
    expect(r.content).toContain('~/.kodax/config.json');
  });

  it('caps topic output to the byte budget', () => {
    const r = resolveKodaXManual({ topic: 'providers' });
    expect(Buffer.byteLength(r.content, 'utf-8')).toBeLessThanOrEqual(MANUAL_TOPIC_MAX_BYTES);
  });

  it('caps index output to the byte budget', () => {
    const r = resolveKodaXManual({});
    expect(Buffer.byteLength(r.content, 'utf-8')).toBeLessThanOrEqual(MANUAL_INDEX_MAX_BYTES);
  });
});
