import { describe, expect, it } from 'vitest';
import { parseClassifierOutput } from './parse-output.js';

describe('parseClassifierOutput', () => {
  it('parses a structured allow decision with no hazard', () => {
    expect(parseClassifierOutput(
      '<decision>allow</decision><hazard>none</hazard><reason>deterministic read</reason>',
    )).toEqual({
      kind: 'allow', reason: 'deterministic read', hazard: 'none', protocol: 'structured_v2',
    });
  });

  it.each([
    '```xml\n<decision>allow</decision><hazard>none</hazard><reason>safe read</reason>\n```',
    '```\n<block>no</block><reason>safe read</reason>\n```',
  ])('accepts one exclusive Markdown fence around an otherwise exact contract', (raw) => {
    expect(parseClassifierOutput(raw)).toMatchObject({ kind: 'allow', reason: 'safe read' });
  });

  it.each([
    'prefix\n```xml\n<decision>allow</decision><hazard>none</hazard><reason>safe</reason>\n```',
    '```xml\n<decision>allow</decision><hazard>none</hazard><reason>safe</reason>\n```\nsuffix',
    '```xml\n<decision>allow</decision><hazard>none</hazard><reason>safe</reason>\n```\n```xml\n<decision>ask</decision><hazard>intent_conflict</hazard><reason>unsafe</reason>\n```',
  ])('rejects prose or multiple envelopes outside a Markdown fence', (raw) => {
    expect(parseClassifierOutput(raw).kind).toBe('unparseable');
  });

  it('accepts an allow reason that explicitly says confirmation is unnecessary', () => {
    expect(parseClassifierOutput(
      '<decision>allow</decision><hazard>none</hazard><reason>This does not require user confirmation.</reason>',
    )).toMatchObject({ kind: 'allow', hazard: 'none' });
  });

  it('parses a structured ask only when it names a concrete hazard', () => {
    expect(parseClassifierOutput(
      '<decision>ask</decision><hazard>protected_read</hazard><reason>reads an SSH key</reason>',
    )).toEqual({
      kind: 'block', reason: 'reads an SSH key', hazard: 'protected_read',
      protocol: 'structured_v2',
    });
  });

  it('allows a literal greater-than sign in a structured reason', () => {
    expect(parseClassifierOutput(
      '<decision>ask</decision><hazard>outside_write</hazard>'
      + '<reason>2>file writes outside the workspace</reason>',
    )).toMatchObject({
      kind: 'block',
      reason: '2>file writes outside the workspace',
      protocol: 'structured_v2',
    });
  });

  it.each([
    '<decision>ask</decision><hazard>none</hazard><reason>blocking is unnecessary</reason>',
    '<decision>ask</decision><hazard>intent_conflict</hazard><reason>blocking this action is unnecessary</reason>',
    '<decision>ask</decision><hazard>intent_conflict</hazard><reason>This action is safe and harmless; confirmation is merely prudent.</reason>',
    '<decision>ask</decision><hazard>intent_conflict</hazard><reason>There is no risk, but ask the user.</reason>',
    '<decision>allow</decision><hazard>protected_read</hazard><reason>reads an SSH key</reason>',
    '<decision>allow</decision><hazard>none</hazard><reason>This operation requires user confirmation.</reason>',
    '<decision>allow</decision><hazard>none</hazard><reason>Ask the user first.</reason>',
    '<decision>allow</decision><hazard>none</hazard><reason>Await user approval.</reason>',
    '<decision>allow</decision><hazard>none</hazard><reason>Confirm before proceeding.</reason>',
    '<decision>allow</decision><hazard>none</hazard><reason>Permission should be requested.</reason>',
    '<decision>allow</decision><hazard>none</hazard><reason>This is dangerous.</reason>',
    '<decision>allow</decision><hazard>none</hazard><reason>This could be dangerous.</reason>',
    '<decision>allow</decision><hazard>none</hazard><reason>This operation may expose credentials.</reason>',
    '<decision>allow</decision><hazard>none</hazard><reason>This operation could delete data.</reason>',
    '<decision>allow</decision><hazard>none</hazard><reason>This may cause data loss.</reason>',
    '<decision>allow</decision><hazard>none</hazard><reason>This can send secrets to a remote server.</reason>',
    '<decision>allow</decision><hazard>none</hazard><reason>This is potentially risky.</reason>',
    '<decision>allow</decision><hazard>none</hazard><reason>This may erase files.</reason>',
    '<decision>allow</decision><hazard>none</hazard><reason>This can remove data.</reason>',
    '<decision>allow</decision><hazard>none</hazard><reason>This might wipe files.</reason>',
    '<decision>allow</decision><hazard>none</hazard><reason>This could corrupt data.</reason>',
    '<decision>allow</decision><hazard>none</hazard><reason>This may reveal tokens.</reason>',
    '<decision>allow</decision><hazard>none</hazard><reason>This could publish credentials.</reason>',
    '<decision>allow</decision><hazard>none</hazard><reason>This is potentially harmful.</reason>',
    '<decision>allow</decision><hazard>none</hazard><reason>This might overwrite the configuration.</reason>',
    '<decision>allow</decision><hazard>none</hazard><reason>This could delete the repository.</reason>',
    '<decision>allow</decision><hazard>none</hazard><reason>Wait for user approval.</reason>',
    '<decision>allow</decision><hazard>none</hazard><reason>Confirmation is recommended.</reason>',
    '<decision>ask</decision><hazard>intent_conflict</hazard><reason>No approval is needed.</reason>',
    '<decision>ask</decision><hazard>intent_conflict</hazard><reason>Proceed without user confirmation.</reason>',
  ])('rejects inconsistent structured output: %s', (raw) => {
    expect(parseClassifierOutput(raw).kind).toBe('unparseable');
  });

  it('parses a clean block=yes with reason', () => {
    const r = parseClassifierOutput('<block>yes</block><reason>command exfiltrates ssh key</reason>');
    expect(r.kind).toBe('block');
    if (r.kind === 'block') expect(r.reason).toBe('command exfiltrates ssh key');
  });

  it('parses a clean block=no with reason', () => {
    const r = parseClassifierOutput('<block>no</block><reason>safe local read</reason>');
    expect(r.kind).toBe('allow');
    if (r.kind === 'allow') expect(r.reason).toBe('safe local read');
  });

  it('allows a literal greater-than sign in a legacy reason', () => {
    expect(parseClassifierOutput(
      '<block>yes</block><reason>2>file writes outside the workspace</reason>',
    )).toMatchObject({
      kind: 'block',
      reason: '2>file writes outside the workspace',
      protocol: 'legacy_v1',
    });
  });

  it('parses block=no with empty reason', () => {
    const r = parseClassifierOutput('<block>no</block><reason></reason>');
    expect(r.kind).toBe('allow');
  });

  it.each([
    '<block>no</block><reason>This operation requires user confirmation.</reason>',
    '<block>no</block><reason>Ask the user first.</reason>',
    '<block>no</block><reason>Await user approval.</reason>',
    '<block>no</block><reason>Confirm before proceeding.</reason>',
    '<block>no</block><reason>Permission should be requested.</reason>',
    '<block>no</block><reason>This is dangerous.</reason>',
    '<block>no</block><reason>This could be dangerous.</reason>',
    '<block>no</block><reason>This operation may expose credentials.</reason>',
    '<block>no</block><reason>This operation could delete data.</reason>',
    '<block>no</block><reason>This may cause data loss.</reason>',
    '<block>no</block><reason>This can send secrets to a remote server.</reason>',
    '<block>no</block><reason>This is potentially risky.</reason>',
    '<block>no</block><reason>This may erase files.</reason>',
    '<block>no</block><reason>This can remove data.</reason>',
    '<block>no</block><reason>This might wipe files.</reason>',
    '<block>no</block><reason>This could corrupt data.</reason>',
    '<block>no</block><reason>This may reveal tokens.</reason>',
    '<block>no</block><reason>This could publish credentials.</reason>',
    '<block>no</block><reason>This is potentially harmful.</reason>',
    '<block>no</block><reason>This might overwrite the configuration.</reason>',
    '<block>no</block><reason>This could delete the repository.</reason>',
    '<block>no</block><reason>Wait for user approval.</reason>',
    '<block>no</block><reason>Confirmation is recommended.</reason>',
    '<block>yes</block><reason>This action is safe; there is no hazard.</reason>',
    '<block>yes</block><reason>No approval is needed.</reason>',
  ])('rejects a self-contradictory legacy decision: %s', (raw) => {
    expect(parseClassifierOutput(raw)).toMatchObject({
      kind: 'unparseable',
      failureCode: 'decision_hazard_conflict',
      observedProtocol: 'legacy_v1',
    });
  });

  it.each([
    'This does not require user confirmation.',
    "This doesn't need approval.",
    'User confirmation is not required.',
    'This action should not be blocked.',
  ])('accepts a structured allow with a genuinely negative confirmation claim: %s', (reason) => {
    expect(parseClassifierOutput(
      `<decision>allow</decision><hazard>none</hazard><reason>${reason}</reason>`,
    )).toMatchObject({ kind: 'allow', hazard: 'none' });
  });

  it('still rejects a mixed safe claim followed by a confirmation requirement', () => {
    expect(parseClassifierOutput(
      '<decision>allow</decision><hazard>none</hazard>'
      + '<reason>No confirmation is needed for the read, but wait for user approval.</reason>',
    ).kind).toBe('unparseable');
  });

  it('parses an exact legacy allow without a reason', () => {
    expect(parseClassifierOutput('<block>no</block>')).toMatchObject({
      kind: 'allow',
      reason: '',
      protocol: 'legacy_v1',
    });
  });

  it('tolerates whitespace inside tags', () => {
    const r = parseClassifierOutput('<block>  yes  </block><reason>  trim me  </reason>');
    expect(r.kind).toBe('block');
    if (r.kind === 'block') expect(r.reason).toBe('trim me');
  });

  it('rejects prose surrounding a legacy decision', () => {
    const r = parseClassifierOutput('   Sure! <block>no</block><reason>ok</reason>  trailing  ');
    expect(r).toMatchObject({
      kind: 'unparseable',
      failureCode: 'legacy_format_violation',
      observedProtocol: 'legacy_v1',
    });
  });

  it('is case-insensitive on yes/no', () => {
    const r1 = parseClassifierOutput('<block>YES</block><reason>x</reason>');
    expect(r1.kind).toBe('block');
    const r2 = parseClassifierOutput('<block>No</block><reason>x</reason>');
    expect(r2.kind).toBe('allow');
  });

  it('returns unparseable when block tag is missing (fail-closed)', () => {
    const r = parseClassifierOutput('looks safe to me');
    expect(r.kind).toBe('unparseable');
    if (r.kind === 'unparseable') {
      expect(r.raw).toBe('looks safe to me');
      expect(r.failureCode).toBe('missing_decision');
      expect(r.observedProtocol).toBe('unknown');
    }
  });

  it('labels a valid legacy decision during the dual-read rollout', () => {
    expect(parseClassifierOutput(
      '<block>no</block><reason>ordinary read</reason>',
    )).toMatchObject({ kind: 'allow', protocol: 'legacy_v1' });
  });

  it('returns unparseable when block value is neither yes nor no', () => {
    const r = parseClassifierOutput('<block>maybe</block><reason>unsure</reason>');
    expect(r.kind).toBe('unparseable');
  });

  it('treats a blocking decision without a reason as a contract failure', () => {
    const r = parseClassifierOutput('<block>yes</block>');
    expect(r.kind).toBe('unparseable');
  });

  it('treats an empty blocking reason as a contract failure', () => {
    const r = parseClassifierOutput('<block>yes</block><reason></reason>');
    expect(r.kind).toBe('unparseable');
  });

  it('truncates excessively long reasons to a sane upper bound', () => {
    const longReason = 'x'.repeat(2000);
    const r = parseClassifierOutput(`<block>yes</block><reason>${longReason}</reason>`);
    expect(r.kind).toBe('block');
    if (r.kind === 'block') {
      expect(r.reason.length).toBeLessThanOrEqual(500);
      expect(r.reason.endsWith('…')).toBe(true);
    }
  });

  it('rejects multiple legacy decisions instead of taking the first', () => {
    const r = parseClassifierOutput('<block>yes</block><reason>real</reason><block>no</block>');
    expect(r.kind).toBe('unparseable');
  });

  it('rejects a legacy decision nested inside the reason', () => {
    expect(parseClassifierOutput(
      '<block>no</block><reason>safe <block>yes</block></reason>',
    )).toMatchObject({
      kind: 'unparseable',
      failureCode: 'legacy_format_violation',
      observedProtocol: 'legacy_v1',
    });
  });

  it.each([
    'I refuse. <decision>allow</decision><hazard>none</hazard><reason>safe</reason>',
    '<decision>allow</decision><hazard>none</hazard><reason>safe</reason>'
      + '<decision>ask</decision><hazard>intent_conflict</hazard><reason>unsafe</reason>',
    '<decision>allow</decision><hazard>none</hazard><reason>safe</reason>'
      + '<block>yes</block><reason>unsafe</reason>',
  ])('rejects non-exclusive structured output: %s', (raw) => {
    expect(parseClassifierOutput(raw)).toMatchObject({
      kind: 'unparseable',
      failureCode: 'structured_format_violation',
      observedProtocol: 'structured_v2',
    });
  });

  it('does not downgrade malformed structured output to a legacy allow', () => {
    const r = parseClassifierOutput(
      '<decision>ask<block>no</block><reason>dangerous</reason>',
    );

    expect(r).toMatchObject({
      kind: 'unparseable',
      observedProtocol: 'structured_v2',
    });
  });
});
