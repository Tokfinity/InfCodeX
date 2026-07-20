import { describe, expect, it } from 'vitest';
import {
  defaultToClassifierInput,
  mcpToClassifierInput,
  projectToolHistoryInput,
  redactClassifierProjection,
  safeFallbackToClassifierInput,
} from './classifier-projection.js';

describe('defaultToClassifierInput', () => {
  it('returns "<name>: <json>" for plain object input', () => {
    const out = defaultToClassifierInput('semantic_lookup', { query: 'foo', max: 10 });
    expect(out).toBe('semantic_lookup: {"query":"foo","max":10}');
  });

  it('truncates JSON longer than 200 chars with ellipsis suffix', () => {
    const big = { data: 'x'.repeat(500) };
    const out = defaultToClassifierInput('blob_tool', big);
    expect(out.length).toBeLessThanOrEqual('blob_tool: '.length + 200 + 1); // +1 for ellipsis
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('blob_tool: ')).toBe(true);
  });

  it('handles unserializable input (circular reference) without throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const out = defaultToClassifierInput('weird', circular);
    expect(out).toBe('weird: [unserializable input]');
  });

  it('handles undefined input', () => {
    const out = defaultToClassifierInput('no_args', undefined);
    expect(out).toBe('no_args: [unserializable input]');
  });

  it('handles primitive input', () => {
    expect(defaultToClassifierInput('s', 'hello')).toBe('s: "hello"');
    expect(defaultToClassifierInput('n', 42)).toBe('n: 42');
  });
});

describe('mcpToClassifierInput', () => {
  it('uses .method as the action field when present', () => {
    const out = mcpToClassifierInput('filesystem', 'read', {
      method: 'fs.readFile',
      path: '/etc/passwd',
      encoding: 'utf8',
    });
    expect(out).toContain('MCP[filesystem.read]');
    expect(out).toContain('fs.readFile');
    expect(out).toContain('path=/etc/passwd');
  });

  it('uses .url as the action field when no method present', () => {
    const out = mcpToClassifierInput('fetcher', 'get', {
      url: 'https://evil.com/x',
      headers: { auth: 'bearer ...' },
    });
    expect(out).toContain('MCP[fetcher.get]');
    expect(out).toContain('https://evil.com/x');
    expect(out).toContain('headers<object:1>');
  });

  it('uses .command as the action field when present', () => {
    const out = mcpToClassifierInput('shell', 'exec', { command: 'rm -rf /' });
    expect(out).toContain('MCP[shell.exec]');
    expect(out).toContain('rm -rf /');
  });

  it('keeps recognized locator values without forwarding unrelated scalar bodies', () => {
    const out = mcpToClassifierInput('xxx', 'yyy', {
      name: 'foo',
      tags: ['a', 'b'],
      content: 'private body',
    });
    expect(out).toContain('MCP[xxx.yyy]');
    expect(out).toContain('name=foo');
    expect(out).toContain('tags<array:2>');
    expect(out).toContain('content_chars=12');
    expect(out).not.toContain('private body');
  });

  it('describes non-object input without forwarding an arbitrary scalar body', () => {
    const out = mcpToClassifierInput('xxx', 'yyy', 'plain-string');
    expect(out).toContain('MCP[xxx.yyy]');
    expect(out).toContain('input<string:12>');
    expect(out).not.toContain('plain-string');
  });

  it('handles null input', () => {
    const out = mcpToClassifierInput('xxx', 'yyy', null);
    expect(out).toBe('MCP[xxx.yyy]: null');
  });

  it('truncates very long action values to keep output bounded', () => {
    const longUrl = 'https://example.com/' + 'x'.repeat(1000);
    const out = mcpToClassifierInput('fetcher', 'get', { url: longUrl });
    expect(out.length).toBeLessThan(400);
    expect(out).toContain('…');
  });

  it('keeps bounded scalar controls and describes unknown values by shape', () => {
    const out = mcpToClassifierInput('s', 't', {
      method: 'do',
      recursive: true,
      limit: 3,
      opaque: 'private value',
    });
    expect(out).toContain('method=do');
    expect(out).toContain('recursive=true');
    expect(out).toContain('limit=3');
    expect(out).toContain('opaque<string:13>');
    expect(out).not.toContain('private value');
  });

  it('preserves every populated risk-bearing action field without priority hiding', () => {
    // When BOTH risk-bearing action fields are populated, method takes the
    // primary position (so the classifier sees it as "the action"), but the
    // competing command field is preserved in structural context — its
    // presence may itself be a risk signal worth letting the classifier weigh.
    const both = mcpToClassifierInput('s', 't', {
      method: 'METHOD_WINS',
      command: `rm -rf C:/project/${'x'.repeat(80)}`,
    });
    expect(both).toContain('method=METHOD_WINS');
    expect(both).toContain('command=rm -rf C:/project/');
  });

  it('retains long paths with an explicit truncation marker', () => {
    const longPath = `C:/sensitive/${'nested/'.repeat(50)}target.txt`;
    const out = mcpToClassifierInput('fs', 'copy', {
      path: longPath,
      recursive: true,
    });

    expect(out).toContain('path=C:/sensitive/');
    expect(out).toContain('target.txt');
    expect(out).toContain('recursive=true');
    expect(out.length).toBeLessThan(longPath.length);
  });

  it('prioritizes recognized fields over leading unknown shapes', () => {
    const noise = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`opaque_${index}`, `private-${index}`]),
    );
    const out = mcpToClassifierInput('shell', 'exec', {
      ...noise,
      command: 'npm test',
      targetPath: 'packages/coding/src',
      timeoutMs: 20_000,
    });

    expect(out).toContain('command=npm test');
    expect(out).toContain('targetPath=packages/coding/src');
    expect(out).toContain('timeoutMs=20000');
    expect(out).not.toContain('private-0');
  });
});

