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
    '05672311509067d291c841bfeb83614c44334d0a4f58bbbf1db113eed536a856',
    'f6f67322cff442efdb0d8be2e36ba09bd4007349b2c7ecc196553d470cd4bd02',
    '67004382d89b94002a7af56a2d234956eb0058ff801c9d592512b2aab8f911e2',
    '3a6da5a5e3b37d4b179f7ead99fddbfcb94393cc2b5ce66a3c849a9d7cb94480',
    '332503788509e122d6521d4bda964b0a51a461a093ec9421f62d22863ee1eb73',
  ];

  it('reconstructs the frozen baseline without proposed-only authoring rules', () => {
    const baseline = buildBaselineGenerationPrompt('test request');
    expect(baseline).not.toContain('Every generated wf.runAgent');
    expect(baseline).not.toContain('terseResult');
    expect(baseline).not.toContain('wf.workflow(name, args)');
    expect(baseline).not.toContain('scopeSummary');
    expect(baseline).not.toContain('constraints');
    expect(baseline).not.toContain('schema: true');
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
