import fsPromises from 'node:fs/promises';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getRepoIntelligenceIndex as getSemanticRepoIntelligenceIndex,
  getRepoRoutingSignals as getSemanticRepoRoutingSignals,
} from './semantic-index.js';
import { analyzeTypeScriptFiles } from './semantic-typescript-analyzer.js';
import { MAX_SYMBOLS_PER_FILE } from './semantic-shared.js';
import type { RepoAreaOverview } from './public-bridge.js';

type RepoContext = { executionCwd?: string; gitRoot?: string };
type LightQueryOptions = { targetPath?: string; refresh?: boolean };

function getRepoIntelligenceIndex(
  context: RepoContext,
  options: LightQueryOptions = {},
) {
  return getSemanticRepoIntelligenceIndex(context, { ...options, profile: 'light' });
}

function getRepoRoutingSignals(
  context: RepoContext,
  options: LightQueryOptions = {},
) {
  return getSemanticRepoRoutingSignals(context, { ...options, profile: 'light' });
}

function createIncrementalFixture(workspaceRoot: string): void {
  mkdirSync(join(workspaceRoot, 'packages', 'app', 'src'), { recursive: true });
  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'workspace-root' }, null, 2));
  writeFileSync(join(workspaceRoot, 'packages', 'app', 'package.json'), JSON.stringify({ name: '@demo/app' }, null, 2));
  writeFileSync(
    join(workspaceRoot, 'packages', 'app', 'src', 'helper.ts'),
    [
      'export function formatName(name: string): string {',
      '  return name.trim().toUpperCase();',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(workspaceRoot, 'packages', 'app', 'src', 'index.ts'),
    [
      "import { formatName } from './helper';",
      '',
      'export function runApp(name: string): string {',
      '  return formatName(name);',
      '}',
      '',
    ].join('\n'),
  );
}

function createJavaCppFixture(workspaceRoot: string): void {
  mkdirSync(join(workspaceRoot, 'java', 'com', 'demo'), { recursive: true });
  mkdirSync(join(workspaceRoot, 'cpp'), { recursive: true });
  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'workspace-root' }, null, 2));
  writeFileSync(
    join(workspaceRoot, 'java', 'com', 'demo', 'Controller.java'),
    [
      'package com.demo;',
      '',
      'public interface ServiceContract {',
      '  String run();',
      '}',
      '',
      'public enum ExecutionMode {',
      '  FAST,',
      '  SAFE,',
      '}',
      '',
      'public class Controller {',
      '  public String execute(ServiceContract service) {',
      '    return service.run();',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(workspaceRoot, 'cpp', 'worker.h'),
    [
      '#pragma once',
      '',
      'struct WorkerConfig {',
      '  int retries;',
      '};',
      '',
      'enum class RunMode {',
      '  Fast,',
      '  Safe,',
      '};',
      '',
      'class Worker {',
      'public:',
      '  int run();',
      '};',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(workspaceRoot, 'cpp', 'worker.cpp'),
    [
      '#include "worker.h"',
      '',
      'int Worker::run() {',
      '  return helper();',
      '}',
      '',
      'int helper() {',
      '  return 1;',
      '}',
      '',
    ].join('\n'),
  );
}

describe('light-profile repo-intelligence index', () => {
  let tempDir = '';

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('reuses cached file analyses for unchanged source files during incremental refresh', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-ri-incremental-'));
    createIncrementalFixture(tempDir);

    await getRepoIntelligenceIndex({ executionCwd: tempDir }, { refresh: true });

    writeFileSync(
      join(tempDir, 'packages', 'app', 'src', 'index.ts'),
      [
        "import { formatName } from './helper';",
        '',
        'export function runApp(name: string): string {',
        "  return `hello ${formatName(name)}`;",
        '}',
        '',
      ].join('\n'),
    );

    const readSpy = vi.spyOn(fsPromises, 'readFile');
    const index = await getRepoIntelligenceIndex({ executionCwd: tempDir }, { refresh: false });
    const sourceReads = readSpy.mock.calls
      .map(([filePath]) => String(filePath).replace(/\\/g, '/'))
      .filter((filePath) =>
        filePath.endsWith('/packages/app/src/index.ts')
        || filePath.endsWith('/packages/app/src/helper.ts'),
      );

    expect(index.symbols.some((symbol) => symbol.name === 'runApp')).toBe(true);
    expect(sourceReads.some((filePath) => filePath.endsWith('/packages/app/src/index.ts'))).toBe(true);
    expect(sourceReads.some((filePath) => filePath.endsWith('/packages/app/src/helper.ts'))).toBe(false);
  }, 15000);

  it('extracts Java/C++ structural semantics through the shared light profile', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-ri-java-cpp-'));
    createJavaCppFixture(tempDir);

    const index = await getRepoIntelligenceIndex({ executionCwd: tempDir }, { refresh: true });
    const picked = index.symbols.map((symbol) => `${symbol.kind}:${symbol.name}:${symbol.language}`);

    expect(picked).toEqual(expect.arrayContaining([
      'interface:ServiceContract:java',
      'enum:ExecutionMode:java',
      'class:Controller:java',
      'struct:WorkerConfig:cpp',
      'enum:RunMode:cpp',
      'class:Worker:cpp',
      'method:run:cpp',
      'function:helper:cpp',
    ]));
    expect(index.languages).toEqual(expect.arrayContaining([
      expect.objectContaining({ language: 'java', capabilityTier: 'medium' }),
      expect.objectContaining({ language: 'cpp', capabilityTier: 'low' }),
    ]));
  }, 15000);

  it('caps TypeScript symbols per file in the analyzer', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-ri-ts-symbol-cap-'));
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    const filePath = 'src/many.ts';
    writeFileSync(
      join(tempDir, filePath),
      Array.from(
        { length: MAX_SYMBOLS_PER_FILE + 5 },
        (_, index) => `export function f${index}(): number { return ${index}; }`,
      ).join('\n'),
    );
    const areas: RepoAreaOverview[] = [{
      id: 'root',
      label: 'root',
      kind: 'root',
      root: '.',
      fileCount: 1,
      manifests: [],
      sampleFiles: [filePath],
    }];

    const analyses = await analyzeTypeScriptFiles(
      tempDir,
      [filePath],
      areas,
      new Set([filePath]),
      new Map(),
    );

    expect(analyses[0]?.symbols).toHaveLength(MAX_SYMBOLS_PER_FILE);
    expect(analyses[0]?.symbols.map((symbol) => symbol.name)).toContain(`f${MAX_SYMBOLS_PER_FILE - 1}`);
    expect(analyses[0]?.symbols.map((symbol) => symbol.name)).not.toContain(`f${MAX_SYMBOLS_PER_FILE}`);
  }, 15000);

  it('derives routing lowConfidence from active module and impact confidence', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-ri-routing-derived-'));
    createIncrementalFixture(tempDir);

    const routingSignals = await getRepoRoutingSignals({
      executionCwd: tempDir,
    }, {
      targetPath: 'packages/app',
      refresh: true,
    });

    expect(routingSignals.lowConfidence).toBe(
      routingSignals.activeModuleConfidence < 0.72
      || routingSignals.activeImpactConfidence < 0.72,
    );

    expect(routingSignals.activeModuleConfidence).toBeLessThan(0.72);
    expect(routingSignals.lowConfidence).toBe(true);
  }, 15000);
});
