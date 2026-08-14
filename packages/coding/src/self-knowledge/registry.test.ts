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

  it('documents the v0.7.77 public and subscription Kimi model contracts', () => {
    const content = resolveKodaXManual({ topic: 'providers' }).content;

    expect(content).toContain('kimi-k2.7-code');
    expect(content).toContain('kimi-k2.7-code-highspeed');
    expect(content).toContain('kimi-k3');
    expect(content).toContain('262,144');
    expect(content).toContain('KIMI_API_KEY');
    expect(content).toContain('KIMI_CODE_API_KEY');
    expect(content).toContain('cannot disable thinking');
    expect(content).toContain('k3-256k');
    expect(content).toContain('`kimi-for-coding` (K2.7 Code)');
    expect(content).toContain('Kimi K3');
    expect(content).toContain('1,048,576');
    expect(content).toContain('thinking.effort');
    expect(content).toContain('defaults to high');
  });

  it('documents the v0.7.87 GLM Coding Plan routes', () => {
    const content = resolveKodaXManual({ topic: 'providers' }).content;

    expect(content).toContain('`zhipu-coding` defaults to `glm-5.3`');
    expect(content).toContain('`zai-coding` defaults to `glm-5.2`');
    expect(content).toContain('keeps `glm-5.2`');
    expect(content).toContain('keeps `glm-5.3`');
    expect(content).toContain('sent verbatim');
    expect(content).toContain('never append `[1m]`');
    expect(content).toContain('cannot disable thinking');
    expect(content).toContain('none/minimal/light/low');
  });

  it('documents the v0.7.79 provider, A2A, Session, and Runtime contracts', () => {
    const providers = resolveKodaXManual({ topic: 'providers' }).content;
    const customProviders = resolveKodaXManual({ topic: 'custom-providers' }).content;
    const a2a = resolveKodaXManual({ topic: 'a2a' }).content;
    const sessions = resolveKodaXManual({ topic: 'sessions' }).content;
    const sdk = resolveKodaXManual({ topic: 'sdk' }).content;
    const sandbox = resolveKodaXManual({ topic: 'sandbox' }).content;

    expect(providers).toContain('deepseek-v4-flash');
    expect(providers).toContain('deepseek-v4-pro');
    expect(providers).toContain('text-only');
    expect(customProviders).toContain('maxOutputTokensField');
    expect(customProviders).toContain('max_completion_tokens');
    expect(customProviders).toContain('per-model');

    expect(a2a).toContain('--allow-private');
    expect(a2a).toContain('--allow-insecure-http');
    expect(a2a).toContain('default deny');
    expect(a2a).toContain('exact loopback HTTP');

    expect(sessions).toContain('readSessionCapture()');
    expect(sessions).toContain('readFullTranscript()');
    expect(sessions).toContain('readConversationHistory()');
    expect(sessions).toContain('exportSessionBundle()');
    expect(sessions).toContain('read-only');

    expect(sdk).toContain('runtimeEventCoalescing:1');
    expect(sdk).toContain('sessions.status()');
    expect(sdk).toContain('sessions.conversation()');
    expect(sdk).toContain('conversationHistory:1');
    expect(sdk).toContain('captureRuntimeSessionDiagnostics()');
    expect(sdk).toContain('sessions.diagnostics()');
    expect(sdk).toContain('Job Object');
    expect(sdk).toContain('Issue 256');

    expect(sandbox).toContain('sandbox.envPass');
    expect(sandbox).toContain('GH_TOKEN');
    expect(sandbox).toContain('default');
    expect(sandbox).toContain('KodaXOptions.sandbox');
    expect(sandbox).toContain('Run-scoped');
    expect(sandbox).toContain('case-insensitive PATH/Path');
    expect(sandbox).toContain('verbatim-argument contract');
    expect(sandbox).toContain('capability metadata is version 3');
    expect(sandbox).toContain('already-approved normal permission path');
    expect(sandbox).toContain('only the last owner recovers');
  });

  it('documents the v0.7.77 adaptive AMA and governed memory intervention contracts', () => {
    const agents = resolveKodaXManual({ topic: 'agents' }).content;
    const memory = resolveKodaXManual({ topic: 'memory' }).content;
    const sdk = resolveKodaXManual({ topic: 'sdk' }).content;

    expect(agents).toContain('parallel-first');
    expect(agents).toContain('fan them out');
    expect(agents).toContain('not a Worker dispatch gate');
    expect(agents).toContain('quality_strategy');
    expect(agents).toContain('PatternTrace');
    expect(agents).toMatch(/sole\s+terminal-answer quality adjudicator/);
    expect(agents).toContain('500 tool-loop');
    expect(agents).toContain('RunnerIterationLimitError');
    expect(agents).toContain('readRunnerRecoveryTranscript');
    expect(memory).toContain('MemorySession.intervene()');
    expect(memory).toContain('tool_failure');
    expect(memory).toContain('verification_failure');
    expect(memory).toContain('context_compacted');
    expect(memory).toContain('memoryRecallRunner');
    expect(memory).toContain('fails silent');
    expect(sdk).toContain('memoryRecallRunner');
    expect(sdk).toContain('iteration limit');
    expect(sdk).toMatch(/input\s+window/);
  });

  it('documents the v0.7.81 canonical interrupt-entry contract', () => {
    const sdk = resolveKodaXManual({ topic: 'sdk' }).content;

    expect(sdk).toContain('entryId');
    expect(sdk).toContain('canonical session-entry reference');
    expect(sdk).toContain('legacy');
    expect(sdk).toMatch(/fails\s+the\s+current\s+delivery\s+closed/);
  });

  it('documents the v0.7.82 discovery and runtime-causality contract', () => {
    const mcp = resolveKodaXManual({ topic: 'mcp' }).content;
    const sdk = resolveKodaXManual({ topic: 'sdk' }).content;

    expect(mcp).toContain('lease-scoped live, complete snapshot');
    expect(mcp).toContain('unfiltered');
    expect(mcp).toContain('incomplete/unknown');
    expect(sdk).toContain('authoritative Run');
    expect(sdk).toContain('data_changed');
    expect(sdk).toContain('cooperative');
  });

  it('documents the current Windows and Actor settlement contracts', () => {
    const sdk = resolveKodaXManual({ topic: 'sdk' }).content;

    expect(sdk).toContain('waitForRuntimeDaemonShutdown()');
    expect(sdk).toContain('daemonShutdownVerification:1');
    expect(sdk).toContain('kill-on-close');
    expect(sdk).toContain('cannot be migrated safely in place');
    expect(sdk).toContain('Issue 256');
    expect(sdk).toContain('Since v0.7.84');
    expect(sdk).toContain('one latest replacement');
    expect(sdk).toContain('same-owner Stop');
  });

  it('documents the v0.7.85 journal, startup, Worker, and Memory boundaries', () => {
    const sdk = resolveKodaXManual({ topic: 'sdk' }).content;
    const memory = resolveKodaXManual({ topic: 'memory' }).content;

    expect(sdk).toContain('Session journal');
    expect(sdk).toContain('journalEpoch');
    expect(sdk).toContain('sessionEventJournal:1');
    expect(sdk).toContain('without replaying its complete event journal');
    expect(sdk).toContain('retires after its idle warm-cache window');
    expect(memory).toContain('conversation-first');
    expect(sdk).toContain('F289/F290');
    expect(sdk).toContain('MemoryManagementAgent');
  });

  it('documents the v0.7.86 ownership and sandbox lifecycle boundaries', () => {
    const sdk = resolveKodaXManual({ topic: 'sdk' }).content;

    expect(sdk).toContain('Since v0.7.86');
    expect(sdk).toContain('process-start identity');
    expect(sdk).toContain('termination proof before ACL recovery');
    expect(sdk).toContain('never replays the command');
    expect(sdk).toContain('initialize fresh KODAX_HOME policy roots');
    expect(sdk).toContain('lease-cleanup failure');
    expect(sdk).toContain('remains open after v0.7.87');
  });

  it('documents the v0.7.78 evidence-gated background Skill learning boundary', () => {
    const content = resolveKodaXManual({ topic: 'skills' }).content;

    expect(content).toContain('Memory first');
    expect(content).toContain('project-scoped');
    expect(content).toContain('three exact-revision invocations');
    expect(content).toContain('all three outcomes settle');
    expect(content).toContain('independently verified success');
    expect(content).toContain('credible negative quarantines immediately');
    expect(content).toContain('/learn');
    expect(content).toMatch(/protected\/formal/i);
    expect(content).toContain('global promotion');
    expect(content).toContain('Extension');
    expect(content).toContain('/learn promote');
    expect(content).toContain('--scope user');
    expect(content).toContain('ready or active_learned');
    expect(content).toContain('atomically');
    expect(content).toContain('without overwriting');
  });

  it('documents the v0.7.73 setup, Qwen Token Plan, and Runtime permission contracts', () => {
    const install = resolveKodaXManual({ topic: 'install' }).content;
    const providers = resolveKodaXManual({ topic: 'providers' }).content;
    const permissions = resolveKodaXManual({ topic: 'permissions' }).content;
    const sdk = resolveKodaXManual({ topic: 'sdk' }).content;

    expect(install).toContain('kodax setup');
    expect(install).toContain('never asks for or stores an API key');
    expect(install).toContain('restart terminal');
    expect(install).toContain('kodax setup --custom');
    expect(install).toContain('/setup --help');
    expect(providers).toContain('qwen-token-plan');
    expect(providers).toContain('QWEN_TOKEN_API_KEY');
    expect(providers).toContain('defaults to `qwen3.8-max`');
    expect(providers).toContain('qwen3.8-max-preview');
    expect(permissions).toContain('Runtime-owned');
    expect(permissions).toContain('allow once');
    expect(permissions).toContain('session-scoped');
    expect(permissions).toContain('persistent');
    expect(permissions).toContain('static Skill');
    expect(permissions).toContain('Edit and Plan');
    expect(permissions).toContain('dynamic-context commands');
    expect(permissions).toContain('explicit host-controlled executor');
    expect(sdk).toContain('grantSuggestions');
    expect(sdk).toContain('RuntimePermissionMatcher');
    expect(sdk).toContain('runtimeAutoModeGuardrail` v4');
    expect(sdk).toContain('requires v4');
    expect(sdk).toContain('fallbackPersistsEngine:false');
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

  it('keeps setup commands and the default mode shortcuts in the commands topic', () => {
    const commands = resolveKodaXManual({ topic: 'commands' }).content;

    expect(commands).toContain('/setup --custom');
    expect(commands).toContain('/setup --help');
    expect(commands).toContain('Ctrl+T');
    expect(commands).toContain('Shift+Tab');
    expect(commands).toContain('Alt+M');
    expect(commands).toMatch(/Ctrl\+T.*reasoning/i);
    expect(commands).toMatch(/Shift\+Tab.*permission/i);
    expect(commands).toMatch(/Alt\+M.*AMA\/SA/i);
  });

  it('documents the governed runtime and SDK memory surfaces', () => {
    const content = resolveKodaXManual({ topic: 'memory' }).content;

    expect(content).toContain('/memory');
    expect(content).toContain('memory_recall');
    expect(content).toContain('memory_intent');
    expect(content).toContain('exact quote');
    expect(content).toContain('apply immediately');
    expect(content).toContain('do not create a duplicate episode review');
    expect(content).toContain('conversation-first');
    expect(content).toContain('exceptional inferred changes remain reviewable');
    expect(content).toContain('MEMORY.md is a derived projection');
    expect(content).toContain('external application');
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

  it('documents the v0.7.74 mailbox-driven Agent coordination contract', () => {
    const agents = resolveKodaXManual({ topic: 'agents' }).content;
    const sdk = resolveKodaXManual({ topic: 'sdk' }).content;

    expect(agents).toContain('Runtime-owned Actor/Turn tree');
    expect(agents).toContain('model-facing mailbox yield');
    expect(agents).toContain('10,000..3,600,000');
    expect(agents).toContain('user_input_pending');
    expect(agents).toContain('Actor progress and system reminders do not wake the model');
    expect(agents).toContain('Do not poll `agent_output`');
    expect(agents).toContain('synthetic evidence');
    expect(agents).toContain('pending-delivery');
    expect(agents).toContain('Managed Workflow `runAgent`');
    expect(agents).toContain('omitted workflow timeout');
    expect(agents).toContain('polling window');
    expect(agents).toContain('explicit workflow deadline');
    expect(sdk).toContain('runtime.agents.events()');
    expect(sdk).toContain('runtime.agents.wait(sessionId, afterSequence, timeoutMs)');
    expect(sdk).toContain('interruptInput:1');
    expect(sdk).toContain('runtime.runs.submitInput()');
  });

  it('documents the v0.7.74 resume and Auto mode-switch reliability closures', () => {
    const sessions = resolveKodaXManual({ topic: 'sessions' }).content;
    const permissions = resolveKodaXManual({ topic: 'permissions' }).content;

    expect(sessions).toContain('non-empty');
    expect(sessions).toContain('zero-message');
    expect(sessions).toContain('classic and Ink');
    expect(sessions).toContain('saved workspace');
    expect(permissions).toContain('Shift-Tab');
    expect(permissions).toContain('Shift+Enter');
    expect(permissions).toContain('Auto[LLM]');
    expect(permissions).toContain('Auto[RULES]');
    expect(permissions).toContain('/auto-engine llm');
  });

  it('keeps the SDK topic aligned with current published subpaths', () => {
    const content = resolveKodaXManual({ topic: 'sdk' }).content;

    expect(content).toContain('12 SDK subpaths');
    expect(content).toContain('@kodax-ai/kodax/runtime');
    expect(content).toContain('@kodax-ai/kodax/sandbox');
    expect(content).toContain('@kodax-ai/kodax/experimental-memory');
    expect(content).toContain('@kodax-ai/kodax/a2a');
    expect(content).toContain('server.whenReady()');
    expect(content).toContain('sessions.observe()');
    expect(content).toContain('run-bound Host Tools');
    expect(content).toContain('runtime.learning');
    expect(content).toContain('skillLearningLoop');
    expect(content).toContain('loopback identity challenge');
    expect(content).toMatch(/reuses\s+the PID/);
  });

  it('documents the v0.7.78 sensitive-home workspace containment boundary', () => {
    const content = resolveKodaXManual({ topic: 'sandbox' }).content;

    expect(content).toContain('common home credential paths');
    expect(content).toMatch(/complete\s+resolved agent home/);
    expect(content).toContain('cannot reopen a denied subtree');
    expect(content).toMatch(/ordinary\s+external reads/);
  });

  it('documents the split integration configuration instead of legacy core fields', () => {
    const config = resolveKodaXManual({ topic: 'config' }).content;
    const mcp = resolveKodaXManual({ topic: 'mcp' }).content;
    const extensions = resolveKodaXManual({ topic: 'extensions' }).content;

    expect(config).toContain('~/.kodax/integrations/mcp.json');
    expect(config).toContain('~/.kodax/integrations/a2a.json');
    expect(config).toContain('~/.kodax/integrations/extensions.json');
    expect(config).toContain('~/.kodax/config.example.jsonc');
    expect(config).toContain('strict JSON');
    expect(config).toContain('template first line');
    expect(config).toContain('kodax config paths');
    expect(config).toContain('kodax integrations migrate --apply');
    expect(config).toContain('MCP and Extensions');
    expect(config).toContain('does not overwrite an existing destination');
    expect(config).toContain('first MCP/Extension mutation');
    expect(config).toContain('literal-secret warnings');
    expect(config).toContain('"version": 2');
    expect(config).toContain('safe empty document');
    expect(config).toContain('does not delete or rewrite');
    expect(config).toContain('bootstrap.log');
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