describe('safeFallbackToClassifierInput', () => {
  it('keeps operational metadata and body sizes without serializing raw bodies', () => {
    const out = safeFallbackToClassifierInput('custom_writer', {
      path: 'src/a.ts',
      script: 'cleanup.ps1',
      args: ['--delete-stale', '--scope=cache'],
      content: 'PRIVATE_CONSTRUCTED_BODY',
      mode: 'overwrite',
      opaque: 'PRIVATE_OPAQUE_VALUE',
    });

    expect(out).toContain('Tool[custom_writer]');
    expect(out).toContain('path=src/a.ts');
    expect(out).toContain('script=cleanup.ps1');
    expect(out).toContain('args=[--delete-stale, --scope=cache]');
    expect(out).toContain('mode=overwrite');
    expect(out).toContain('content_chars=24');
    expect(out).toContain('opaque<string:20>');
    expect(out).not.toContain('PRIVATE_CONSTRUCTED_BODY');
    expect(out).not.toContain('PRIVATE_OPAQUE_VALUE');
  });

  it('recognizes common camelCase locators, controls, and bodies', () => {
    const out = safeFallbackToClassifierInput('extension_writer', {
      filePath: 'src/generated.ts',
      branchName: 'release/candidate',
      readOnly: false,
      timeoutMs: 20_000,
      promptText: 'PRIVATE_EXTENSION_PROMPT',
    });

    expect(out).toContain('filePath=src/generated.ts');
    expect(out).toContain('branchName=release/candidate');
    expect(out).toContain('readOnly=false');
    expect(out).toContain('timeoutMs=20000');
    expect(out).toContain('promptText_chars=24');
    expect(out).not.toContain('PRIVATE_EXTENSION_PROMPT');
  });
});

