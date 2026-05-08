#!/usr/bin/env node
// FEATURE_150 (v0.7.37) — npm distribution bundle builder.
//
// Produces three artifacts under dist/:
//   1. dist/kodax_cli.js   — CLI entry (bin command runs this)
//   2. dist/index.js       — SDK entry (used by builtin helper scripts;
//                             also exposed via package.json#exports for
//                             path-B SDK consumers)
//   3. dist/builtin-skills/ — verbatim copy of packages/skills/dist/builtin/
//                             (LLM-triggered helper scripts + skill metadata)
//
// All 9 internal @kodax-ai/* sub-packages are inlined into the bundles via
// esbuild's automatic transitive import tracking. All third-party packages
// (and node built-ins) stay external and are listed in root package.json#dependencies.
//
// See docs/ADR.md ADR-022 + docs/HLD.md §12 for architecture rationale.
//
// CONTRACT: dist layout is the helper-script's load contract — DO NOT
// change without updating skills helper scripts that depend on
// '../../../../dist/index.js' relative resolution. See HLD §12.4 risk 3.

import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

// CLI flags
const argv = process.argv.slice(2);
const withSourcemap = argv.includes('--with-sourcemap');
const writeMetafile = argv.includes('--metafile');

// ---- helpers -------------------------------------------------------------

function log(msg) {
  console.log(`[build-bundle] ${msg}`);
}

function readPkg(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

// ---- compute external list from root package.json ------------------------

// Everything in root deps stays external (npm installs them on the user
// machine). Only @kodax-ai/* internal sub-packages get inlined.
// Exception: react-devtools-core is intercepted by stubReactDevtoolsCorePlugin
// before reaching the external check (see plugin docstring above).
const rootPkg = readPkg(path.join(repoRoot, 'package.json'));
const thirdPartyExternals = Object.keys(rootPkg.dependencies || {})
  .filter((name) => name !== 'react-devtools-core');

// Node built-ins are always external by virtue of platform: 'node'.
// We DO NOT external @kodax-ai/* — esbuild will resolve them via
// workspace symlinks (root node_modules has them via npm workspaces)
// and inline transitively.

const external = [...thirdPartyExternals];

log(`External packages: ${external.length} third-party + node built-ins`);

// ---- pre-build prep ------------------------------------------------------

const distDir = path.join(repoRoot, 'dist');
log(`Cleaning ${path.relative(repoRoot, distDir)}`);
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

// Sub-packages must be built first so esbuild can resolve their dist/.
// We rely on `npm run build:packages` having been run upstream; check
// for the canary file packages/coding/dist/index.js.
const codingDistEntry = path.join(repoRoot, 'packages/coding/dist/index.js');
try {
  readFileSync(codingDistEntry);
} catch {
  console.error('[build-bundle] ERROR: packages/coding/dist/index.js missing.');
  console.error('[build-bundle] Run `npm run build:packages` first.');
  process.exit(1);
}

// ---- esbuild plugin: stub react-devtools-core ---------------------------
//
// Vendored ink fork's reconciler.js does:
//   if (isDev()) { await import('./devtools.js'); }
// where devtools.js does `import devtools from 'react-devtools-core'`.
// esbuild inlines the dynamic import target and hoists its react-devtools-core
// import to module top-level. react-devtools-core's CJS backend.js evaluates
// `self.X = ...` on load → ReferenceError: self is not defined under Node.js.
// `isDev()` is a runtime function call so define-based DCE can't eliminate
// the caller-site branch.
//
// Solution: redirect `react-devtools-core` to an empty stub. Production CLI
// path never enters isDev() branch (DEV env var unset), so the stub's
// initialize() / connectToDevTools() are never actually called — they exist
// only for module-load-time linkage.

const stubReactDevtoolsCorePlugin = {
  name: 'stub-react-devtools-core',
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'react-devtools-core-stub',
      namespace: 'stub',
    }));
    build.onLoad({ filter: /^react-devtools-core-stub$/, namespace: 'stub' }, () => ({
      contents: `
        const noop = () => {};
        export default { initialize: noop, connectToDevTools: noop };
        export const initialize = noop;
        export const connectToDevTools = noop;
      `,
      loader: 'js',
    }));
  },
};

// ---- esbuild common options ---------------------------------------------

