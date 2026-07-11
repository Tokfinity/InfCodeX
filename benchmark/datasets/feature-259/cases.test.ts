import { createHash } from 'node:crypto';

import {
  BASELINE_RUN_WORKFLOW_DESCRIPTION,
  buildBaselineGenerationPrompt,
  buildBaselineWorkerPrompt,
  buildFeature259Layer2Cases,
  buildProposedWorkerPrompt,
  FEATURE_259_LAYER_3_CASES,
  PROPOSED_RUN_WORKFLOW_DESCRIPTION,
} from './cases.js';

describe('FEATURE_259 executable eval cases', () => {
  const frozenBaselineVariantHashes = [
    '70648230afc0955f995e1c8a18043c05b43c9ffade2e4658f39bc5ee0f4e25c3',
    '05d2839251ca90075d37c834e935d2441de6468e7fca0d80345239871a725c24',
    '4f6b6878ce7b700d6a493f3271d37b1a064af0b693f207477f9a1c8a8110fe37',
    '859f2c9bdfaee4e45d99408680338815ee4480216f596161603295d62b432403',
    '5fe853cd23b32632e701e734ee22c0503616a083721f0460705a02f9dfb3da45',
    '294bd07b0b23fad69db456bd138d0309435fb43ce48281cd370963b54ca9a3ae',
  ];

  it('reconstructs the frozen baseline without proposed-only authoring rules', () => {
    const baseline = buildBaselineGenerationPrompt('test request');
    expect(baseline).not.toContain('Every generated wf.runAgent');
    expect(baseline).not.toContain('terseResult');
    expect(baseline).not.toContain('wf.workflow(name, args)');
    expect(buildBaselineWorkerPrompt()).toContain('MODEL HINT (FEATURE_259)');
    expect(buildProposedWorkerPrompt()).not.toContain('MODEL HINT (FEATURE_259)');
  });

  it('uses production workflow description bytes and the real deferred hint', () => {
    expect(BASELINE_RUN_WORKFLOW_DESCRIPTION).toContain('wf.pipeline');
    expect(PROPOSED_RUN_WORKFLOW_DESCRIPTION).toContain('tool_search');
    expect(Buffer.byteLength(PROPOSED_RUN_WORKFLOW_DESCRIPTION, 'utf8'))
      .toBeLessThan(Buffer.byteLength(BASELINE_RUN_WORKFLOW_DESCRIPTION, 'utf8'));
  });

  it('keeps every pre-iteration baseline variant byte-exact', () => {
    const cases = buildFeature259Layer2Cases();
    const hashes = cases.map((item) => {
      const baseline = item.variants.find((variant) => variant.id === 'baseline');
      return createHash('sha256').update(JSON.stringify(baseline), 'utf8').digest('hex');
    });
    expect(hashes).toEqual(frozenBaselineVariantHashes);
  });

  it('freezes six Layer-2 cases and eight Layer-3 oracle fixtures', () => {
    expect(buildFeature259Layer2Cases().map((item) => item.id)).toHaveLength(6);
    expect(FEATURE_259_LAYER_3_CASES).toHaveLength(8);
    expect(FEATURE_259_LAYER_3_CASES.filter((item) => item.standardReview)).toHaveLength(5);
    expect(FEATURE_259_LAYER_3_CASES.find((item) => item.id === 'shared-state')?.areas).toHaveLength(3);
  });

  it('accepts focused briefing through the production scoped-review workflow', () => {
    const focused = buildFeature259Layer2Cases().find((item) => item.id === 'focused-briefing');
    const output = JSON.stringify({
      action: 'generate',
      source: 'async function run(wf, args) { return wf.workflow("scoped-review", args); }',
    });
    expect(focused?.judges[0]?.judge(output).passed).toBe(true);
  });
});
