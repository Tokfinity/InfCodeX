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
