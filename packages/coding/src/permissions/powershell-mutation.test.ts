import { describe, expect, it } from 'vitest';
import { analyzePowerShellMutation } from './powershell-mutation.js';

describe('analyzePowerShellMutation', () => {
  it('binds named parameters independently of their order', () => {
    expect(analyzePowerShellMutation([
      'Out-File', '-InputObject', 'data', '-FilePath', 'D:/outside.txt', '-Append',
    ])).toEqual({
      status: 'complete',
      operations: [{
        kind: 'write',
        target: 'D:/outside.txt',
        options: { force: false, append: true },
      }],
    });
  });

  it('resolves unambiguous parameter abbreviations', () => {
    expect(analyzePowerShellMutation([
      'Copy-Item', '-Path', 'src/a.txt', '-Dest', 'build/a.txt',
    ])).toMatchObject({
      status: 'complete',
      operations: [{ kind: 'copy', source: 'src/a.txt', destination: 'build/a.txt' }],
    });
  });

  it('preserves an explicit false switch value', () => {
    expect(analyzePowerShellMutation([
      'Move-Item', '-Force:$false', 'src/a.txt', 'build/a.txt',
    ])).toMatchObject({
      status: 'complete',
      operations: [{ kind: 'move', options: { force: false } }],
    });
  });

  it('preserves WhatIf as a non-mutating operation fact', () => {
    expect(analyzePowerShellMutation([
      'Set-Content', '-WhatIf', '-Value', 'data', 'D:/outside.txt',
    ])).toMatchObject({
      status: 'complete',
      operations: [{ kind: 'write', options: { whatIf: true } }],
    });
  });

  it('expands static Path arrays into independently reviewable operations', () => {
    expect(analyzePowerShellMutation([
      'Remove-Item', '-Path', 'one.txt,two.txt',
    ])).toMatchObject({
      status: 'complete',
      operations: [
        { kind: 'delete', target: 'one.txt' },
        { kind: 'delete', target: 'two.txt' },
      ],
    });
    expect(analyzePowerShellMutation([
      'Set-Content', '-Path', 'sessions/a.json,tool-results/b.txt', '-Value', 'data',
    ])).toMatchObject({
      status: 'complete',
      operations: [
        { kind: 'write', target: 'sessions/a.json' },
        { kind: 'write', target: 'tool-results/b.txt' },
      ],
    });
  });

  it('rejects bracket wildcards for Path while preserving exact LiteralPath targets', () => {
    expect(analyzePowerShellMutation([
      'Set-Content', '-Path', '[.]kodax/config.json', '-Value', 'data',
    ])).toMatchObject({ status: 'incomplete' });
    expect(analyzePowerShellMutation([
      'Set-Content', '-LiteralPath', 'build/file[12].txt', '-Value', 'data',
    ])).toMatchObject({
      status: 'complete',
      operations: [{ kind: 'write', target: 'build/file[12].txt' }],
    });
  });

  it.each([
    ['Copy-Item', '-Path', '.', '-Filter', '.env', '-Recurse', '-Destination', 'build'],
    ['Copy-Item', '-Path', '.', '-Include', '*.env', '-Recurse', '-Destination', 'build'],
    ['Move-Item', '-Path', '.', '-Exclude', 'ordinary.txt', '-Destination', 'build'],
    ['Remove-Item', '-Path', '.', '-Filter', '.env', '-Recurse'],
    ['Set-Content', '-Path', '.', '-Filter', '.env', '-Value', 'x'],
    ['Add-Content', '-Path', '.', '-Include', '.env', '-Value', 'x'],
  ])('does not claim an exact target set when a provider selector is bound: %s', (...argv) => {
    const result = analyzePowerShellMutation(argv);
    expect(result).toMatchObject({
      status: 'incomplete',
    });
    expect(result.operations).toHaveLength(1);
  });

  it('composes New-Item -Path and -Name into the created target', () => {
    expect(analyzePowerShellMutation([
      'New-Item', '-ItemType', 'File', '-Path', 'build', '-Name', 'report.txt',
    ])).toMatchObject({
      status: 'complete',
      operations: [{ kind: 'create', target: 'build/report.txt' }],
    });
  });

  it.each(['SymbolicLink', 'Junction', 'HardLink'])(
    'keeps New-Item link type %s incomplete until the target relationship is modeled',
    (itemType) => {
      expect(analyzePowerShellMutation([
        'New-Item', '-ItemType', itemType, '-Path', 'build/link', '-Target', '../outside',
      ])).toMatchObject({ status: 'incomplete' });
    },
  );

  it('preserves recursive copy semantics in the operation facts', () => {
    expect(analyzePowerShellMutation([
      'Copy-Item', '-Recurse', 'src/assets', 'build/assets',
    ])).toMatchObject({
      status: 'complete',
      operations: [{ kind: 'copy', options: { recursive: true } }],
    });
  });

  it('keeps unknown parameter combinations fail-closed', () => {
    expect(analyzePowerShellMutation([
      'Set-Content', '-Unknown', 'data', 'outside.txt',
    ])).toMatchObject({ status: 'incomplete', operations: [] });
    expect(analyzePowerShellMutation([
      'Copy-Item', '-Target', 'not-a-copy-parameter', 'src/a.txt', 'build/a.txt',
    ])).toMatchObject({ status: 'incomplete', operations: [] });
  });

  it('keeps Rename-Item in the source directory and supports Windows paths', () => {
    expect(analyzePowerShellMutation([
      'Rename-Item', '-LiteralPath', 'C:\\repo\\a.txt', '-NewName', 'b.txt', '-Force:$true',
    ])).toMatchObject({
      status: 'complete',
      operations: [{
        kind: 'rename',
        source: 'C:\\repo\\a.txt',
        destination: 'C:\\repo\\b.txt',
        options: { force: true },
      }],
    });
  });

  it('derives the current-directory destination when Copy-Item omits it', () => {
    expect(analyzePowerShellMutation(['Copy-Item', 'src/report.txt'])).toMatchObject({
      status: 'complete',
      operations: [{ kind: 'copy', source: 'src/report.txt', destination: 'report.txt' }],
    });
  });

  it('rejects unsupported switch values and invalid rename destinations', () => {
    expect(analyzePowerShellMutation([
      'Move-Item', '-Force:maybe', 'a.txt', 'b.txt',
    ])).toMatchObject({ status: 'incomplete' });
    expect(analyzePowerShellMutation([
      'Rename-Item', 'a.txt', '../b.txt',
    ])).toMatchObject({ status: 'incomplete' });
  });

  it('rejects repeated bindings and excess positional arguments', () => {
    expect(analyzePowerShellMutation([
      'Remove-Item', '-Path', 'a.txt', '-Path', 'b.txt',
    ])).toMatchObject({ status: 'incomplete' });
    expect(analyzePowerShellMutation([
      'Out-File', 'a.txt', 'utf8', 'unexpected.txt',
    ])).toMatchObject({ status: 'incomplete' });
  });

  it.each([
    ['Set-Content', 'Env:KODAX_FLAG', 'enabled'],
    ['Remove-Item', 'HKLM:\\Software\\KodaX'],
    ['New-Item', 'Registry::HKEY_CURRENT_USER\\Software\\KodaX'],
  ])('does not classify PowerShell provider targets as local filesystem paths: %s %s', (...argv) => {
    expect(analyzePowerShellMutation(argv)).toMatchObject({ status: 'incomplete' });
  });

  it.each(['-ToSession', '-FromSession'])(
    'keeps Copy-Item %s incomplete because the parameter changes the target host',
    (sessionParameter) => {
      expect(analyzePowerShellMutation([
        'Copy-Item', 'src/a.txt', 'build/a.txt', sessionParameter, 'remote-session',
      ])).toMatchObject({ status: 'incomplete' });
    },
  );

  it.each([
    [['Out-File', '-LiteralPath', 'build/out.txt', '-Encoding', 'utf8'], 'write'],
    [['Remove-Item', '-PSPath', 'build/a.txt', '-Stream', 'Zone.Identifier', '-UseTx'], 'delete'],
    [['New-Item', '-Type', 'File', 'build/a.txt', '-WhatIf'], 'create'],
    [['Rename-Item', '-Credential', 'user', 'build/a.txt', 'b.txt'], 'rename'],
  ] as const)(
    'recognizes supported PowerShell parameter aliases without degrading to incomplete: %s',
    (argv, kind) => {
      expect(analyzePowerShellMutation(argv)).toMatchObject({
        status: 'complete', operations: [{ kind }],
      });
    },
  );
});
