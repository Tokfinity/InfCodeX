import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunnerToolCall } from '@kodax-ai/agent';
import type { AutoModeRulesContext } from '@kodax-ai/coding';
import { createTempDirSync, removeTempDirSync } from '../test-utils/temp-dir.js';
import { assessAutoModeCall, evaluateAutoRulesCall } from './auto-rules.js';

const createdRoots: string[] = [];

function createRoot(prefix: string): string {
  const root = createTempDirSync(prefix, process.cwd());
  createdRoots.push(root);
  return root;
}

function call(name: string, input: Readonly<Record<string, unknown>>): RunnerToolCall {
  return { id: `${name}-call`, name, input };
}

function context(
  projectRoot: string,
  executionCwd = projectRoot,
  signals: AutoModeRulesContext['signals'] = [],
): AutoModeRulesContext {
  return { projectRoot, executionCwd, signals };
}

afterEach(() => {
  while (createdRoots.length > 0) removeTempDirSync(createdRoots.pop());
});

describe('Auto[rules] deterministic Tier 2', () => {
  it.each(['write', 'edit', 'multi_edit'] as const)(
    'allows %s when its normalized target stays inside the Runtime workspace',
    (toolName) => {
      const projectRoot = createRoot('kodax-auto-rules-project-');
      const executionCwd = path.join(projectRoot, 'packages', 'app');
      fs.mkdirSync(executionCwd, { recursive: true });

      const decision = evaluateAutoRulesCall(
        call(toolName, { path: path.join('..', '..', 'src', 'inside.ts') }),
        context(projectRoot, executionCwd),
      );

      expect(decision.action).toBe('allow');
    },
  );

  it('allows insert_after_anchor under the same known file-tool policy', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const decision = evaluateAutoRulesCall(
      call('insert_after_anchor', { path: 'src/inside.ts' }),
      context(projectRoot),
    );
    expect(decision.action).toBe('allow');
  });

  it.each(['write', 'edit', 'multi_edit'] as const)(
    'allows %s in a system temp directory',
    (toolName) => {
      const projectRoot = createRoot('kodax-auto-rules-project-');
      const target = path.join(os.tmpdir(), `kodax-auto-rules-${toolName}-${Date.now()}.txt`);
      const decision = evaluateAutoRulesCall(call(toolName, { path: target }), context(projectRoot));
      expect(decision.action).toBe('allow');
    },
  );

  it.each(['write', 'edit', 'multi_edit'] as const)(
    'escalates %s when .. resolves outside the workspace and temp boundaries',
    (toolName) => {
      const projectRoot = createRoot('kodax-auto-rules-project-');
      const decision = evaluateAutoRulesCall(
        call(toolName, { path: path.join('..', 'outside.txt') }),
        context(projectRoot),
      );
      expect(decision).toMatchObject({ action: 'escalate' });
    },
  );

  it('escalates protected project configuration even though it is in the workspace', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const decision = evaluateAutoRulesCall(
      call('write', { path: '.kodax/config.json' }),
      context(projectRoot),
    );
    expect(decision).toMatchObject({ action: 'escalate' });
  });

  it('escalates missing or non-string file targets', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    expect(evaluateAutoRulesCall(call('edit', {}), context(projectRoot)).action).toBe('escalate');
    expect(evaluateAutoRulesCall(call('edit', { path: 42 }), context(projectRoot)).action)
      .toBe('escalate');
  });

  it('marks a dynamic file-tool target incomplete instead of claiming exact analysis', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const result = assessAutoModeCall(
      call('write', { path: '$DYNAMIC_ROOT/file.txt' }),
      context(projectRoot),
    );

    expect(result.decision.action).toBe('escalate');
    expect(result.review).toMatchObject({
      analysis: { status: 'incomplete', binding: 'partial' },
      operations: [{ target: { boundary: 'unresolved' } }],
      risks: ['target_unresolved'],
    });
  });

  it('escalates when the Runtime project boundary cannot be resolved to an existing directory', () => {
    const missingRoot = path.join(process.cwd(), `missing-auto-rules-${Date.now()}`);
    const decision = evaluateAutoRulesCall(
      call('write', { path: 'src/inside.ts' }),
      context(missingRoot),
    );
    expect(decision.action).toBe('escalate');
  });

  it.each(['write', 'edit', 'multi_edit'] as const)(
    'escalates %s when an in-workspace junction or symlink resolves outside',
    (toolName) => {
      const projectRoot = createRoot('kodax-auto-rules-project-');
      const outsideRoot = createRoot('kodax-auto-rules-outside-');
      const link = path.join(projectRoot, 'linked-outside');
      fs.symlinkSync(outsideRoot, link, process.platform === 'win32' ? 'junction' : 'dir');

      const decision = evaluateAutoRulesCall(
        call(toolName, { path: path.join(link, 'escaped.ts') }),
        context(projectRoot),
      );
      expect(decision).toMatchObject({ action: 'escalate' });
    },
  );

  it('escalates a broken in-workspace junction or symlink instead of falling back to lexical containment', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const outsideRoot = createRoot('kodax-auto-rules-broken-target-');
    const link = path.join(projectRoot, 'broken-link');
    fs.symlinkSync(outsideRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
    removeTempDirSync(outsideRoot);

    const decision = evaluateAutoRulesCall(
      call('write', { path: path.join(link, 'escaped.ts') }),
      context(projectRoot),
    );
    expect(decision).toMatchObject({ action: 'escalate' });
  });

  it.each([
    '.env',
    '.env.local',
    '.ssh/id_ed25519',
    '.aws/credentials',
    'credentials/service-account.json',
  ])(
    'escalates protected credential/config target %s inside the workspace',
    (target) => {
      const projectRoot = createRoot('kodax-auto-rules-project-');
      const decision = evaluateAutoRulesCall(call('write', { path: target }), context(projectRoot));
      expect(decision).toMatchObject({ action: 'escalate' });
    },
  );

  it.runIf(process.platform === 'win32')(
    'handles Windows path casing and mixed separators without a false outside-workspace result',
    () => {
      const projectRoot = createRoot('kodax-auto-rules-case-');
      const mixedTarget = path.join(projectRoot.toUpperCase(), 'src', 'inside.ts')
        .replaceAll('\\', '/');
      const decision = evaluateAutoRulesCall(
        call('multi_edit', { path: mixedTarget }),
        context(projectRoot.toLowerCase()),
      );
      expect(decision.action).toBe('allow');
    },
  );

  it('allows read-only bash commands even when they read outside the workspace', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const outsideRoot = createRoot('kodax-auto-rules-outside-');
    const decision = evaluateAutoRulesCall(
      call('bash', { command: `cat "${path.join(outsideRoot, 'notes.txt')}"` }),
      context(projectRoot),
    );
    expect(decision.action).toBe('allow');
  });

  it.each(['read', 'grep', 'glob'] as const)(
    'models a safe %s call as an exact read operation',
    (toolName) => {
      const projectRoot = createRoot('kodax-auto-rules-project-');
      const assessment = assessAutoModeCall(
        call(toolName, { path: path.join(projectRoot, 'src') }),
        context(projectRoot),
      );

      expect(assessment.decision.action).toBe('allow');
      expect(assessment.review).toMatchObject({
        analysis: { status: 'complete', binding: 'exact' },
        operations: [{ kind: 'read', target: { boundary: 'workspace' } }],
        risks: [],
      });
    },
  );

  it.each([
    ['read', '.ssh/id_ed25519'],
    ['grep', '.aws/credentials'],
    ['glob', '.config/gh/hosts.yml'],
    ['read', '/proc/self/environ'],
  ] as const)('escalates %s access to sensitive path %s', (toolName, target) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call(toolName, { path: target }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review).toMatchObject({
      operations: [{ kind: 'read', target: { boundary: 'protected' } }],
    });
    expect(assessment.review.risks).toContain('sensitive_read');
  });

  it('escalates a grep filter that expands into a sensitive directory', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('grep', { path: projectRoot, glob: '**/.aws/**', pattern: 'token' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_read');
  });

  it('keeps documented environment templates readable without confirmation', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('read', { path: '.env.example' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.risks).toEqual([]);
  });

  it('does not let an environment-template filename exempt a sensitive directory', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('read', { path: '.ssh/.env.example' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_read');
  });

  it('models git show as deterministic read-only shell execution', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command: 'git show 1bbae03c --stat --format=fuller' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review).toMatchObject({
      analysis: { status: 'complete', binding: 'exact' },
      operations: [{ kind: 'execute', options: { readOnly: true } }],
      risks: [],
    });
  });

  it('requires confirmation before a read-only shell command accesses a secret path', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command: 'cat ~/.ssh/id_ed25519' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.operations).toContainEqual(expect.objectContaining({
      kind: 'read', target: expect.objectContaining({ boundary: 'protected' }),
    }));
    expect(assessment.review.risks).toContain('sensitive_read');
  });

  it.each([
    'cat .env',
    'Get-Content .env',
    'git diff HEAD -- .env',
    'git show HEAD:.env',
    'git show HEAD:.ssh/id_ed25519',
    'cat .env > reports/copy.txt',
    'cat .env | tee reports/copy.txt',
    'Get-Content .env | Set-Content reports/copy.txt',
    'grep secret .env > reports/matches.txt',
    'sed -n p .env > reports/copy.txt',
    "awk '{print}' .env > reports/copy.txt",
    'Select-String -Pattern secret -Path .env | Set-Content reports/matches.txt',
  ])('requires confirmation for a sensitive bare or git-object read: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_read');
    expect(assessment.review.operations).toContainEqual(expect.objectContaining({
      kind: 'read', target: expect.objectContaining({ boundary: 'protected' }),
    }));
  });

  it.each([
    'cat .env.example',
    'git show HEAD:.env.example',
    'git show --format .env HEAD',
    'git diff -G .env -- README.md',
    'grep ".env" README.md',
    'grep ".env" README.md > reports/matches.txt',
    'Get-Content -Delimiter .env README.md',
  ])('does not treat a non-path read operand as sensitive: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.risks).not.toContain('sensitive_read');
  });

  it('requires confirmation before a shell command reveals a sensitive environment variable', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command: 'echo $OPENAI_API_KEY' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_environment_read');
  });

  it('requires confirmation before PowerShell enumerates the environment', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command: 'Get-ChildItem Env:' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.risks).toContain('sensitive_environment_read');
  });

  it.each([
    'git tag -a v1.0 -m release',
    'git branch new-branch',
    'git remote set-url origin https://example.test/repo.git',
    'find . -delete',
  ])('does not mistake write-capable syntax for a read-only command: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    expect(evaluateAutoRulesCall(call('bash', { command }), context(projectRoot)).action)
      .toBe('escalate');
  });

  it('allows deterministic bash writes whose targets stay in the workspace', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const decision = evaluateAutoRulesCall(
      call('bash', { command: 'echo ok > build/result.txt' }),
      context(projectRoot),
    );
    expect(decision.action).toBe('allow');
  });

  it('allows modeled workspace cleanup with a medium-risk signal and an in-boundary target', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const decision = evaluateAutoRulesCall(
      call('bash', { command: 'rm -rf build' }),
      context(projectRoot, projectRoot, [
        { kind: 'dangerous_pattern', pattern: 'rm -rf', severity: 'medium' },
      ]),
    );
    expect(decision.action).toBe('allow');
  });

  it('allows a safe read command redirected to an in-workspace output', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const decision = evaluateAutoRulesCall(
      call('bash', { command: 'git status > reports/status.txt' }),
      context(projectRoot),
    );
    expect(decision.action).toBe('allow');
  });

  it.each([
    'echo one > reports/one.txt && echo two > reports/two.txt',
    'cat package.json | tee reports/package.txt',
  ])('allows fully modeled compound/pipeline writes when every target is in-boundary: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    expect(evaluateAutoRulesCall(call('bash', { command }), context(projectRoot)).action)
      .toBe('allow');
  });

  it('escalates deterministic bash writes outside the workspace and temp boundaries', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const outsideRoot = createRoot('kodax-auto-rules-outside-');
    const decision = evaluateAutoRulesCall(
      call('bash', { command: `echo no > "${path.join(outsideRoot, 'result.txt')}"` }),
      context(projectRoot),
    );
    expect(decision).toMatchObject({ action: 'escalate' });
  });

  it.each([
    ['Copy-Item "src/inside.txt" "../outside.txt"', 'copy'],
    ['Move-Item -Force "src/inside.txt" "../outside.txt"', 'move'],
    ['Set-Content -Value data "../outside.txt"', 'write'],
    ['Out-File -InputObject data -FilePath "../outside.txt"', 'write'],
    ['New-Item -ItemType File "../outside.txt"', 'create'],
    ['Remove-Item -Filter harmless.txt "../outside.txt"', 'delete'],
  ] as const)(
    'does not auto-allow PowerShell target binding outside the workspace: %s',
    (command, expectedKind) => {
      const projectRoot = createRoot('kodax-auto-rules-project-');
      const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

      expect(assessment.decision.action).toBe('escalate');
      expect(assessment.review.analysis).toMatchObject({
        status: 'complete',
        shell: 'powershell',
        binding: 'exact',
      });
      expect(assessment.review.operations).toHaveLength(1);
      expect(assessment.review.operations[0]).toMatchObject({ kind: expectedKind });
      expect(JSON.stringify(assessment.review.operations[0])).toContain('outside-workspace');
    },
  );

  it.each([
    'Copy-Item "src/inside.txt" "build/copied.txt"',
    'Move-Item -Force "src/inside.txt" "build/moved.txt"',
    'Set-Content -Value data "build/set.txt"',
    'Out-File -InputObject data -FilePath "build/out.txt"',
    'New-Item -ItemType File "build/new.txt"',
    'Remove-Item -Filter harmless.txt "build/old.txt"',
  ])('preserves rules-mode auto-allow for a fully bound in-workspace command: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    expect(evaluateAutoRulesCall(call('bash', { command }), context(projectRoot)).action)
      .toBe('allow');
  });

  it('escalates PowerShell bracket wildcards without blocking LiteralPath brackets', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const wildcard = assessAutoModeCall(
      call('bash', { command: 'Set-Content -Path "[.]kodax/config.json" -Value data' }),
      context(projectRoot),
    );
    const literal = assessAutoModeCall(
      call('bash', { command: 'Set-Content -LiteralPath "build/file[12].txt" -Value data' }),
      context(projectRoot),
    );

    expect(wildcard.decision.action).toBe('escalate');
    expect(wildcard.review.analysis).toMatchObject({
      status: 'incomplete',
      shell: 'powershell',
      binding: 'partial',
    });
    expect(literal.decision.action).toBe('allow');
    expect(literal.review.analysis).toMatchObject({
      status: 'complete',
      shell: 'powershell',
      binding: 'exact',
    });
  });

  it('allows a fully modeled outside-workspace PowerShell WhatIf with no mutation risk', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command: 'Set-Content -WhatIf -Value data "../outside.txt"' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('allow');
    expect(assessment.review.operations).toEqual([
      expect.objectContaining({ options: expect.objectContaining({ whatIf: true }) }),
    ]);
    expect(assessment.review.risks).not.toContain('outside_workspace_mutation');
  });

  it('models Move-Item as one atomic source-to-destination operation', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command: 'Move-Item -Force "src/a.txt" "../outside/b.txt"' }),
      context(projectRoot),
    );

    expect(assessment.review.operations).toEqual([
      expect.objectContaining({
        kind: 'move',
        source: expect.objectContaining({ path: 'src/a.txt', boundary: 'workspace' }),
        destination: expect.objectContaining({
          path: '../outside/b.txt',
          boundary: 'outside-workspace',
        }),
        options: expect.objectContaining({ force: true }),
      }),
    ]);
  });

  it('keeps POSIX mv atomic and represents rm as deletion', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const move = assessAutoModeCall(
      call('bash', { command: 'mv -f src/a.txt build/a.txt' }),
      context(projectRoot),
    );
    const remove = assessAutoModeCall(
      call('bash', { command: 'rm -rf build/old' }),
      context(projectRoot),
    );

    expect(move.review.operations).toEqual([
      expect.objectContaining({
        kind: 'move',
        source: expect.objectContaining({ path: 'src/a.txt' }),
        destination: expect.objectContaining({ path: 'build/a.txt' }),
      }),
    ]);
    expect(remove.review.operations).toEqual([
      expect.objectContaining({
        kind: 'delete',
        target: expect.objectContaining({ path: 'build/old' }),
      }),
    ]);
  });

  it.each(['/tmp', '/home'])(
    'keeps a single-segment POSIX absolute path as an rm target: %s',
    (target) => {
      const projectRoot = createRoot('kodax-auto-rules-project-');
      const assessment = assessAutoModeCall(
        call('bash', { command: `rm ${target}` }),
        context(projectRoot),
      );

      expect(assessment.review.operations).toEqual([
        expect.objectContaining({
          kind: 'delete',
          target: expect.objectContaining({ path: target }),
        }),
      ]);
    },
  );

  it('still recognizes a documented Windows copy switch', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command: 'copy /y src/a.txt build/a.txt' }),
      context(projectRoot),
    );

    expect(assessment.review.operations).toEqual([
      expect.objectContaining({
        kind: 'copy',
        source: expect.objectContaining({ path: 'src/a.txt' }),
        destination: expect.objectContaining({ path: 'build/a.txt' }),
        options: expect.objectContaining({ force: true }),
      }),
    ]);
  });

  it('marks unknown PowerShell parameter binding incomplete instead of guessing', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(
      call('bash', { command: 'Copy-Item -Unknown value src/a.txt build/b.txt' }),
      context(projectRoot),
    );

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.analysis).toMatchObject({
      status: 'incomplete',
      shell: 'powershell',
      binding: 'partial',
    });
  });

  it.each([
    'Set-Content Env:KODAX_FLAG enabled',
    'Remove-Item HKLM:\\Software\\KodaX',
    'Copy-Item src/a.txt build/a.txt -ToSession remote-session',
    'New-Item -ItemType SymbolicLink -Path build/link -Target ../outside',
  ])('never rules-auto-allows a PowerShell mutation with unmodelled effects: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const assessment = assessAutoModeCall(call('bash', { command }), context(projectRoot));

    expect(assessment.decision.action).toBe('escalate');
    expect(assessment.review.analysis.status).toBe('incomplete');
  });

  it('escalates high-risk and unmodelled bash commands instead of guessing', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const dangerous = evaluateAutoRulesCall(
      call('bash', { command: 'git push --force origin main' }),
      context(projectRoot, projectRoot, [
        { kind: 'dangerous_pattern', pattern: 'git push --force', severity: 'high' },
      ]),
    );
    const unmodelled = evaluateAutoRulesCall(
      call('bash', { command: 'node scripts/custom-operation.js' }),
      context(projectRoot),
    );
    expect(dangerous.action).toBe('escalate');
    expect(unmodelled.action).toBe('escalate');
  });

  it.each([
    'echo no > $HOME/outside.txt',
    'echo no > $UNRESOLVED/outside.txt',
    'echo no > %USERPROFILE%/outside.txt',
  ])('escalates shell-expanded target instead of treating it as a lexical workspace path: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    expect(evaluateAutoRulesCall(call('bash', { command }), context(projectRoot)).action)
      .toBe('escalate');
  });

  it.each([
    'node scripts/custom-operation.js > reports/output.txt',
    'node scripts/custom-operation.js && echo ok > reports/output.txt',
  ])('escalates a shell command with unmodelled effects even when one output is in-boundary: %s', (command) => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    expect(evaluateAutoRulesCall(call('bash', { command }), context(projectRoot)).action)
      .toBe('escalate');
  });

  it('escalates unknown tools even when they carry an in-workspace path field', () => {
    const projectRoot = createRoot('kodax-auto-rules-project-');
    const decision = evaluateAutoRulesCall(
      call('extension_writer', { path: 'src/inside.ts' }),
      context(projectRoot),
    );
    expect(decision.action).toBe('escalate');
  });
});
