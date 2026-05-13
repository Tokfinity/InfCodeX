/**
 * FEATURE_121 (v0.7.40) acceptance criterion #8 — layer independence.
 *
 * `@kodax-ai/agent` MUST NOT depend on `@kodax-ai/coding` (ADR-021).
 * This test enforces that invariant at the package.json and source-import
 * level so an accidental import slip in idle-yield / runner-with-idle-yield
 * fails the build.
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const AGENT_ROOT = path.resolve(__dirname, '../..');

describe('FEATURE_121 — agent package layer independence', () => {
  it('package.json does not depend on @kodax-ai/coding', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(AGENT_ROOT, 'package.json'), 'utf-8'),
    );
    const deps = { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.devDependencies };
    expect(deps['@kodax-ai/coding']).toBeUndefined();
  });

  it('orchestration/idle-yield.ts does not import @kodax-ai/coding symbols', () => {
    const source = fs.readFileSync(
      path.join(AGENT_ROOT, 'src/orchestration/idle-yield.ts'),
      'utf-8',
    );
    // Strip comments before checking imports — JSDoc and inline comments
    // may legitimately mention coding-layer concepts.
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(stripped).not.toMatch(/from\s+['"]@kodax-ai\/coding/);
    expect(stripped).not.toContain('KodaXToolExecutionContext');
    expect(stripped).not.toContain('applyToolResultGuardrail');
  });

  it('orchestration/runner-with-idle-yield.ts does not import @kodax-ai/coding symbols', () => {
    const source = fs.readFileSync(
      path.join(AGENT_ROOT, 'src/orchestration/runner-with-idle-yield.ts'),
      'utf-8',
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(stripped).not.toMatch(/from\s+['"]@kodax-ai\/coding/);
    expect(stripped).not.toContain('KodaXToolExecutionContext');
    expect(stripped).not.toContain('applyToolResultGuardrail');
  });

  it('EnvelopeAggregateEnforcer signature uses only string[] (no coding types)', () => {
    const source = fs.readFileSync(
      path.join(AGENT_ROOT, 'src/orchestration/idle-yield.ts'),
      'utf-8',
    );
    // The type signature should be a pure string-array transform.
    expect(source).toMatch(/export type EnvelopeAggregateEnforcer = \(/);
    // Strip comments before checking absence — comments may reference these names.
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(stripped).not.toContain('KodaXToolExecutionContext');
    expect(stripped).not.toContain('GuardedToolResult');
  });
});