const commonOptions = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  external,
  // Minify: drop whitespace/identifiers; keep function names for readable
  // stacks. Reduces bundle ~30-40% per HLD §12.4 risk 5 mitigation.
  minify: true,
  keepNames: true,
  // Source map: opt-in via --with-sourcemap. Default off because:
  //   - source maps add ~13 MB unpacked (~3 MB gzipped) to tarball
  //   - path B SDK consumers (rare) can rebuild from GitHub source
  //   - dev mode and `npm run dev` use tsx which has its own source mapping
  // Per HLD §12.4 risk 4: source map is opt-in, not always-on.
  sourcemap: withSourcemap ? 'external' : false,
  // Static replace process.env values so esbuild's DCE eliminates the
  // dev-only `if (isDev())` branch in vendored ink fork. Without this:
  //   - vendored ink reconciler.js imports './devtools.js' (dynamic)
  //   - esbuild inlines the dynamic import → react-devtools-core
  //     becomes a top-level static import
  //   - react-devtools-core's CJS backend.js evaluates `self.X = ...` on
  //     load → ReferenceError: self is not defined under Node.js
  // By statically replacing process.env.DEV → "false" the entire if-branch
  // is dead-code-eliminated and react-devtools-core never enters the bundle.
  // (Production `kodax` always has DEV unset; dev mode runs via tsx not bundle.)
  define: {
    'process.env.DEV': '"false"',
    'process.env.NODE_ENV': '"production"',
  },
  // Output ESM with .js extensions in source — keep the import structure
  // that already works in dev (--import tsx).
  banner: {
    js: '// @kodax-ai/cli — bundled distribution. See docs/ADR.md ADR-022.',
  },
  // Metafile (opt-in via --metafile): bundle composition for CI inspection.
  // Default off because the file is ~1 MB and consumers don't need it.
  metafile: writeMetafile,
  plugins: [stubReactDevtoolsCorePlugin],
  // Resolve workspace internals via symlinks under root node_modules (npm
  // workspaces creates symlinks for @kodax-ai/* into packages/*/dist).
  // The resolveExtensions order ensures we prefer compiled .js (faster build,
  // matches what consumers see).
  resolveExtensions: ['.js', '.mjs', '.cjs'],
  // Log level: warning to surface unresolved dynamic imports etc.
  logLevel: 'warning',
};

// ---- build CLI entry -----------------------------------------------------

log('Building dist/kodax_cli.js (CLI entry)…');
const cliResult = await build({
  ...commonOptions,
  entryPoints: [path.join(repoRoot, 'src/kodax_cli.ts')],
  outfile: path.join(distDir, 'kodax_cli.js'),
});

const cliBytes = (await import('node:fs')).statSync(path.join(distDir, 'kodax_cli.js')).size;
log(`  ✓ dist/kodax_cli.js (${(cliBytes / 1024).toFixed(0)} kB)`);

// ---- build SDK entry -----------------------------------------------------

log('Building dist/index.js (SDK entry)…');
const sdkResult = await build({
  ...commonOptions,
  entryPoints: [path.join(repoRoot, 'src/index.ts')],
  outfile: path.join(distDir, 'index.js'),
});

const sdkBytes = (await import('node:fs')).statSync(path.join(distDir, 'index.js')).size;
log(`  ✓ dist/index.js (${(sdkBytes / 1024).toFixed(0)} kB)`);

// ---- copy builtin skill resources ---------------------------------------

// Layout contract (see HLD §12.4 risk 3):
//   dist/builtin-skills/<skill-name>/{SKILL.md, scripts/, references/, agents/}
// Helper scripts compute SDK path as path.resolve(here, '../../../../dist/index.js')
// so the depth must stay at:
//   here = dist/builtin-skills/<skill>/scripts → SDK = dist/index.js
//   relative depth: scripts (1) → <skill> (2) → builtin-skills (3) → dist (4)
const skillsBuiltinSrc = path.join(repoRoot, 'packages/skills/dist/builtin');
const skillsBuiltinDst = path.join(distDir, 'builtin-skills');
log(`Copying builtin skills: ${path.relative(repoRoot, skillsBuiltinSrc)} → ${path.relative(repoRoot, skillsBuiltinDst)}`);
cpSync(skillsBuiltinSrc, skillsBuiltinDst, { recursive: true });
log(`  ✓ dist/builtin-skills/ copied`);

// ---- copy other dist artifacts that bin uses -----------------------------

// Root tsconfig produces dist/cli_commands.js etc. that kodax_cli.ts imports
// via "./cli_commands.js". Now that kodax_cli is a single bundle, those
// files are inlined and the per-file dist artifacts are not needed in the
// published tarball. But ACP server type declarations and SDK .d.ts may
// still be useful — generate them via tsc separately if needed (out of scope
// for this script).

// ---- write metafile for audit (opt-in) ----------------------------------

if (writeMetafile) {
  const { writeFileSync } = await import('node:fs');
  const meta = {
    cli: cliResult.metafile,
    sdk: sdkResult.metafile,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(
    path.join(distDir, 'bundle-meta.json'),
    JSON.stringify(meta, null, 2),
    'utf8',
  );
  log(`  ✓ dist/bundle-meta.json (esbuild analysis)`);
}

// ---- summary -------------------------------------------------------------

log('');
log('Bundle complete:');
log(`  CLI:  ${(cliBytes / 1024).toFixed(0)} kB → dist/kodax_cli.js`);
log(`  SDK:  ${(sdkBytes / 1024).toFixed(0)} kB → dist/index.js`);
log(`  Builtin skills: dist/builtin-skills/`);
log('');
log('Next: `npm pack` to produce the publish-ready tarball.');
