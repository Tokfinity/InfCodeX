import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildStallSignalEnvelope,
  createStallDetector,
  stableStringify,
} from './stall-detector.js';

describe('FEATURE_178 (v0.7.42): L1 stall detector', () => {
  describe('stableStringify (key-order canonicalization)', () => {
    it('produces the same string regardless of object key order', () => {
      const a = stableStringify({ path: '/x', offset: 1, limit: 2000 });
      const b = stableStringify({ limit: 2000, path: '/x', offset: 1 });
      expect(a).toBe(b);
    });

    it('handles nested objects with stable ordering', () => {
      const a = stableStringify({ nested: { b: 2, a: 1 }, top: 'x' });
      const b = stableStringify({ top: 'x', nested: { a: 1, b: 2 } });
      expect(a).toBe(b);
    });

    it('preserves array element order (semantically meaningful)', () => {
      expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
      expect(stableStringify([1, 2, 3])).toBe('[1,2,3]');
    });

    it('normalizes non-serializable types to a stable sentinel', () => {
      expect(stableStringify(undefined)).toBe('"__non_serializable__"');
      expect(stableStringify(() => 1)).toBe('"__non_serializable__"');
    });

    it('handles null and primitives correctly', () => {
      expect(stableStringify(null)).toBe('null');
      expect(stableStringify(42)).toBe('42');
      expect(stableStringify('hello')).toBe('"hello"');
      expect(stableStringify(true)).toBe('true');
    });
  });

  describe('buildStallSignalEnvelope (eval contract)', () => {
    it('matches the exact format the F178 eval cases.ts pins', () => {
      const envelope = buildStallSignalEnvelope({
        toolName: 'read',
        inputJson: '{"path":"C:/proj/index.html","offset":1,"limit":2000}',
        occurrenceCount: 3,
        cacheHitCount: 2,
        turns: [12, 13, 14],
      });
      // Exact line shape from benchmark/datasets/feature-178-stall-sidecar/cases.ts P1_CASE.signalEnvelope.
      expect(envelope).toBe(
        '[Stall detector signal]\n'
          + 'tool=read input={"path":"C:/proj/index.html","offset":1,"limit":2000} '
          + 'occurrence_count=3 cache_hit_count=2 turns=[12,13,14]',
      );
    });

    it('handles single-turn cases without an extra trailing comma', () => {
      const envelope = buildStallSignalEnvelope({
        toolName: 'bash',
        inputJson: '{"command":"ls"}',
        occurrenceCount: 2,
        cacheHitCount: 0,
        turns: [5, 7],
      });
      expect(envelope).toContain('turns=[5,7]');
      expect(envelope).not.toContain('turns=[5,7,]');
    });
  });

  describe('Rule A: three identical (toolName, input) calls in window', () => {
    it('returns no_stall on the first two calls', () => {
      const d = createStallDetector({ disabled: false });
      const r1 = d.recordToolUse('read', { path: 'a.ts' });
      const r2 = d.recordToolUse('read', { path: 'a.ts' });
      expect(r1.kind).toBe('no_stall');
      expect(r2.kind).toBe('no_stall');
    });

    it('fires stall on the third identical call', () => {
      const d = createStallDetector({ disabled: false });
      d.recordToolUse('read', { path: 'a.ts' });
      d.recordToolUse('read', { path: 'a.ts' });
      const r3 = d.recordToolUse('read', { path: 'a.ts' });
      expect(r3.kind).toBe('stall');
      if (r3.kind === 'stall') {
        expect(r3.toolName).toBe('read');
        expect(r3.occurrenceCount).toBe(3);
        expect(r3.cacheHitCount).toBe(0);
        expect(r3.turns).toEqual([1, 2, 3]);
        expect(r3.envelope).toContain('[Stall detector signal]');
        expect(r3.envelope).toContain('occurrence_count=3');
        expect(r3.envelope).toContain('turns=[1,2,3]');
      }
    });

    it('does not fire when 3 calls have different inputs', () => {
      const d = createStallDetector({ disabled: false });
      const r1 = d.recordToolUse('read', { path: 'a.ts' });
      const r2 = d.recordToolUse('read', { path: 'b.ts' });
      const r3 = d.recordToolUse('read', { path: 'c.ts' });
      expect(r1.kind).toBe('no_stall');
      expect(r2.kind).toBe('no_stall');
      expect(r3.kind).toBe('no_stall');
    });

    it('does not fire when 3 calls have same input but different tools', () => {
      const d = createStallDetector({ disabled: false });
      const r1 = d.recordToolUse('read', { path: 'a.ts' });
      const r2 = d.recordToolUse('grep', { path: 'a.ts' });
      const r3 = d.recordToolUse('glob', { path: 'a.ts' });
      expect(r3.kind).toBe('no_stall');
    });

    it('treats reordered keys in input as identical (stableStringify)', () => {
      const d = createStallDetector({ disabled: false });
      d.recordToolUse('read', { path: 'a.ts', offset: 1, limit: 2000 });
      d.recordToolUse('read', { offset: 1, limit: 2000, path: 'a.ts' });
      const r3 = d.recordToolUse('read', { limit: 2000, path: 'a.ts', offset: 1 });
      expect(r3.kind).toBe('stall');
    });
  });

  describe('Rule B: two identical calls AFTER a cache hit', () => {
    it('fires on the second call when first carried cacheHit=true', () => {
      const d = createStallDetector({ disabled: false });
      d.recordToolUse('read', { path: 'a.ts' }, true);
      const r2 = d.recordToolUse('read', { path: 'a.ts' });
      expect(r2.kind).toBe('stall');
      if (r2.kind === 'stall') {
        expect(r2.occurrenceCount).toBe(2);
        expect(r2.cacheHitCount).toBe(1);
        expect(r2.envelope).toContain('cache_hit_count=1');
      }
    });

    it('fires on the second call when second carries cacheHit=true', () => {
      const d = createStallDetector({ disabled: false });
      d.recordToolUse('read', { path: 'a.ts' });
      const r2 = d.recordToolUse('read', { path: 'a.ts' }, true);
      expect(r2.kind).toBe('stall');
    });

    it('does NOT fire on a single call even with cacheHit=true', () => {
      const d = createStallDetector({ disabled: false });
      const r1 = d.recordToolUse('read', { path: 'a.ts' }, true);
      expect(r1.kind).toBe('no_stall');
    });

    it('combines cache_hit_count correctly when multiple cache hits accrue', () => {
      const d = createStallDetector({ disabled: false });
      d.recordToolUse('read', { path: 'a.ts' }, true);
      const r2 = d.recordToolUse('read', { path: 'a.ts' }, true);
      expect(r2.kind).toBe('stall');
      if (r2.kind === 'stall') {
        expect(r2.cacheHitCount).toBe(2);
      }
    });
  });

  describe('Rule C: repeated repository-probe family without an evidence boundary', () => {
    it('fires after eight varied read/grep/glob probes even when inputs differ', () => {
      const d = createStallDetector({ disabled: false });
      const probes = [
        ['read', { path: 'a.ts' }],
        ['grep', { pattern: 'creator', path: 'src' }],
        ['glob', { pattern: '**/*.ts' }],
        ['read', { path: 'b.ts' }],
        ['grep', { pattern: 'worker', path: 'packages' }],
        ['read', { path: 'c.ts' }],
        ['glob', { pattern: '**/*runtime*' }],
        ['grep', { pattern: 'isolation', path: 'src' }],
      ] as const;
      for (const [name, input] of probes.slice(0, -1)) {
        expect(d.recordToolUse(name, input).kind).toBe('no_stall');
      }
      const signal = d.recordToolUse(probes[7]![0], probes[7]![1]);
      expect(signal.kind).toBe('stall');
      if (signal.kind === 'stall') {
        expect(signal.probeFamily).toBe('repository-inspection');
        expect(signal.occurrenceCount).toBe(8);
        expect(signal.envelope).toContain('probe_family=repository-inspection');
      }
    });

    it('treats a non-probe tool as a progress boundary for family counting', () => {
      const d = createStallDetector({ disabled: false });
      for (let i = 0; i < 7; i++) {
        d.recordToolUse('read', { path: `${i}.ts` });
      }
      d.recordToolUse('edit', { path: '0.ts', old_string: 'a', new_string: 'b' });
      for (let i = 0; i < 7; i++) {
        expect(d.recordToolUse('grep', { pattern: `p${i}` }).kind).toBe('no_stall');
      }
    });

    it('classifies read-only shell searches into the same probe family', () => {
      const d = createStallDetector({ disabled: false, probeFamilyThreshold: 3 });
      expect(d.recordToolUse('bash', { command: 'rg "creator" packages' }).kind).toBe('no_stall');
      expect(d.recordToolUse('bash', { command: 'git grep worker' }).kind).toBe('no_stall');
      const signal = d.recordToolUse('bash', { command: 'Get-ChildItem -Recurse | Select-String isolation' });
      expect(signal.kind).toBe('stall');
      if (signal.kind === 'stall') {
        expect(signal.probeFamily).toBe('repository-inspection');
      }
    });

    it('covers the complete repo-explorer and LSP probe surface', () => {
      const d = createStallDetector({ disabled: false, probeFamilyThreshold: 3 });
      expect(d.recordToolUse('repo_overview', {}).kind).toBe('no_stall');
      expect(d.recordToolUse('changed_diff_bundle', { paths: ['a.ts'] }).kind).toBe('no_stall');
      const signal = d.recordToolUse('lsp_definition', { path: 'a.ts', line: 1, character: 1 });
      expect(signal.kind).toBe('stall');
      if (signal.kind === 'stall') {
        expect(signal.probeFamily).toBe('repository-inspection');
      }
    });

    it('does not treat read-only git inventory commands as progress', () => {
      const d = createStallDetector({ disabled: false, probeFamilyThreshold: 3 });
      expect(d.recordToolUse('bash', { command: 'git ls-files packages' }).kind).toBe('no_stall');
      expect(d.recordToolUse('bash', { command: 'git branch --list' }).kind).toBe('no_stall');
      const signal = d.recordToolUse('bash', { command: 'git rev-parse HEAD' });
      expect(signal.kind).toBe('stall');
    });

    it('does not let plan/list rituals erase repository-probe progress', () => {
      const d = createStallDetector({ disabled: false, probeFamilyThreshold: 3 });
      expect(d.recordToolUse('read', { path: 'a.ts' }).kind).toBe('no_stall');
      expect(d.recordToolUse('todo_get', { id: 'todo-1' }).kind).toBe('no_stall');
      expect(d.recordToolUse('module_context', { path: 'packages/coding' }).kind).toBe('no_stall');
      expect(d.recordToolUse('list_agents', {}).kind).toBe('no_stall');
      const signal = d.recordToolUse('symbol_context', { symbol: 'runManagedTask' });
      expect(signal.kind).toBe('stall');
      if (signal.kind === 'stall') {
        expect(signal.probeFamily).toBe('repository-inspection');
      }
    });

    it('fires the semantic family at most once per progress epoch', () => {
      const d = createStallDetector({ disabled: false, probeFamilyThreshold: 3 });
      d.recordToolUse('read', { path: 'a.ts' });
      d.recordToolUse('read', { path: 'b.ts' });
      expect(d.recordToolUse('read', { path: 'c.ts' }).kind).toBe('stall');
      expect(d.recordToolUse('read', { path: 'd.ts' }).kind).toBe('no_stall');

      d.recordToolUse('edit', { path: 'a.ts', old_string: 'a', new_string: 'b' });
      d.recordToolUse('grep', { pattern: 'one' });
      d.recordToolUse('grep', { pattern: 'two' });
      expect(d.recordToolUse('grep', { pattern: 'three' }).kind).toBe('stall');
    });

    it('starts a new probe epoch after a multi_edit mutation', () => {
      const d = createStallDetector({ disabled: false, probeFamilyThreshold: 3 });
      d.recordToolUse('read', { path: 'a.ts' });
      d.recordToolUse('grep', { pattern: 'before' });
      d.recordToolUse('multi_edit', {
        path: 'a.ts',
        edits: [{ old_string: 'a', new_string: 'b' }],
      });
      expect(d.recordToolUse('read', { path: 'b.ts' }).kind).toBe('no_stall');
      expect(d.recordToolUse('grep', { pattern: 'after' }).kind).toBe('no_stall');
      expect(d.recordToolUse('lsp_hover', { path: 'b.ts', line: 1, character: 1 }).kind).toBe('stall');
    });
  });

  describe('Window scope', () => {
    it('drops the oldest event when window overflows', () => {
      const d = createStallDetector({ disabled: false, windowSize: 4 });
      d.recordToolUse('read', { path: 'a.ts' });
      // Fill window past the read event with unrelated tools.
      d.recordToolUse('grep', { pattern: 'x' });
      d.recordToolUse('grep', { pattern: 'y' });
      d.recordToolUse('grep', { pattern: 'z' });
      // 5th event pushes the read out. Next two reads see only the
      // 5th + 6th entries in the window — no stall.
      d.recordToolUse('grep', { pattern: 'w' }); // pushes read out
      const r6 = d.recordToolUse('read', { path: 'a.ts' });
      expect(r6.kind).toBe('no_stall');
    });

    it('still fires when 3 identical calls fit inside a small window', () => {
      const d = createStallDetector({ disabled: false, windowSize: 4 });
      d.recordToolUse('read', { path: 'a.ts' });
      d.recordToolUse('read', { path: 'a.ts' });
      const r3 = d.recordToolUse('read', { path: 'a.ts' });
      expect(r3.kind).toBe('stall');
    });
  });

  describe('reset()', () => {
    it('drops all state — no stall after reset', () => {
      const d = createStallDetector({ disabled: false });
      d.recordToolUse('read', { path: 'a.ts' });
      d.recordToolUse('read', { path: 'a.ts' });
      d.reset();
      const r1 = d.recordToolUse('read', { path: 'a.ts' });
      const r2 = d.recordToolUse('read', { path: 'a.ts' });
      expect(r1.kind).toBe('no_stall');
      expect(r2.kind).toBe('no_stall');
      const r3 = d.recordToolUse('read', { path: 'a.ts' });
      expect(r3.kind).toBe('stall');
      if (r3.kind === 'stall') {
        // Turn counter resets — turns start at 1 again, not 4.
        expect(r3.turns).toEqual([1, 2, 3]);
      }
    });

    it('size() reflects current window occupancy', () => {
      const d = createStallDetector({ disabled: false });
      expect(d.size()).toBe(0);
      d.recordToolUse('read', { path: 'a.ts' });
      d.recordToolUse('read', { path: 'b.ts' });
      expect(d.size()).toBe(2);
      d.reset();
      expect(d.size()).toBe(0);
    });
  });

  describe('Killswitch (KODAX_STALL_DETECT=0)', () => {
    const originalEnv = process.env.KODAX_STALL_DETECT;

    beforeEach(() => {
      delete process.env.KODAX_STALL_DETECT;
    });

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.KODAX_STALL_DETECT;
      } else {
        process.env.KODAX_STALL_DETECT = originalEnv;
      }
    });

    it('disables the detector entirely when env var is exactly "0"', () => {
      process.env.KODAX_STALL_DETECT = '0';
      const d = createStallDetector();
      d.recordToolUse('read', { path: 'a.ts' });
      d.recordToolUse('read', { path: 'a.ts' });
      const r3 = d.recordToolUse('read', { path: 'a.ts' });
      // No-op shim — never fires.
      expect(r3.kind).toBe('no_stall');
      expect(d.size()).toBe(0);
    });

    it('enables the detector when env var is unset', () => {
      const d = createStallDetector();
      d.recordToolUse('read', { path: 'a.ts' });
      d.recordToolUse('read', { path: 'a.ts' });
      const r3 = d.recordToolUse('read', { path: 'a.ts' });
      expect(r3.kind).toBe('stall');
    });

    it('enables the detector when env var is set to a non-"0" value', () => {
      // Avoid the trap where "false" or "off" silently disables — we
      // pin the disable token to exactly the string "0" so the rollback
      // hatch is unambiguous.
      process.env.KODAX_STALL_DETECT = 'false';
      const d = createStallDetector();
      d.recordToolUse('read', { path: 'a.ts' });
      d.recordToolUse('read', { path: 'a.ts' });
      const r3 = d.recordToolUse('read', { path: 'a.ts' });
      expect(r3.kind).toBe('stall');
    });

    it('respects explicit options.disabled override of env var', () => {
      process.env.KODAX_STALL_DETECT = '1';
      const d = createStallDetector({ disabled: true });
      d.recordToolUse('read', { path: 'a.ts' });
      d.recordToolUse('read', { path: 'a.ts' });
      const r3 = d.recordToolUse('read', { path: 'a.ts' });
      expect(r3.kind).toBe('no_stall');
    });
  });

  describe('eval-contract envelope shape', () => {
    it('produces an envelope semantically equivalent to the F178 cases.ts P1 fixture', () => {
      // P1_CASE.signalEnvelope from benchmark/datasets/feature-178-stall-sidecar/cases.ts:
      //   '[Stall detector signal]\n'
      //   + 'tool=read input={"path":"C:/proj/index.html","offset":1,"limit":2000} '
      //   + 'occurrence_count=3 cache_hit_count=2 turns=[12,13,14]'
      //
      // Production stableStringify sorts JSON keys for hash stability, so
      // the envelope's input field renders keys in alphabetical order
      // (limit/offset/path) rather than the eval fixture's hand-authored
      // order (path/offset/limit). The LLM is JSON-key-order-invariant,
      // so this is semantically equivalent. Assert the structural pieces.
      //
      // We simulate prefix turns 1..11 with unrelated calls so the
      // matching reads land on turns 12, 13, 14.
      const d = createStallDetector({ disabled: false });
      for (let i = 0; i < 11; i++) {
        d.recordToolUse('noop', { i });
      }
      d.recordToolUse(
        'read',
        { path: 'C:/proj/index.html', offset: 1, limit: 2000 },
      );
      d.recordToolUse(
        'read',
        { path: 'C:/proj/index.html', offset: 1, limit: 2000 },
        true,
      );
      const r = d.recordToolUse(
        'read',
        { path: 'C:/proj/index.html', offset: 1, limit: 2000 },
        true,
      );
      expect(r.kind).toBe('stall');
      if (r.kind === 'stall') {
        // Header line — pinned verbatim.
        expect(r.envelope.startsWith('[Stall detector signal]\n')).toBe(true);
        // Tool, counts, turns — pinned verbatim.
        expect(r.envelope).toContain('tool=read');
        expect(r.envelope).toContain('occurrence_count=3');
        expect(r.envelope).toContain('cache_hit_count=2');
        expect(r.envelope).toContain('turns=[12,13,14]');
        // Input — pin the set of (key, value) pairs, not the order.
        // stableStringify produces sorted-key form.
        expect(r.envelope).toContain(
          'input={"limit":2000,"offset":1,"path":"C:/proj/index.html"}',
        );
      }
    });
  });
});
