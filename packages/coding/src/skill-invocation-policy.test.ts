import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyRuntimeSkillInvocationPolicy } from './skill-invocation-policy.js';
import { awaitRuntimeSkillInvocationPolicy } from './skill-invocation-policy.js';
import {
  setKodaXDiagnosticSink,
  SkillRegistry,
  type KodaXDiagnostic,
} from '@kodax-ai/agent';
import type { KodaXOptions } from './types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function nodeCommand(source: string): string {
  return `"${process.execPath}" -e "${source}"`;
}

async function optionsWithSkill(input: {
  readonly allowedTools?: string;
  readonly preToolUse?: string;
  readonly postToolUse?: string;
}): Promise<{ readonly root: string; readonly options: KodaXOptions }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-skill-policy-'));
  tempDirs.push(root);
  const skillDir = path.join(root, '.kodax', 'skills', 'transport-skill');
  await mkdir(skillDir, { recursive: true });
  const hookLines = input.preToolUse || input.postToolUse
    ? [
        'hooks:',
        ...(input.preToolUse
          ? ['  PreToolUse:', '    - matcher: read', `      command: ${JSON.stringify(input.preToolUse)}`]
          : []),
        ...(input.postToolUse
          ? ['  PostToolUse:', '    - matcher: read', `      command: ${JSON.stringify(input.postToolUse)}`]
          : []),
      ]
    : [];
  await writeFile(path.join(skillDir, 'SKILL.md'), [
    '---',
    'name: transport-skill',
    'description: Transport policy test',
    ...(input.allowedTools ? [`allowed-tools: ${input.allowedTools}`] : []),
    ...hookLines,
    '---',
    '',
    'Test.',
  ].join('\n'), 'utf8');
  return {
    root,
    options: {
      provider: 'mock-provider',
      events: { beforeToolExecute: async () => true },
      context: {
        gitRoot: root,
        executionCwd: root,
        skillInvocation: {
          name: 'transport-skill',
          path: path.join(skillDir, 'SKILL.md'),
          expandedContent: '<skill name="transport-skill">test</skill>',
          runtimePolicy: { enforceAtRuntime: true },
        },
      },
    },
  };
}

