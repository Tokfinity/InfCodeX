import { describe, expect, it } from 'vitest';

import type { WorkflowScriptManifest } from './manifest.js';
import {
  assertRestrictedWorkflowQuality,
  lintRestrictedWorkflowSource,
} from './quality-lint.js';
import { createRestrictedWorkflowModule } from './script-runner.js';

const REVIEW_MANIFEST: WorkflowScriptManifest = {
  name: 'diff-review',
  description: 'Review the current diff for bugs and security regressions.',
  phases: ['findings', 'synthesis'],
  readOnly: true,
  maxAgents: 4,
  maxConcurrency: 2,
  patterns: ['fan-out-and-synthesize'],
};

const ADVERSARIAL_MANIFEST: WorkflowScriptManifest = {
  ...REVIEW_MANIFEST,
  phases: ['findings', 'verify', 'synthesis'],
  patterns: ['fan-out-and-synthesize', 'adversarial-verification'],
};

describe('workflow quality lint', () => {
  it('does not report adversarial-verification heuristics as lint findings', () => {
    const source = `
      async function run(wf) {
        const findings = await wf.parallel([
          () => wf.runAgent({ name: "api-reviewer", prompt: "Review packages/api for bugs.", readOnly: true }),
          () => wf.runAgent({ name: "ui-reviewer", prompt: "Review packages/ui for bugs.", readOnly: true })
        ]);
        return wf.synthesize({
          inputs: findings.filter(Boolean).map((result) => result.finalText),
          rubric: "Summarize the findings."
        });
      }
    `;

    const findings = lintRestrictedWorkflowSource(source, { manifest: ADVERSARIAL_MANIFEST });
    expect(findings).toEqual([]);
    expect(() =>
      assertRestrictedWorkflowQuality(source, { manifest: ADVERSARIAL_MANIFEST }),
    ).not.toThrow();
  });

  it('does not report review fanout verification heuristics as lint findings', () => {
    const source = `
      async function run(wf) {
        const reviewers = await wf.parallel([
          () => wf.runAgent({ name: "correctness-reviewer", prompt: "Review src/runtime.ts for correctness bugs.", readOnly: true }),
          () => wf.runAgent({ name: "security-reviewer", prompt: "Audit src/runtime.ts for security bugs.", readOnly: true })
        ]);
        const synthesis = await wf.synthesize({
          inputs: reviewers.filter(Boolean).map((result) => result.finalText),
          rubric: "Merge the review findings."
        });
        return synthesis.text;
      }
    `;

    const findings = lintRestrictedWorkflowSource(source, { manifest: REVIEW_MANIFEST });
    expect(findings).toEqual([]);
    expect(() =>
      createRestrictedWorkflowModule({ manifest: REVIEW_MANIFEST, source }),
    ).not.toThrow();
  });

  it('accepts finder to verifier to synthesis review shape', () => {
    const source = `
      async function run(wf) {
        const reviewers = await wf.parallel([
          () => wf.runAgent({ name: "correctness-reviewer", prompt: "Review src/runtime.ts for correctness bugs.", readOnly: true }),
          () => wf.runAgent({ name: "security-reviewer", prompt: "Audit src/runtime.ts for security bugs.", readOnly: true })
        ]);
        const candidates = reviewers.filter(Boolean);
        const verified = await wf.parallel(candidates.map((candidate) => () => wf.runAgent({
          name: "adversarial-verifier-" + candidate.taskId,
          prompt: "Try to refute this finding with code evidence before synthesis:\\n" + candidate.finalText,
          evidenceRefs: ["task_id:" + candidate.taskId],
          readOnly: true,
          modelHint: "deep"
        })));
        const synthesis = await wf.synthesize({
          inputs: verified.filter(Boolean).map((result) => result.finalText),
          rubric: "Report confirmed, refuted, and uncertain findings separately."
        });
        return synthesis.text;
      }
    `;

    expect(() =>
      assertRestrictedWorkflowQuality(source, { manifest: ADVERSARIAL_MANIFEST }),
    ).not.toThrow();
  });

  it('does not report verifier evidence-flow heuristics as lint findings', () => {
    const source = `
      async function run(wf) {
        const reviewers = await wf.parallel([
          () => wf.runAgent({ name: "correctness-reviewer", prompt: "Review src/runtime.ts for correctness bugs.", readOnly: true }),
          () => wf.runAgent({ name: "security-reviewer", prompt: "Audit src/runtime.ts for security bugs.", readOnly: true })
        ]);
        const verified = await wf.parallel(reviewers.map((candidate) => () => wf.runAgent({
          name: "adversarial-verifier",
          prompt: "Try to refute any issue.",
          evidenceRefs: [],
          readOnly: true
        })));
        return wf.synthesize({
          inputs: verified.map((result) => result.finalText),
          rubric: "Report confirmed, refuted, and uncertain findings separately."
        });
      }
    `;

    const findings = lintRestrictedWorkflowSource(source, { manifest: ADVERSARIAL_MANIFEST });
    expect(findings).toEqual([]);
    expect(() =>
      assertRestrictedWorkflowQuality(source, { manifest: ADVERSARIAL_MANIFEST }),
    ).not.toThrow();
  });

  it('does not report verifier synthesis-flow heuristics as lint findings', () => {
    const source = `
      async function run(wf) {
        const reviewers = await wf.parallel([
          () => wf.runAgent({ name: "correctness-reviewer", prompt: "Review src/runtime.ts for correctness bugs.", readOnly: true }),
          () => wf.runAgent({ name: "security-reviewer", prompt: "Audit src/runtime.ts for security bugs.", readOnly: true })
        ]);
        await wf.runAgent({
          name: "adversarial-verifier",
          prompt: "Try to refute the first candidate before synthesis:\\n" + reviewers[0].finalText,
          evidenceRefs: ["task_id:" + reviewers[0].taskId],
          readOnly: true
        });
        return wf.synthesize({
          inputs: reviewers.map((result) => result.finalText),
          rubric: "Report confirmed, refuted, and uncertain findings separately."
        });
      }
    `;

    const findings = lintRestrictedWorkflowSource(source, { manifest: ADVERSARIAL_MANIFEST });
    expect(findings).toEqual([]);
    expect(() =>
      assertRestrictedWorkflowQuality(source, { manifest: ADVERSARIAL_MANIFEST }),
    ).not.toThrow();
  });

  it('does not report first-stage verifier-shape heuristics as lint findings', () => {
    const source = `
      async function run(wf, args) {
        const verified = await wf.pipeline(
          args.files,
          (file) => wf.runAgent({
            name: "adversarial-verifier",
            prompt: "Try to refute claims in " + file,
            readOnly: true
          })
        );
        return wf.synthesize({
          inputs: verified.map((result) => result.finalText),
          rubric: "Report confirmed, refuted, and uncertain findings separately."
        });
      }
    `;

    const findings = lintRestrictedWorkflowSource(source, { manifest: ADVERSARIAL_MANIFEST });
    expect(findings).toEqual([]);
    expect(() =>
      assertRestrictedWorkflowQuality(source, { manifest: ADVERSARIAL_MANIFEST }),
    ).not.toThrow();
  });

  it('accepts a later pipeline verifier stage that uses the prior stage result', () => {
    const source = `
      async function run(wf, args) {
        const verified = await wf.pipeline(
          args.files,
          (file) => wf.runAgent({
            name: "bug-reviewer",
            prompt: "Review " + file + " for correctness and security bugs.",
            readOnly: true
          }),
          (candidate) => wf.runAgent({
            name: "adversarial-verifier",
            prompt: "Try to refute the prior finding before synthesis: " + candidate.finalText,
            readOnly: true
          })
        );
        return wf.synthesize({
          inputs: verified.map((result) => result.finalText),
          rubric: "Report confirmed, refuted, and uncertain findings separately."
        });
      }
    `;

    expect(() =>
      assertRestrictedWorkflowQuality(source, { manifest: ADVERSARIAL_MANIFEST }),
    ).not.toThrow();
  });

  it('accepts a later pipeline verifier stage nested inside parallel map', () => {
    const source = `
      async function run(wf, args) {
        const verified = await wf.pipeline(
          args.files,
          (file) => wf.runAgent({
            name: "bug-reviewer",
            prompt: "Review " + file + " for correctness and security bugs.",
            readOnly: true
          }),
          (candidate) => wf.parallel([0, 1].map((attempt) => () => wf.runAgent({
            name: "adversarial-verifier-" + attempt,
            prompt: "Try to refute the prior finding before synthesis: " + JSON.stringify(candidate),
            readOnly: true
          })))
        );
        return wf.synthesize({
          inputs: verified.flat().map((result) => result.finalText),
          rubric: "Report confirmed, refuted, and uncertain findings separately."
        });
      }
    `;

    expect(() =>
      assertRestrictedWorkflowQuality(source, { manifest: ADVERSARIAL_MANIFEST }),
    ).not.toThrow();
  });

  it('accepts a nested verifier derived from a later pipeline stage input', () => {
    const source = `
      async function run(wf, args) {
        const verified = await wf.pipeline(
          args.files,
          (file) => wf.runAgent({
            name: "bug-reviewer",
            prompt: "Review " + file + " for correctness and security bugs.",
            readOnly: true
          }),
          (candidate) => wf.parallel(candidate.structured.findings.map((finding) => () => wf.runAgent({
            name: "adversarial-verifier",
            prompt: "Try to refute this finding before synthesis: " + finding.summary,
            readOnly: true
          })))
        );
        return wf.synthesize({
          inputs: verified.flat().map((result) => result.finalText),
          rubric: "Report confirmed, refuted, and uncertain findings separately."
        });
      }
    `;

    expect(() =>
      assertRestrictedWorkflowQuality(source, { manifest: ADVERSARIAL_MANIFEST }),
    ).not.toThrow();
  });

  it('accepts a verifier whose prompt and evidence refs are local variables', () => {
    const source = `
      async function run(wf) {
        const reviewers = await wf.parallel([
          () => wf.runAgent({ name: "correctness-reviewer", prompt: "Review src/runtime.ts for correctness bugs.", readOnly: true }),
          () => wf.runAgent({ name: "security-reviewer", prompt: "Audit src/runtime.ts for security bugs.", readOnly: true })
        ]);
        const candidate = reviewers[0];
        const prompt = "Try to refute this candidate finding before synthesis:\\n" + candidate.finalText;
        const evidenceRefs = ["task_id:" + candidate.taskId];
        const verified = await wf.runAgent({
          name: "adversarial-verifier",
          prompt,
          evidenceRefs,
          readOnly: true
        });
        return wf.synthesize({
          inputs: [verified.finalText],
          rubric: "Report confirmed, refuted, and uncertain findings separately."
        });
      }
    `;

    expect(() =>
      assertRestrictedWorkflowQuality(source, { manifest: ADVERSARIAL_MANIFEST }),
    ).not.toThrow();
  });

  it('accepts a verifier whose name and prompt use shorthand properties', () => {
    const source = `
      async function run(wf) {
        const reviewers = await wf.parallel([
          () => wf.runAgent({ name: "correctness-reviewer", prompt: "Review src/runtime.ts for correctness bugs.", readOnly: true }),
          () => wf.runAgent({ name: "security-reviewer", prompt: "Audit src/runtime.ts for security bugs.", readOnly: true })
        ]);
        const candidate = reviewers[0];
        const name = "adversarial-verifier";
        const prompt = "Try to refute this candidate finding before synthesis:\\n" + candidate.finalText;
        const evidenceRefs = ["task_id:" + candidate.taskId];
        const verified = await wf.runAgent({ name, prompt, evidenceRefs, readOnly: true });
        return wf.synthesize({
          inputs: [verified.finalText],
          rubric: "Report confirmed, refuted, and uncertain findings separately."
        });
      }
    `;

    expect(() =>
      assertRestrictedWorkflowQuality(source, { manifest: ADVERSARIAL_MANIFEST }),
    ).not.toThrow();
  });

  it('accepts synthesis that includes verifier output through a local alias', () => {
    const source = `
      async function run(wf) {
        const reviewers = await wf.parallel([
          () => wf.runAgent({ name: "correctness-reviewer", prompt: "Review src/runtime.ts for correctness bugs.", readOnly: true }),
          () => wf.runAgent({ name: "security-reviewer", prompt: "Audit src/runtime.ts for security bugs.", readOnly: true })
        ]);
        const verified = await wf.parallel(reviewers.map((candidate) => () => wf.runAgent({
          name: "adversarial-verifier-" + candidate.taskId,
          prompt: "Try to refute this finding before synthesis:\\n" + candidate.finalText,
          readOnly: true
        })));
        const verifiedTexts = verified.map((result) => result.finalText);
        return wf.synthesize({
          inputs: [
            ...reviewers.map((result) => result.finalText),
            ...verifiedTexts
          ],
          rubric: "Report confirmed, refuted, and uncertain findings separately."
        });
      }
    `;

    expect(() =>
      assertRestrictedWorkflowQuality(source, { manifest: ADVERSARIAL_MANIFEST }),
    ).not.toThrow();
  });

  it('rejects unawaited workflow command variables in boolean position', () => {
    const source = `
      async function run(wf) {
        const result = wf.runAgent({ name: "reader", prompt: "Inspect src/runtime.ts", readOnly: true });
        if (result) return "has result";
        return "missing";
      }
    `;

    expect(() =>
      assertRestrictedWorkflowQuality(source, { manifest: REVIEW_MANIFEST }),
    ).toThrow(/must be awaited before boolean checks/i);
  });

  it('rejects schema-bearing result fields read from the top-level result', () => {
    const source = `
      async function run(wf) {
        const reviewer = await wf.runAgent({
          name: "reviewer",
          prompt: "Review src/runtime.ts for bugs.",
          readOnly: true,
          outputSchema: { type: "object", properties: { findings: { type: "array" } } }
        });
        return reviewer.findings;
      }
    `;

    expect(() =>
      assertRestrictedWorkflowQuality(source, { manifest: REVIEW_MANIFEST }),
    ).toThrow(/reviewer\.structured\.findings/i);
  });

  it('rejects schema-bearing fanout item fields read from top-level results', () => {
    const source = `
      async function run(wf) {
        const reviewers = await wf.parallel([
          () => wf.runAgent({
            name: "reviewer-a",
            prompt: "Review src/a.ts for bugs.",
            readOnly: true,
            outputSchema: { type: "object", properties: { findings: { type: "array" } } }
          }),
          () => wf.runAgent({
            name: "reviewer-b",
            prompt: "Review src/b.ts for bugs.",
            readOnly: true,
            outputSchema: { type: "object", properties: { findings: { type: "array" } } }
          })
        ]);
        return reviewers.map((review) => review.findings).join("\\n");
      }
    `;

    expect(() =>
      assertRestrictedWorkflowQuality(source, { manifest: REVIEW_MANIFEST }),
    ).toThrow(/review\.structured\.findings/i);
  });

  it('allows schema-bearing result metadata fields at the top level', () => {
    const source = `
      async function run(wf) {
        const reviewer = await wf.runAgent({
          name: "reviewer",
          prompt: "Review src/runtime.ts for bugs.",
          readOnly: true,
          outputSchema: { type: "object", properties: { findings: { type: "array" } } }
        });
        return reviewer.limitReached ? reviewer.finalText : reviewer.structured.findings;
      }
    `;

    expect(() =>
      assertRestrictedWorkflowQuality(source, { manifest: REVIEW_MANIFEST }),
    ).not.toThrow();
  });

  it('does not report unused outputSchema heuristics as lint findings', () => {
    const source = `
      async function run(wf) {
        const reviewer = await wf.runAgent({
          name: "reviewer",
          prompt: "Review src/runtime.ts for bugs.",
          readOnly: true,
          outputSchema: { type: "object", properties: { findings: { type: "array" } } }
        });
        return reviewer.finalText;
      }
    `;

    const findings = lintRestrictedWorkflowSource(source, { manifest: REVIEW_MANIFEST });
    expect(findings).toEqual([]);
  });

  it('does not warn when a schema-bearing result is passed whole into synthesis', () => {
    const source = `
      async function run(wf) {
        const reviewer = await wf.runAgent({
          name: "reviewer",
          prompt: "Review src/runtime.ts for bugs.",
          readOnly: true,
          outputSchema: { type: "object", properties: { findings: { type: "array" } } }
        });
        return wf.synthesize({
          inputs: [reviewer],
          rubric: "Preserve the structured reviewer result."
        });
      }
    `;

    const findings = lintRestrictedWorkflowSource(source, { manifest: REVIEW_MANIFEST });
    expect(findings).not.toContainEqual(expect.objectContaining({
      code: 'output-schema-structured-unused',
    }));
  });

  it('does not report generic prompt heuristics as lint findings', () => {
    const source = `
      async function run(wf) {
        const result = await wf.runAgent({ name: "reviewer", prompt: "review", readOnly: true });
        return result.finalText;
      }
    `;

    const findings = lintRestrictedWorkflowSource(source, { manifest: REVIEW_MANIFEST });
    expect(findings).toEqual([]);
    expect(() =>
      assertRestrictedWorkflowQuality(source, { manifest: REVIEW_MANIFEST }),
    ).not.toThrow();
  });

  it('rejects literal wf.parallel fanout above manifest maxAgents', () => {
    const source = `
      async function run(wf) {
        const results = await wf.parallel([
          () => wf.runAgent({ name: "a", prompt: "Inspect src/a.ts", readOnly: true }),
          () => wf.runAgent({ name: "b", prompt: "Inspect src/b.ts", readOnly: true }),
          () => wf.runAgent({ name: "c", prompt: "Inspect src/c.ts", readOnly: true })
        ]);
        return results.length;
      }
    `;

    expect(() =>
      assertRestrictedWorkflowQuality(source, {
        manifest: { ...REVIEW_MANIFEST, maxAgents: 2 },
      }),
    ).toThrow(/literal fanout/i);
  });

  it('does not apply maxAgents to literal parallel work without agent calls', () => {
    const source = `
      async function run(wf) {
        const results = await wf.parallel([
          () => wf.artifact({ name: "first", content: "a" }),
          () => wf.artifact({ name: "second", content: "b" }),
          () => wf.artifact({ name: "third", content: "c" })
        ]);
        return String(results.length);
      }
    `;

    expect(() =>
      assertRestrictedWorkflowQuality(source, {
        manifest: { ...REVIEW_MANIFEST, maxAgents: 2 },
      }),
    ).not.toThrow();
  });

  it('does not apply maxAgents to literal pipeline stages without agent calls', () => {
    const source = `
      async function run(wf) {
        const results = await wf.pipeline(
          ["a", "b", "c"],
          (item) => item.toUpperCase()
        );
        return results.join("\\n");
      }
    `;

    expect(() =>
      assertRestrictedWorkflowQuality(source, {
        manifest: { ...REVIEW_MANIFEST, maxAgents: 2 },
      }),
    ).not.toThrow();
  });

  it('rejects literal array.map fanout above manifest maxAgents', () => {
    const source = `
      async function run(wf) {
        const results = await wf.parallel([1, 2, 3].map((n) => () =>
          wf.runAgent({ name: "reader-" + n, prompt: "Inspect src/runtime.ts", readOnly: true })
        ));
        return results.length;
      }
    `;

    expect(() =>
      assertRestrictedWorkflowQuality(source, {
        manifest: { ...REVIEW_MANIFEST, maxAgents: 2 },
      }),
    ).toThrow(/literal fanout/i);
  });
});
