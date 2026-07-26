import { describe, expect, it } from 'vitest';

import type { KodaXMessage } from '@kodax-ai/llm';
import type { PatternTrace } from '../../../orchestration/pattern-trace.js';

import {
  buildVerifierContext,
  extractCurrentTurnUserQueries,
} from './verifier-context-builder.js';
import {
  buildVerifierUserMessage,
  VERIFIER_SYSTEM_PROMPT,
} from './verifier-prompts.js';

describe('Sidecar Verifier current user intent', () => {
  it('defines conservative semantics for structured control-plane evidence', () => {
    expect(VERIFIER_SYSTEM_PROMPT).toContain('Task status proves lifecycle state, not correctness');
    expect(VERIFIER_SYSTEM_PROMPT).toContain('A successful tool outcome only means the tool returned without error');
    expect(VERIFIER_SYSTEM_PROMPT).toContain('Do not reject solely because a plan item is still open');
  });

  it('does not replace the real request with an Actor completion message', () => {
    const transcript: KodaXMessage[] = [
      { role: 'user', content: 'Review the patch and report whether it is safe.' },
      { role: 'assistant', content: 'I will delegate the concurrency review.' },
      {
        role: 'user',
        content: '<agent-completed path="/root/concurrency">No race found.</agent-completed>',
        _synthetic: true,
        _source: 'agent-completed',
        _taskResult: {
          type: 'task_result',
          source: 'child_task',
          taskId: 'turn-child-1',
          status: 'completed',
          summary: 'No race found.',
        },
      },
      { role: 'assistant', content: 'The patch is safe.' },
    ];

    expect(extractCurrentTurnUserQueries(transcript)).toEqual([
      'Review the patch and report whether it is safe.',
    ]);
  });

  it('keeps the original request while prior Sidecar revision feedback stays synthetic', () => {
    const transcript: KodaXMessage[] = [
      { role: 'user', content: 'Fix the race and verify it.' },
      { role: 'assistant', content: 'The race is fixed.' },
      {
        role: 'user',
        content: 'Add the missing deterministic regression test.',
        _synthetic: true,
        _source: 'sidecar-verifier',
      },
      { role: 'assistant', content: 'The race and regression test are complete.' },
    ];

    expect(extractCurrentTurnUserQueries(transcript)).toEqual([
      'Fix the race and verify it.',
    ]);
  });

  it('retains multiple real user messages attributed to the same turn', () => {
    const transcript: KodaXMessage[] = [
      { role: 'user', content: 'Earlier request.', turnId: 'turn-old' },
      { role: 'assistant', content: 'Earlier answer.', turnId: 'turn-old' },
      { role: 'user', content: 'Review the patch.', turnId: 'turn-current' },
      { role: 'user', content: 'Also run the focused test.', turnId: 'turn-current' },
      { role: 'assistant', content: 'Reviewed and tested.', turnId: 'turn-current' },
    ];

    expect(extractCurrentTurnUserQueries(transcript)).toEqual([
      'Review the patch.',
      'Also run the focused test.',
    ]);
  });

  it('builds one bounded evidence envelope without copying raw tool output', () => {
    const transcript: KodaXMessage[] = [
      { role: 'user', content: 'Fix the race and prove the result.', turnId: 'turn-root' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-test', name: 'bash', input: { command: 'npm test' } },
          { type: 'tool_use', id: 'tool-read', name: 'read', input: { path: 'secret.txt' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-test',
            content: '129 tests passed — RAW_OUTPUT_MUST_NOT_REACH_SIDECAR',
          },
          {
            type: 'tool_result',
            tool_use_id: 'tool-read',
            content: 'sensitive file contents',
            is_error: true,
          },
        ],
        _synthetic: true,
      },
      {
        role: 'user',
        content: '<agent-completed path="/root/review">Race fixed.</agent-completed>',
        _synthetic: true,
        _source: 'agent-completed',
        _taskResult: {
          type: 'task_result',
          source: 'child_task',
          taskId: 'child-turn-1',
          status: 'completed',
          title: '/root/review',
          summary: 'Race fixed and focused tests passed.',
          artifactRefs: ['report.md'],
        },
      },
      { role: 'assistant', content: 'The race is fixed and verified.' },
    ];

    const context = buildVerifierContext({
      transcript,
      lastAssistantText: 'The race is fixed and verified.',
      plan: [
        {
          id: 'todo-1',
          subject: 'Fix the race',
          description: 'PRIVATE_DESCRIPTION_MUST_NOT_REACH_SIDECAR',
          status: 'completed',
          owner: '/root/review',
          metadata: { private: true },
        },
        {
          id: 'todo-2',
          subject: 'Run the regression test',
          status: 'in_progress',
          note: 'Waiting for final confirmation',
        },
      ],
    });

    expect(context.currentTurnUserQueries).toEqual(['Fix the race and prove the result.']);
    expect(context.taskEvidence).toEqual([{
      source: 'child_task',
      taskId: 'child-turn-1',
      status: 'completed',
      title: '/root/review',
      summary: 'Race fixed and focused tests passed.',
      artifactRefs: ['report.md'],
      omittedArtifactRefCount: 0,
    }]);
    expect(context.planEvidence).toEqual([
      {
        id: 'todo-1',
        subject: 'Fix the race',
        status: 'completed',
        owner: '/root/review',
      },
      {
        id: 'todo-2',
        subject: 'Run the regression test',
        status: 'in_progress',
        note: 'Waiting for final confirmation',
      },
    ]);
    expect(context.toolOutcomeEvidence).toEqual([
      { toolName: 'bash', outcome: 'ok' },
      { toolName: 'read', outcome: 'error' },
    ]);
    expect(context.recentTranscript).not.toContain(transcript[0]);
    expect(context.recentTranscript).not.toContain(transcript[3]);
    expect(context.recentTranscript).not.toContain(transcript[4]);

    const message = buildVerifierUserMessage(context);
    expect(message).toContain('DELEGATED TASK EVIDENCE');
    expect(message).toContain('PLAN STATE');
    expect(message).toContain('TOOL OUTCOMES');
    expect(message).toContain('Race fixed and focused tests passed.');
    expect(message).toContain('[in_progress] Run the regression test');
    expect(message).toContain('bash: ok');
    expect(message).toContain('read: error');
    expect(message).not.toContain('RAW_OUTPUT_MUST_NOT_REACH_SIDECAR');
    expect(message).not.toContain('PRIVATE_DESCRIPTION_MUST_NOT_REACH_SIDECAR');
    expect(message.match(/Fix the race and prove the result\./gu)).toHaveLength(1);
    expect(message.match(/The race is fixed and verified\./gu)).toHaveLength(1);
  });

  it('keeps prior Sidecar revision feedback in recent context while deduplicating the request and final', () => {
    const transcript: KodaXMessage[] = [
      { role: 'user', content: 'Fix and test the race.' },
      { role: 'assistant', content: 'The race is fixed.' },
      {
        role: 'user',
        content: 'Add the missing deterministic test.',
        _synthetic: true,
        _source: 'sidecar-verifier',
      },
      { role: 'assistant', content: 'The race and deterministic test are complete.' },
    ];

    const context = buildVerifierContext({
      transcript,
      lastAssistantText: 'The race and deterministic test are complete.',
    });
    const message = buildVerifierUserMessage(context);

    expect(message).toContain('Add the missing deterministic test.');
    expect(message.match(/Fix and test the race\./gu)).toHaveLength(1);
    expect(message.match(/The race and deterministic test are complete\./gu)).toHaveLength(1);
  });

  it('retains structured completion context from an earlier real user turn', () => {
    const transcript: KodaXMessage[] = [
      { role: 'user', content: 'Run the initial audit.' },
      {
        role: 'user',
        content: '<agent-completed>Initial audit complete.</agent-completed>',
        _synthetic: true,
        _source: 'agent-completed',
        _taskResult: {
          type: 'task_result',
          source: 'child_task',
          taskId: 'initial-audit',
          status: 'completed',
          summary: 'Initial audit complete.',
        },
      },
      { role: 'assistant', content: 'The initial audit passed.' },
      { role: 'user', content: 'Now verify the follow-up patch.' },
      { role: 'assistant', content: 'The follow-up patch is safe.' },
    ];

    const context = buildVerifierContext({
      transcript,
      lastAssistantText: 'The follow-up patch is safe.',
    });

    expect(context.taskEvidence).toEqual([]);
    expect(context.recentTranscript).toContain(transcript[1]);
  });

  it('retains the terminal assistant tool call when no final assistant text exists', () => {
    const transcript: KodaXMessage[] = [
      { role: 'user', content: 'Finish the durable goal.' },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'complete-goal',
          name: 'update_goal',
          input: { status: 'complete' },
        }],
      },
    ];

    const context = buildVerifierContext({ transcript, lastAssistantText: '' });

    expect(context.recentTranscript).toContain(transcript[1]);
  });

  it('bounds task, plan, tool, file, and artifact evidence with explicit omission counts', () => {
    const transcript: KodaXMessage[] = [
      { role: 'user', content: 'Review the large change.' },
      ...Array.from({ length: 35 }, (_, index): KodaXMessage => ({
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: `tool-${index}`,
          name: `tool_${index}`,
          input: {},
        }],
      })).flatMap((assistant, index): KodaXMessage[] => [
        assistant,
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: `tool-${index}`,
            content: 'ignored',
          }],
          _synthetic: true,
        },
      ]),
      ...Array.from({ length: 22 }, (_, index): KodaXMessage => ({
        role: 'user',
        content: `child ${index} complete`,
        _synthetic: true,
        _source: 'agent-completed',
        _taskResult: {
          type: 'task_result',
          source: 'child_task',
          taskId: `child-${index}`,
          status: 'completed',
          artifactRefs: Array.from({ length: 10 }, (_unused, artifactIndex) => (
            `artifact-${index}-${artifactIndex}`
          )),
        },
      })),
      { role: 'assistant', content: 'Large review complete.' },
    ];
    const mutationTracker = {
      files: new Map(Array.from({ length: 45 }, (_, index) => [`file-${index}.ts`, 1])),
      totalOps: 45,
    };
    const plan = Array.from({ length: 25 }, (_, index) => ({
      id: `todo-${index}`,
      subject: `Todo ${index}`,
      status: 'completed' as const,
    }));

    const context = buildVerifierContext({
      transcript,
      lastAssistantText: 'Large review complete.',
      mutationTracker,
      plan,
    });

    expect(context.taskEvidence).toHaveLength(20);
    expect(context.omittedTaskEvidenceCount).toBe(2);
    expect(context.taskEvidence?.[0]?.artifactRefs).toHaveLength(8);
    expect(context.taskEvidence?.[0]?.omittedArtifactRefCount).toBe(2);
    expect(context.planEvidence).toHaveLength(20);
    expect(context.omittedPlanEvidenceCount).toBe(5);
    expect(context.toolOutcomeEvidence).toHaveLength(32);
    expect(context.omittedToolOutcomeEvidenceCount).toBe(3);
    expect(context.fileEditSummary).toHaveLength(40);
    expect(context.omittedFileEditCount).toBe(5);

    const message = buildVerifierUserMessage(context);
    expect(message).toContain('2 additional task result(s) omitted');
    expect(message).toContain('5 additional plan item(s) omitted');
    expect(message).toContain('3 additional tool outcome(s) omitted');
    expect(message).toContain('5 additional file(s) omitted');
  });

  it('keeps actionable plan states ahead of completed history when evidence is bounded', () => {
    const completed = Array.from({ length: 21 }, (_, index) => ({
      id: `completed-${index}`,
      subject: `Completed ${index}`,
      status: 'completed' as const,
    }));
    const actionable = [
      { id: 'pending-tail', subject: 'Run required test', status: 'pending' as const },
      { id: 'active-tail', subject: 'Finish integration', status: 'in_progress' as const },
      { id: 'failed-tail', subject: 'Repair failed build', status: 'failed' as const },
      { id: 'cancelled-tail', subject: 'Restore cancelled review', status: 'cancelled' as const },
    ];

    const context = buildVerifierContext({
      transcript: [{ role: 'user', content: 'Complete every required step.' }],
      lastAssistantText: 'Everything is complete.',
      plan: [...completed, ...actionable],
    });

    expect(context.planEvidence).toHaveLength(20);
    expect(context.planEvidence?.slice(0, 4).map((item) => item.id)).toEqual([
      'pending-tail',
      'active-tail',
      'failed-tail',
      'cancelled-tail',
    ]);
    expect(context.omittedPlanEvidenceCount).toBe(5);
  });

  it('strictly bounds file paths before they enter the verifier envelope', () => {
    const longPath = `${'nested/'.repeat(100)}implementation.ts`;
    const context = buildVerifierContext({
      transcript: [{ role: 'user', content: 'Implement the change.' }],
      lastAssistantText: 'Implemented.',
      mutationTracker: {
        files: new Map([[longPath, 1]]),
        totalOps: 1,
      },
    });

    const evidencePath = context.fileEditSummary[0]?.path ?? '';
    expect(evidencePath).toHaveLength(400);
    expect(evidencePath).toMatch(/\.\.\.\[truncated\]$/u);
    expect(buildVerifierUserMessage(context)).not.toContain(longPath);
  });

  it('keeps the legacy packet byte-identical when quality facts are absent', () => {
    const context = buildVerifierContext({
      transcript: [{ role: 'user', content: 'Review the patch.' }],
      lastAssistantText: 'Reviewed.',
    });

    expect(buildVerifierUserMessage({
      ...context,
      qualitySignals: undefined,
      patternTrace: undefined,
    })).toBe(buildVerifierUserMessage(context));
  });

  it('renders bounded trace facts, unresolved risk, and degradation without calling them proof', () => {
    const longRef = `finding:${'界'.repeat(504)}`;
    const trace: PatternTrace = {
      schemaVersion: 1,
      stages: Array.from({ length: 24 }, (_, index) => ({
        schemaVersion: 1 as const,
        ownerTurnRef: { actorPath: '/root', turnId: 'root-turn-1' },
        stageId: `stage-${index}`,
        pattern: 'adversarial-verification' as const,
        laneRelation: 'opposition' as const,
        participantTurnRefs: [{
          actorPath: `/root/challenger-${index}`,
          turnId: `turn-${index}`,
        }],
        targetActorTurnRefs: [],
        targetEvidenceRefs: [longRef, `${longRef}-${index}`, `finding:${index}`],
        contextFacts: {
          participants: [{
            turnRef: {
              actorPath: `/root/challenger-${index}`,
              turnId: `turn-${index}`,
            },
            role: 'challenger' as const,
            forkTurns: 'none' as const,
            effectiveProviderGroup: 'group-1',
            effectiveModelGroup: 'group-1',
            evidenceRefCount: 1,
          }],
          sharedEvidenceRefCount: 0,
          omittedParticipantCount: 0,
          commonParentActorPath: '/root',
          contextProjectionOmitted: false,
        },
        status: 'degraded' as const,
        dispositionCounts: { confirmed: 0, refuted: 1, unresolved: 1 },
        dispositionFacts: [{
          targetEvidenceRef: `finding:${index}`,
          disposition: 'refuted' as const,
          evidenceRefs: [longRef, longRef, longRef],
          omittedEvidenceRefCount: 0,
        }],
        actorAssertedCoverage: [longRef, longRef, longRef, longRef],
        degradedReasons: ['structured_result_unavailable'],
      })),
      omittedStageCount: 3,
    };
    const context = buildVerifierContext({
      transcript: [{ role: 'user', content: 'Review the patch.' }],
      lastAssistantText: 'Reviewed.',
      qualitySignals: {
        riskLevel: 'high',
        needsIndependentQA: true,
        assuranceIntent: 'explicit-check',
        reviewScale: 'large',
      },
      patternTrace: trace,
    });
    const message = buildVerifierUserMessage(context);

    expect(message).toContain('QUALITY STRATEGY FACTS (context, not proof)');
    expect(message).toContain('relation=opposition');
    expect(message).toContain('refuted=1 unresolved=1');
    expect(message).toContain('provider=group-1/model=group-1');
    expect(message).toContain('Outcome: target=finding:0 disposition=refuted');
    expect(message).toContain('Degraded: structured_result_unavailable');
    expect(message).toMatch(/\(\d+ additional strategy stage\(s\) omitted\)/u);
    expect(message).toContain('Stage count or completion does not prove correctness');
    expect(Buffer.byteLength(message, 'utf8')).toBeLessThan(16_000);
  });

  it('keeps a late refuted target inside the per-stage outcome preview', () => {
    const dispositionFacts = [
      ...Array.from({ length: 4 }, (_, index) => ({
        targetEvidenceRef: `finding:confirmed-${index}`,
        disposition: 'confirmed' as const,
        evidenceRefs: [] as const,
        omittedEvidenceRefCount: 0,
      })),
      {
        targetEvidenceRef: 'finding:late-risk',
        disposition: 'refuted' as const,
        evidenceRefs: ['finding:refutation'],
        omittedEvidenceRefCount: 0,
      },
    ];
    const trace: PatternTrace = {
      schemaVersion: 1,
      stages: [{
        schemaVersion: 1,
        ownerTurnRef: { actorPath: '/root', turnId: 'root-turn-1' },
        stageId: 'late-risk-stage',
        pattern: 'adversarial-verification',
        laneRelation: 'opposition',
        participantTurnRefs: [],
        targetActorTurnRefs: [],
        targetEvidenceRefs: dispositionFacts.map((fact) => fact.targetEvidenceRef),
        contextFacts: {
          participants: [],
          sharedEvidenceRefCount: 0,
          omittedParticipantCount: 0,
          contextProjectionOmitted: false,
        },
        status: 'completed',
        dispositionCounts: { confirmed: 4, refuted: 1, unresolved: 0 },
        dispositionFacts,
      }],
      omittedStageCount: 0,
    };
    const message = buildVerifierUserMessage(buildVerifierContext({
      transcript: [{ role: 'user', content: 'Review the risk.' }],
      lastAssistantText: 'Reviewed.',
      patternTrace: trace,
    }));

    expect(message).toContain(
      'Outcome: target=finding:late-risk disposition=refuted support=finding:refutation',
    );
    expect(message).toContain('(1 outcome fact(s) omitted)');
  });
});
