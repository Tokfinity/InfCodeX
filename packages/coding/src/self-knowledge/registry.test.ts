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

  it('documents the governed runtime and SDK memory surfaces', () => {
    const content = resolveKodaXManual({ topic: 'memory' }).content;

    expect(content).toContain('/memory');
    expect(content).toContain('memory_recall');
    expect(content).toContain('query()');
    expect(content).toContain('low-authority');
    expect(content).toContain('proposal/preview/fingerprint/apply');
  });

  it('keeps the SDK topic aligned with current published subpaths', () => {
    const content = resolveKodaXManual({ topic: 'sdk' }).content;

    expect(content).toContain('11 SDK subpaths');
    expect(content).toContain('@kodax-ai/kodax/runtime');
    expect(content).toContain('@kodax-ai/kodax/experimental-memory');
    expect(content).toContain('@kodax-ai/kodax/a2a');
    expect(content).toContain('server.whenReady()');
    expect(content).toContain('sessions.observe()');
    expect(content).toContain('run-bound Host Tools');
  });

  it('documents the split integration configuration instead of legacy core fields', () => {
    const config = resolveKodaXManual({ topic: 'config' }).content;
    const mcp = resolveKodaXManual({ topic: 'mcp' }).content;
    const extensions = resolveKodaXManual({ topic: 'extensions' }).content;

    expect(config).toContain('~/.kodax/integrations/mcp.json');
    expect(config).toContain('~/.kodax/integrations/a2a.json');
    expect(config).toContain('~/.kodax/integrations/extensions.json');
    expect(config).toContain('kodax integrations migrate --apply');
    expect(config).toContain('MCP and Extensions');
    expect(config).toContain('does not overwrite an existing destination');
    expect(config).toContain('first MCP/Extension mutation');
    expect(config).toContain('literal-secret warnings');
    expect(mcp).toContain('~/.kodax/integrations/mcp.json');
    expect(extensions).toContain('~/.kodax/integrations/extensions.json');
    expect(extensions).toContain('config.json#extensions');
  });

  it('documents the v0.7.70 A2A and MCP interoperability boundaries', () => {
    const a2a = resolveKodaXManual({ topic: 'a2a' });
    const mcp = resolveKodaXManual({ topic: 'mcp' }).content;

    expect(a2a.matchedTopic).toBe('a2a');
    expect(a2a.content).toContain('~/.kodax/integrations/a2a.json');
    expect(a2a.content).toContain('a2a add|list|test|call|remove');
    expect(a2a.content).toContain('a2a expose');
    expect(a2a.content).toContain('a2a serve');
    expect(a2a.content).toContain('same trusted origin');
    expect(a2a.content).toContain('advertised Bearer');
    expect(a2a.content).toContain('original Runtime run');
    expect(a2a.content).toContain('stable opaque cursor');
    expect(a2a.content).toContain('explicitly admitted artifacts');
    expect(mcp).toContain('exact capability ids');
    expect(mcp).toContain('physical result capacity');
    expect(mcp).toContain('zero lexical match');
    expect(mcp).toContain('partial provider failure');
  });

  it('documents the v0.7.71 packaged Electron daemon boundary', () => {
    const sdk = resolveKodaXManual({ topic: 'sdk' });

    expect(sdk.matchedTopic).toBe('sdk');
    expect(sdk.content).toContain('Packaged/asar Electron');
    expect(sdk.content).toContain('ELECTRON_RUN_AS_NODE');
    expect(sdk.content).toContain('RunAsNode fuse');
    expect(sdk.content).toContain('attach-only');
    expect(sdk.content).toContain('homeDir');
  });

  it('documents the KAI-FCL boundary from v0.7.70 without rewriting history', () => {
    const result = resolveKodaXManual({ topic: 'license' });

    expect(result.matchedTopic).toBe('license');
    expect(result.content).toContain('KAI-FCL');
    expect(result.content).toContain('0.7.70 and later');
    expect(result.content).toContain('not OSI open source');
    expect(result.content).toContain('Commercial or Managed Use');
    expect(result.content).toContain('Apache-2.0');
  });
});
