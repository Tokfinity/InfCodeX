import { describe, expect, it } from 'vitest';

import { buildManualToolDescription, withManualToolBranding } from './tool-description.js';

// The exact default description — a byte-identity pin so the single-source-of-
// truth builder can never silently drift the model-visible tool surface.
const KODAX_DESCRIPTION = [
  'Look up how to use, install, configure, troubleshoot, or extend KodaX itself.',
  'Covers providers, custom providers, config, permissions, slash commands, tools, custom agents, skills, extensions, MCP, repo intelligence, sessions, the doctor command, and the SDK.',
  'Call this first for any "how do I … in KodaX" question and answer from its result.',
  'Do not answer KodaX product questions from pretraining, because pretraining mixes in Claude Code and Codex CLI details that do not match KodaX — KodaX uses ~/.kodax/config.json and KODAX_* env vars, not .claude/settings.json or config.toml.',
  'Pass an exact topic id, or a free-text query, or neither to get the topic index. It explains where to check a value rather than reading your secrets.',
].join('\n');

describe('FEATURE_221 buildManualToolDescription (white-label tool description)', () => {
  it('default (KodaX) is byte-identical to the prior static literal', () => {
    expect(buildManualToolDescription()).toBe(KODAX_DESCRIPTION);
    expect(buildManualToolDescription('KodaX')).toBe(KODAX_DESCRIPTION);
  });

  it('re-brands the product name and drops the ~/.kodax config-path leak for a consumer', () => {
    const d = buildManualToolDescription('KodaX-Space');
    expect(d).toContain('extend KodaX-Space itself');
    expect(d).toContain('do not match KodaX-Space.');
    expect(d).not.toContain('~/.kodax');
    expect(d).not.toContain('KODAX_');
    // Anti-confusion framing (Claude Code / Codex) is still present.
    expect(d).toContain('Claude Code and Codex CLI');
  });

  it('trims / defaults an empty product name to KodaX', () => {
    expect(buildManualToolDescription('  ')).toBe(KODAX_DESCRIPTION);
  });
});

describe('FEATURE_221 withManualToolBranding', () => {
  const manualDef = { name: 'kodax_manual', description: KODAX_DESCRIPTION };
  const otherDef = { name: 'read', description: 'Read a file.' };

  it('re-brands only the kodax_manual def, only for a non-default product name', () => {
    const branded = withManualToolBranding(manualDef, 'KodaX-Space');
    expect(branded.description).toContain('KodaX-Space');
    expect(branded.description).not.toContain('~/.kodax');
  });

  it('returns the def UNCHANGED (same reference) for the default / absent product name', () => {
    expect(withManualToolBranding(manualDef, undefined)).toBe(manualDef);
    expect(withManualToolBranding(manualDef, 'KodaX')).toBe(manualDef);
    expect(withManualToolBranding(manualDef, '  ')).toBe(manualDef);
  });

  it('never touches a non-manual tool', () => {
    expect(withManualToolBranding(otherDef, 'KodaX-Space')).toBe(otherDef);
  });
});