describe('applyRuntimeSkillInvocationPolicy', () => {
  it('rehydrates allowed-tools from the trusted runtime Skill', async () => {
    const fixture = await optionsWithSkill({ allowedTools: 'read' });
    const options = await applyRuntimeSkillInvocationPolicy(fixture.options);

    await expect(options.events?.beforeToolExecute?.('read', {})).resolves.toBe(true);
    await expect(options.events?.beforeToolExecute?.('write', {})).resolves.toContain(
      "Tool 'write' is not allowed",
    );
    expect(options.context?.skillInvocation?.runtimePolicy?.enforceAtRuntime).toBe(false);
  });

  it('runs trusted PreToolUse hooks before tool execution', async () => {
    const fixture = await optionsWithSkill({
      preToolUse: nodeCommand('process.stdout.write(JSON.stringify({allow:false}))'),
    });
    const admit = vi.fn(async () => true);
    fixture.options.events = { beforeToolExecute: admit };
    const options = await applyRuntimeSkillInvocationPolicy(fixture.options);

    await expect(options.events?.beforeToolExecute?.('read', {})).resolves.toContain(
      "PreToolUse hook blocked 'read'",
    );
    await expect(options.events?.beforeToolExecute?.('write', {})).resolves.toBe(true);
    expect(admit).toHaveBeenCalledWith(
      'bash',
      expect.objectContaining({ _frontmatterHook: true, _hookEvent: 'PreToolUse' }),
    );
  });

  it('fails closed when an isolated PreToolUse hook has no runtime permission broker', async () => {
    const fixture = await optionsWithSkill({
      preToolUse: nodeCommand('process.stdout.write(JSON.stringify({allow:true}))'),
    });
    fixture.options.events = undefined;
    const options = await applyRuntimeSkillInvocationPolicy(fixture.options);

    await expect(options.events?.beforeToolExecute?.('read', {})).resolves.toContain(
      "PreToolUse hook blocked 'read'",
    );
  });

  it('runs trusted PostToolUse hooks after a tool result', async () => {
    const markerRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-skill-hook-marker-'));
    tempDirs.push(markerRoot);
    const marker = path.join(markerRoot, 'post-hook.txt');
    const encodedMarker = Buffer.from(marker, 'utf8').toString('base64');
    const fixture = await optionsWithSkill({
      postToolUse: nodeCommand(
        `require('node:fs').writeFileSync(Buffer.from('${encodedMarker}','base64').toString(),'done')`,
      ),
    });
    const options = await applyRuntimeSkillInvocationPolicy(fixture.options);

    options.events?.onToolResult?.({ id: 'tool-1', name: 'read', content: 'ok' });
    await awaitRuntimeSkillInvocationPolicy(options);
    await expect(readFile(marker, 'utf8')).resolves.toBe('done');
  });

  it('waits for delayed PostToolUse hooks before runtime completion', async () => {
    const markerRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-delayed-hook-marker-'));
    tempDirs.push(markerRoot);
    const marker = path.join(markerRoot, 'post-hook.txt');
    const encodedMarker = Buffer.from(marker, 'utf8').toString('base64');
    const fixture = await optionsWithSkill({
      postToolUse: nodeCommand(
        `setTimeout(()=>require('node:fs').writeFileSync(Buffer.from('${encodedMarker}','base64').toString(),'done'),80)`,
      ),
    });
    const options = await applyRuntimeSkillInvocationPolicy(fixture.options);

    options.events?.onToolResult?.({ id: 'tool-1', name: 'read', content: 'ok' });
    await awaitRuntimeSkillInvocationPolicy(options);

    await expect(readFile(marker, 'utf8')).resolves.toBe('done');
  });

  it('runs PostToolUse hooks even when the base result observer throws', async () => {
    const markerRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-post-hook-finally-'));
    tempDirs.push(markerRoot);
    const marker = path.join(markerRoot, 'post-hook.txt');
    const encodedMarker = Buffer.from(marker, 'utf8').toString('base64');
    const fixture = await optionsWithSkill({
      postToolUse: nodeCommand(
        `require('node:fs').writeFileSync(Buffer.from('${encodedMarker}','base64').toString(),'done')`,
      ),
    });
    fixture.options.events = {
      beforeToolExecute: async () => true,
      onToolResult: () => { throw new Error('injected result observer failure'); },
    };
    const options = await applyRuntimeSkillInvocationPolicy(fixture.options);

    expect(() => options.events?.onToolResult?.({ id: 'tool-1', name: 'read', content: 'ok' }))
      .toThrow('injected result observer failure');
    await awaitRuntimeSkillInvocationPolicy(options);
    await expect(readFile(marker, 'utf8')).resolves.toBe('done');
  });

  it('diagnoses invalid allowed-tools entries while preserving fail-closed enforcement', async () => {
    const diagnostics: KodaXDiagnostic[] = [];
    const restore = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));
    try {
      const fixture = await optionsWithSkill({ allowedTools: 'read, imaginary-tool' });
      const options = await applyRuntimeSkillInvocationPolicy(fixture.options);

      await expect(options.events?.beforeToolExecute?.('read', {})).resolves.toBe(true);
      await expect(options.events?.beforeToolExecute?.('write', {})).resolves.toContain('not allowed');
      expect(diagnostics).toContainEqual(expect.objectContaining({
        level: 'warn',
        message: expect.stringContaining('invalid allowed-tools'),
      }));
    } finally {
      restore();
    }
  });

  it('diagnoses malformed hook output without treating it as an allow decision', async () => {
    const diagnostics: KodaXDiagnostic[] = [];
    const restore = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));
    try {
      const fixture = await optionsWithSkill({
        preToolUse: nodeCommand("process.stdout.write('not-json')"),
      });
      const options = await applyRuntimeSkillInvocationPolicy(fixture.options);

      await expect(options.events?.beforeToolExecute?.('read', {})).resolves.toBe(true);
      expect(diagnostics).toContainEqual(expect.objectContaining({
        level: 'warn',
        message: expect.stringContaining('invalid JSON'),
      }));
    } finally {
      restore();
    }
  });

  it('treats a bound registry as authoritative when it excludes the named Skill', async () => {
    const fixture = await optionsWithSkill({});
    const restrictedRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-restricted-registry-'));
    tempDirs.push(restrictedRoot);
    const restrictedRegistry = new SkillRegistry(restrictedRoot);
    await restrictedRegistry.discover();
    fixture.options.context!.skillRegistry = restrictedRegistry;

    await expect(applyRuntimeSkillInvocationPolicy(fixture.options)).rejects.toThrow(
      'absent from the bound Skill registry',
    );
  });

  it('fails closed when the transport names a Skill absent from trusted discovery', async () => {
    const fixture = await optionsWithSkill({});
    fixture.options.context!.skillInvocation!.name = 'untrusted-skill';

    await expect(applyRuntimeSkillInvocationPolicy(fixture.options)).rejects.toThrow(
      'Cannot rehydrate runtime policy for unknown Skill',
    );
  });
});
