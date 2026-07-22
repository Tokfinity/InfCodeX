import {
  FEATURE_259_LAYER_2_BASELINE_VARIANT_HASHES,
  FEATURE_259_LAYER_2_CASES,
  FEATURE_259_LAYER_3_FIXTURES,
} from './experiment-contract.js';
import {
  buildFeature259Layer2Cases,
  FEATURE_259_LAYER_3_CASES,
} from './cases.js';

// Layer-2 reconstructs a retired production prompt for historical result
// analysis. Layer-3 fixtures remain reusable and have a stable frozen manifest.
describe('FEATURE_259 historical eval dataset', () => {
  it('preserves the retired Layer-2 case and baseline-hash evidence', () => {
    expect(FEATURE_259_LAYER_2_CASES).toHaveLength(6);
    expect(FEATURE_259_LAYER_2_BASELINE_VARIANT_HASHES).toEqual([
      '70648230afc0955f995e1c8a18043c05b43c9ffade2e4658f39bc5ee0f4e25c3',
      '05672311509067d291c841bfeb83614c44334d0a4f58bbbf1db113eed536a856',
      'f6f67322cff442efdb0d8be2e36ba09bd4007349b2c7ecc196553d470cd4bd02',
      '67004382d89b94002a7af56a2d234956eb0058ff801c9d592512b2aab8f911e2',
      '3a6da5a5e3b37d4b179f7ead99fddbfcb94393cc2b5ce66a3c849a9d7cb94480',
      '332503788509e122d6521d4bda964b0a51a461a093ec9421f62d22863ee1eb73',
    ]);
    expect(() => buildFeature259Layer2Cases()).toThrow(
      'FEATURE_259 Layer-2 generation was retired by FEATURE_270',
    );
  });

  it('keeps reusable Layer-3 fixtures aligned with the frozen experiment manifest', () => {
    const fixtures = FEATURE_259_LAYER_3_CASES.map((item) => ({
      id: item.id,
      severity: item.expectedSeverity ?? null,
      disposition: item.expectedDisposition,
      layout: item.areas.length > 1 ? 'two-plus-cross' : 'one',
      risk: item.risk,
      standardReview: item.standardReview,
    }));

    expect(fixtures).toEqual(FEATURE_259_LAYER_3_FIXTURES);
  });
});
