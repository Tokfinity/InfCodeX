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

  it('documents the v0.7.71 public Kimi model contract', () => {
    const content = resolveKodaXManual({ topic: 'providers' }).content;

    expect(content).toContain('kimi-k2.7-code');
    expect(content).toContain('kimi-k2.7-code-highspeed');
    expect(content).toContain('262,144');
    expect(content).toContain('KIMI_API_KEY');
    expect(content).toContain('KIMI_CODE_API_KEY');
    expect(content).toContain('cannot disable thinking');
    expect(content).toContain('k3-256k');
    expect(content).toContain('Kimi K3');
    expect(content).toContain('1,048,576');
    expect(content).toContain('thinking.effort');
  });

  it('documents the v0.7.73 setup, Qwen Token Plan, and Runtime permission contracts', () => {
    const install = resolveKodaXManual({ topic: 'install' }).content;
    const providers = resolveKodaXManual({ topic: 'providers' }).content;
    const permissions = resolveKodaXManual({ topic: 'permissions' }).content;
    const sdk = resolveKodaXManual({ topic: 'sdk' }).content;

    expect(install).toContain('kodax setup');
    expect(install).toContain('never asks for or stores an API key');
    expect(install).toContain('restart terminal');
    expect(providers).toContain('qwen-token-plan');
    expect(providers).toContain('QWEN_TOKEN_API_KEY');
    expect(providers).toContain('qwen3.8-max-preview');
    expect(permissions).toContain('Runtime-owned');
    expect(permissions).toContain('allow once');
    expect(permissions).toContain('session-scoped');
    expect(permissions).toContain('persistent');
    expect(sdk).toContain('grantSuggestions');
    expect(sdk).toContain('RuntimePermissionMatcher');
    expect(sdk).toContain('runtimeAutoModeGuardrail');
  });

  it('documents the v0.7.73 regression closure for legacy grants and effort commands', () => {
    const commands = resolveKodaXManual({ topic: 'commands' }).content;
    const permissions = resolveKodaXManual({ topic: 'permissions' }).content;

    expect(commands).toContain('same native reasoning-effort control');
    expect(commands).toContain('none');
    expect(commands).toContain('quick/balanced/deep');
    expect(commands).toContain('when configured, the session classifier');
    expect(permissions).toContain('Legacy grants without a Runtime-issued matcher');
    expect(permissions).toContain('remain visible and revocable');
    expect(permissions).toMatch(/never\s+authorize a concrete call/);
  });

  it('documents the governed runtime and SDK memory surfaces', () => {
    const content = resolveKodaXManual({ topic: 'memory' }).content;

    expect(content).toContain('/memory');
    expect(content).toContain('memory_recall');
    expect(content).toContain('query()');
    expect(content).toContain('low-authority');
    expect(content).toContain('proposal/preview/fingerprint/apply');
  });

  it('documents the v0.7.74 always-on compaction contract', () => {
    const content = resolveKodaXManual({ topic: 'compaction' }).content;

    expect(content).toContain('always enabled');
    expect(content).toContain('defaults to 75');
    expect(content).toContain('15..90');
    expect(content).toContain('triggerTokens');
    expect(content).toContain('smaller');
    expect(content).toContain('20%');
    expect(content).toContain('complete eligible prefix');
    expect(content).toContain('user-query ledger');
    expect(content).toContain('post-commit');
    expect(content).toContain('persists their exact lineage');
    expect(content).toContain('sidecar is flushed');
    expect(content).toContain('commit callback is awaited');
    expect(content).toContain('Runtime becomes the persistence owner');
    expect(content).toContain('session_history_search');
    expect(content).toContain('session_history_read');
    expect(content).toContain('transcriptSearch()');
    expect(content).toContain('hidden reasoning');
    expect(content).toContain('cannot reconstruct bytes');
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

  it('documents the v0.7.71 A2A authentication, activation, and interoperability boundaries', () => {
    const a2a = resolveKodaXManual({ topic: 'a2a' });
    const mcp = resolveKodaXManual({ topic: 'mcp' }).content;

    expect(a2a.matchedTopic).toBe('a2a');
    expect(a2a.content).toContain('~/.kodax/integrations/a2a.json');
    expect(a2a.content).toContain('version 2');
    expect(a2a.content).toContain('a2a add|list|test|call|enable|disable|remove');
    expect(a2a.content).toContain('a2a migrate');
    expect(a2a.content).toContain('a2a expose');
    expect(a2a.content).toContain('a2a serve');
    expect(a2a.content).toContain('same trusted origin');
    expect(a2a.content).toContain('OAuth 2.0 Client Credentials');
    expect(a2a.content).toContain('OAuth Resource Server');
    expect(a2a.content).toContain('external Authorization Server');
    expect(a2a.content).toContain('securityRealm');
    expect(a2a.content).toContain('a2a migrate-tasks');
    expect(a2a.content).toContain('--confirm-server-stopped');
    expect(a2a.content).toContain('migrateA2ALegacyTaskOwners()');
    expect(a2a.content).toContain('does not cancel');
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
    expect(sdk.content).toContain('closeTimeoutMs');
    expect(sdk.content).toContain('30-second');
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