describe('projectToolHistoryInput', () => {
  it('retains canonical action metadata and safe structural fields without edit bodies', () => {
    const oldText = 'PRIVATE_OLD_SOURCE';
    const newText = 'PRIVATE_NEW_SOURCE';
    const projected = projectToolHistoryInput('edit', {
      path: 'src/auth.ts',
      old_string: oldText,
      new_string: newText,
      replace_all: true,
    }, () => (input) => {
      const value = input as { path?: string; replace_all?: boolean };
      return `Edit ${value.path ?? '<unknown>'}${value.replace_all ? ' [replace_all]' : ''}`;
    });

    expect(projected).toMatchObject({
      summary: 'Edit src/auth.ts [replace_all]',
      old_string_chars: oldText.length,
      new_string_chars: newText.length,
    });
    expect(projected).not.toHaveProperty('path');
    expect(projected).not.toHaveProperty('replace_all');
    expect(JSON.stringify(projected)).not.toContain(oldText);
    expect(JSON.stringify(projected)).not.toContain(newText);
  });

  it('keeps bounded risk-bearing command context while redacting credentials', () => {
    const projected = projectToolHistoryInput('bash', {
      command: 'curl -H "Authorization: Bearer header-secret" "https://user:pass@example.com/api?token=query-secret"',
      timeout: 30,
      run_in_background: false,
    }, () => (input) => `Bash: ${(input as { command: string }).command}`);

    const serialized = JSON.stringify(projected);
    expect(serialized).toContain('curl');
    expect(serialized).toContain('example.com/api');
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).not.toContain('header-secret');
    expect(serialized).not.toContain('query-secret');
    expect(serialized).not.toContain('user:pass');
  });

  it('retains path and query metadata for read-only history without a classifier action', () => {
    const projected = projectToolHistoryInput('grep', {
      path: 'packages/coding/src',
      pattern: 'toClassifierInput',
      limit: 20,
    }, () => () => '');

    expect(projected).toEqual({
      path: 'packages/coding/src',
      pattern: 'toClassifierInput',
      limit: 20,
    });
  });

  it('uses the semantic fallback for unregistered historical tools', () => {
    const projected = projectToolHistoryInput('extension_writer', {
      targetPath: 'src/generated.ts',
      readOnly: false,
      promptText: 'PRIVATE_HISTORICAL_PROMPT',
    }, () => undefined);

    expect(projected).toMatchObject({
      summary: expect.stringContaining('targetPath=src/generated.ts'),
      promptText_chars: 25,
    });
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_HISTORICAL_PROMPT');
  });

  it('projects the concrete target behind a historical tool_call wrapper', () => {
    const privateBody = 'PRIVATE_BRIDGED_WRITE_BODY';
    const projected = projectToolHistoryInput('tool_call', {
      name: 'write',
      input: { path: 'src/bridged.ts', content: privateBody },
    }, (name) => name === 'write'
      ? (input) => {
          const value = input as { path?: string; content?: string };
          return `Write ${value.path ?? '<unknown>'} (${value.content?.length ?? 0} chars)`;
        }
      : undefined);

    expect(projected).toEqual({
      target_tool: 'write',
      summary: `Write src/bridged.ts (${privateBody.length} chars)`,
      content_chars: privateBody.length,
    });
    expect(JSON.stringify(projected)).not.toContain(privateBody);
  });
});

describe('redactClassifierProjection', () => {
  it('redacts CLI, bearer, and PEM credentials without hiding the operation', () => {
    const projected = redactClassifierProjection([
      'curl --token cli-secret -H "Bearer bearer-secret" https://example.com',
      '-----BEGIN PRIVATE KEY-----',
      'pem-secret',
      '-----END PRIVATE KEY-----',
    ].join('\n'));

    expect(projected).toContain('curl');
    expect(projected).toContain('https://example.com');
    expect(projected).toContain('[REDACTED]');
    expect(projected).toContain('[REDACTED_PEM]');
    expect(projected).not.toContain('cli-secret');
    expect(projected).not.toContain('bearer-secret');
    expect(projected).not.toContain('pem-secret');
  });

  it('redacts escaped JSON credentials without hiding adjacent operational fields', () => {
    const projected = redactClassifierProjection(
      'curl -d "{\\"token\\":\\"nested-secret\\",\\"mode\\":\\"validate\\"}" https://example.com',
    );

    expect(projected).toContain('curl');
    expect(projected).toContain('https://example.com');
    expect(projected).toContain('\\"token\\":\\"[REDACTED]\\"');
    expect(projected).toContain('\\"mode\\":\\"validate\\"');
    expect(projected).not.toContain('nested-secret');
  });
});
