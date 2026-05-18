#!/usr/bin/env node
// .d.ts bundler for SDK exports (v0.7.41).
//
// Replaces the trailing `tsc --emitDeclarationOnly` step in `npm run build`.
//
// Why: tsc --emitDeclarationOnly emits dist/index.d.ts and dist/sdk-*.d.ts as
// literal pass-throughs:
//   `export * from '@kodax-ai/coding'`
// The published @kodax-ai/kodax tarball does NOT ship the internal @kodax-ai/*
// sub-packages (esbuild already inlined them into dist/*.js), so consumer-side
// `tsc` reading those .d.ts files fails to resolve @kodax-ai/coding etc. with
// "no exported member" — even though the runtime import works.
//
// Fix: bundle the 6 SDK entry .d.ts the same way esbuild bundles their .js,
// using rollup-plugin-dts with code-splitting. The output is self-contained:
// no residual @kodax-ai/* imports, only third-party externals stay as imports
// (consumers npm-install those anyway via root package.json#dependencies).
//
// Outputs (overwriting tsc's prior emit):
//   dist/index.d.ts
//   dist/sdk-agent.d.ts
//   dist/sdk-llm.d.ts
//   dist/sdk-coding.d.ts
//   dist/sdk-repl.d.ts
//   dist/sdk-skills.d.ts
//   dist/types-chunks/*.d.ts     ← shared chunks (mirrors esbuild splitting)
//
// External list mirrors build-bundle.mjs: anything in root dependencies stays
// as a bare `import { X } from 'pkg'` in the bundled .d.ts (third-party types
// resolve via consumer node_modules). Node built-ins also external.
//
// See docs/ADR.md ADR-022 + ADR-024 for the SDK distribution architecture.

import { rollup } from 'rollup';
import dts from 'rollup-plugin-dts';
import { readFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, 'dist');

function log(msg) {
  console.log(`[build-dts] ${msg}`);
}

const rootPkg = JSON.parse(
  readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
);
const thirdPartyDeps = new Set(Object.keys(rootPkg.dependencies || {}));

// External callback: bundle internal @kodax-ai/* + relative imports; everything
// else (third-party + Node built-ins) stays as an external `import` in the
// bundled .d.ts (consumer-side npm install resolves them).
function isExternal(id) {
  // Relative or absolute path imports → bundle (these resolve through the
  // workspace, including @kodax-ai/* symlinks under node_modules/).
  if (id.startsWith('.') || path.isAbsolute(id)) return false;

  // Internal sub-packages → bundle inline. The tarball does NOT ship them, so
  // their types MUST be inlined into dist/*.d.ts.
  if (id.startsWith('@kodax-ai/')) return false;

  // Node built-ins → external (consumer's tsc resolves via @types/node).
  if (id.startsWith('node:') || isBuiltin(id)) return true;

  // Third-party: bare specifier matching root deps (or its subpath like
  // `react/jsx-runtime`) → external. Consumer npm-installs them.
  const root = id.startsWith('@')
    ? id.split('/').slice(0, 2).join('/')
    : id.split('/')[0];
  return thirdPartyDeps.has(root);
}

const sdkEntries = {
  index: 'src/index.ts',
  'sdk-agent': 'src/sdk-agent.ts',
  'sdk-llm': 'src/sdk-llm.ts',
  'sdk-coding': 'src/sdk-coding.ts',
  'sdk-repl': 'src/sdk-repl.ts',
  'sdk-skills': 'src/sdk-skills.ts',
};

// Clean prior tsc emit so stale per-file .d.ts (acp_*.d.ts, cli_commands.d.ts,
// kodax_cli.d.ts, *.test.d.ts) don't ship. Only the 6 SDK entries + chunks
// remain after this script.
function cleanStaleEmit() {
  log('Cleaning stale dist/*.d.ts (prior tsc emit)…');
  let removed = 0;
  for (const entry of readdirSync(distDir)) {
    const full = path.join(distDir, entry);
    if (!statSync(full).isFile()) continue;
    if (entry.endsWith('.d.ts') || entry.endsWith('.d.ts.map')) {
      unlinkSync(full);
      removed += 1;
    }
  }
  // Also nuke prior types-chunks/ (if a prior build left a partial set).
  rmSync(path.join(distDir, 'types-chunks'), { recursive: true, force: true });
  log(`  ✓ removed ${removed} stale top-level *.d.ts file(s)`);
}

async function main() {
  cleanStaleEmit();

  log(`Bundling ${Object.keys(sdkEntries).length} SDK entry types…`);

  const bundle = await rollup({
    input: Object.fromEntries(
      Object.entries(sdkEntries).map(([name, p]) => [
        name,
        path.join(repoRoot, p),
      ]),
    ),
    external: isExternal,
    // respectExternal: don't try to inline third-party type definitions even
    // if they happen to be resolvable on disk. Keeps the bundle scoped to
    // first-party (@kodax-ai/*) + local src code.
    plugins: [dts({ respectExternal: true })],
    // Silence Rollup's "unused external import" warnings only — type
    // re-exports legitimately produce these (e.g. `export type { X } from
    // 'pkg'` where X is the only consumer). Do NOT silence other warnings
    // (especially EMPTY_BUNDLE) — those signal real bugs (entry produced
    // zero output) and must be surfaced.
    onwarn(warning, warn) {
      if (warning.code === 'UNUSED_EXTERNAL_IMPORT') return;
      warn(warning);
    },
  });

  await bundle.write({
    dir: distDir,
    format: 'es',
    entryFileNames: '[name].d.ts',
    chunkFileNames: 'types-chunks/[name]-[hash].d.ts',
  });
  await bundle.close();

  // Report sizes — failing on missing entry catches incomplete bundle output
  // that rollup might emit silently if a plugin misbehaves.
  for (const name of Object.keys(sdkEntries)) {
    const p = path.join(distDir, `${name}.d.ts`);
    const bytes = statSync(p).size;
    log(`  ✓ dist/${name}.d.ts (${(bytes / 1024).toFixed(1)} kB)`);
  }
  log('Done. dist/*.d.ts are self-contained (no @kodax-ai/* imports).');
}

main().catch((err) => {
  console.error('[build-dts] ERROR', err.stack || err.message);
  process.exit(1);
});
