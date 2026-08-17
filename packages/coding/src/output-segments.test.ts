import { describe, expect, it } from 'vitest';

import {
  createOutputSegmentProjection,
  effectiveOutputSegmentText,
  reduceOutputSegmentProjection,
} from './output-segments.js';

describe('provider output segment projection', () => {
  it('replaces only the active failed request while retaining prior appended output', () => {
    let state = createOutputSegmentProjection();
    state = reduceOutputSegmentProjection(state, {
      type: 'segment.started',
      responseId: 'response-1',
      providerRequestId: 'request-1',
      mode: 'append',
    }).state;
    state = reduceOutputSegmentProjection(state, {
      type: 'assistant.delta',
      providerRequestId: 'request-1',
      text: 'stable ',
    }).state;
    state = reduceOutputSegmentProjection(state, {
      type: 'segment.started',
      responseId: 'response-1',
      providerRequestId: 'request-2',
      mode: 'append',
    }).state;
    state = reduceOutputSegmentProjection(state, {
      type: 'assistant.delta',
      providerRequestId: 'request-2',
      text: 'abandoned',
    }).state;
    state = reduceOutputSegmentProjection(state, {
      type: 'segment.started',
      responseId: 'response-1',
      providerRequestId: 'request-3',
      mode: 'replace',
    }).state;
    state = reduceOutputSegmentProjection(state, {
      type: 'assistant.delta',
      providerRequestId: 'request-3',
      text: 'replacement',
    }).state;

    expect(effectiveOutputSegmentText(state, 'assistant')).toBe('stable replacement');
  });

  it('appends max-token continuation output and rejects stale deltas', () => {
    let state = createOutputSegmentProjection();
    state = reduceOutputSegmentProjection(state, {
      type: 'segment.started',
      responseId: 'response-1',
      providerRequestId: 'request-1',
      mode: 'append',
    }).state;
    state = reduceOutputSegmentProjection(state, {
      type: 'assistant.delta',
      providerRequestId: 'request-1',
      text: 'P1',
    }).state;
    state = reduceOutputSegmentProjection(state, {
      type: 'segment.started',
      responseId: 'response-1',
      providerRequestId: 'request-2',
      mode: 'append',
    }).state;
    const stale = reduceOutputSegmentProjection(state, {
      type: 'assistant.delta',
      providerRequestId: 'request-1',
      text: 'late',
    });
    state = reduceOutputSegmentProjection(stale.state, {
      type: 'assistant.delta',
      providerRequestId: 'request-2',
      text: 'P2',
    }).state;

    expect(stale.accepted).toBe(false);
    expect(effectiveOutputSegmentText(state, 'assistant')).toBe('P1P2');
  });

  it('tracks thinking and assistant content under the same request identity', () => {
    let state = createOutputSegmentProjection();
    state = reduceOutputSegmentProjection(state, {
      type: 'segment.started',
      responseId: 'response-1',
      providerRequestId: 'request-1',
      mode: 'append',
    }).state;
    state = reduceOutputSegmentProjection(state, {
      type: 'thinking.delta',
      providerRequestId: 'request-1',
      text: 'reasoning',
    }).state;
    state = reduceOutputSegmentProjection(state, {
      type: 'assistant.delta',
      providerRequestId: 'request-1',
      text: 'answer',
    }).state;

    expect(effectiveOutputSegmentText(state, 'thinking')).toBe('reasoning');
    expect(effectiveOutputSegmentText(state, 'assistant')).toBe('answer');
  });

  it('uses response identity as the logical reply boundary', () => {
    let state = createOutputSegmentProjection();
    state = reduceOutputSegmentProjection(state, {
      type: 'segment.started',
      responseId: 'response-1',
      providerRequestId: 'request-1',
      mode: 'append',
    }).state;
    state = reduceOutputSegmentProjection(state, {
      type: 'assistant.delta',
      providerRequestId: 'request-1',
      text: 'old ',
    }).state;
    state = reduceOutputSegmentProjection(state, {
      type: 'segment.started',
      responseId: 'response-1',
      providerRequestId: 'request-1b',
      mode: 'append',
    }).state;
    state = reduceOutputSegmentProjection(state, {
      type: 'assistant.delta',
      providerRequestId: 'request-1b',
      text: 'response',
    }).state;
    state = reduceOutputSegmentProjection(state, {
      type: 'segment.started',
      responseId: 'response-2',
      providerRequestId: 'request-2',
      mode: 'replace',
    }).state;
    state = reduceOutputSegmentProjection(state, {
      type: 'assistant.delta',
      providerRequestId: 'request-2',
      text: 'new response',
    }).state;

    expect(effectiveOutputSegmentText(state, 'assistant')).toBe('new response');
  });

  it('treats a repeated start for the same physical request as idempotent', () => {
    let state = createOutputSegmentProjection();
    const started = {
      type: 'segment.started' as const,
      responseId: 'response-1',
      providerRequestId: 'request-1',
      mode: 'append' as const,
    };
    state = reduceOutputSegmentProjection(state, started).state;
    state = reduceOutputSegmentProjection(state, {
      type: 'assistant.delta',
      providerRequestId: 'request-1',
      text: 'once',
    }).state;
    const duplicate = reduceOutputSegmentProjection(state, started);

    expect(duplicate.accepted).toBe(true);
    expect(duplicate.state).toBe(state);
    expect(effectiveOutputSegmentText(duplicate.state, 'assistant')).toBe('once');
  });
});
