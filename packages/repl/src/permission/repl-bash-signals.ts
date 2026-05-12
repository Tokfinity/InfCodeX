/**
 * REPL-side path-aware bash signal collector — FEATURE_158 Step 8 (v0.7.39).
 *
 * Bridges the coding-side `SignalCollector` contract to repl-side path
 * utilities (`extractPathsFromCommand`, `isAlwaysConfirmPath`,
 * `getBashOutsideProjectWriteRisk`, `collectBashWriteTargets`).
 *
 * Why this lives in @kodax/repl, not @kodax/coding:
 *   The AST + path-extraction utilities live in `packages/repl/src/permission/`
 *   for historical reasons (Issue 130 root-cause area). Lifting them to
 *   `@kodax/coding` is a separate refactor (out of FEATURE_158 scope per
 *   ADR-025 design decision). Instead, the guardrail accepts an
 *   `extraCollectors` config knob and the REPL injects this collector at
 *   bootstrap. Layer boundary preserved; no parallel paths.
 *
 * Signal kinds produced (bash-only):
 *   - protected_path        (~/.kodax or <projectRoot>/.kodax)
 *   - outside_project       (paths neither in project nor in temp)
 *   - shell_redirect_outside (`>` / `>>` redirection targets outside project)
 *
 * Out of scope:
 *   - dangerous_pattern / network / package_install / git_write — produced
 *     by the coding-side `bashSignalCollector` (no repl-side path needed).
 *   - file_modification / protected_path for write/edit tools — produced
 *     by the coding-side `fileSignalCollector` (`input.path` is enough).
 *
 * Purity: deterministic given (command, projectRoot, stable env). Path
 * extraction is regex/AST-based, no I/O.
 */

import path from 'node:path';

import { getAgentConfigHome } from '@kodax-ai/agent';
import type { RunnerToolCall } from '@kodax-ai/agent';
import type { SignalCollector, ToolCallSignal } from '@kodax-ai/coding';

import {
  collectBashWriteTargets,
  extractPathsFromCommand,
  isAlwaysConfirmPath,
} from './permission.js';

function isPathUnder(target: string, directory: string): boolean {
  try {
    const t = path.resolve(target);
    const d = path.resolve(directory);
    if (t === d) return true;
    return t.startsWith(d + path.sep);
  } catch {
    return false;
  }
}

function safeGetAgentConfigHome(): string | undefined {
  try {
    return getAgentConfigHome();
  } catch {
    return undefined;
  }
}

/**
 * Resolve which "zone" a path lives in, if any. Returns undefined when the
 * path is not under either kodax config directory.
 */
function resolveProtectedZone(
  candidate: string,
  projectRoot: string,
): 'project-kodax' | 'user-kodax' | undefined {
  const userKodax = safeGetAgentConfigHome();
  if (userKodax && isPathUnder(candidate, userKodax)) return 'user-kodax';
  const projectKodax = path.join(path.resolve(projectRoot), '.kodax');
  if (isPathUnder(candidate, projectKodax)) return 'project-kodax';
  return undefined;
}

function getSystemTempDirs(): readonly string[] {
  const dirs = new Set<string>();
  try {
    // Lazy import to avoid pulling os at module-eval time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('node:os');
    dirs.add(os.tmpdir());
  } catch {
    /* defensive */
  }
  for (const env of ['TEMP', 'TMP', 'TMPDIR'] as const) {
    const v = process.env[env];
    if (v && v.length > 0) dirs.add(v);
  }
  return Array.from(dirs);
}

const BASH_TOOL_NAMES: ReadonlySet<string> = new Set(['bash']);

/**
 * The collector. Wired into the AutoModeToolGuardrail via the bootstrap's
 * `extraCollectors` config; merged with `bashSignalCollector` from coding.
 */
export const replBashPathSignalCollector: SignalCollector = {
  toolNames: BASH_TOOL_NAMES,

  collect(call: RunnerToolCall, projectRoot: string): readonly ToolCallSignal[] {
    const command = typeof call.input.command === 'string' ? call.input.command : '';
    if (!command || !projectRoot) return [];

    const signals: ToolCallSignal[] = [];
    const emittedProtectedPaths = new Set<string>();
    const emittedOutsideTargets = new Set<string>();
    const tempDirs = getSystemTempDirs();
    const resolvedRoot = path.resolve(projectRoot);

    // Pass 1: protected_path / outside_project for any path-shaped token in argv
    for (const candidate of extractPathsFromCommand(command)) {
      let resolved: string;
      try {
        resolved = path.resolve(projectRoot, candidate);
      } catch {
        continue;
      }
      const zone = resolveProtectedZone(resolved, projectRoot);
      if (zone) {
        if (!emittedProtectedPaths.has(resolved)) {
          emittedProtectedPaths.add(resolved);
          signals.push({ kind: 'protected_path', path: candidate, zone });
        }
        continue; // skip outside_project for the same path (avoid double-flag)
      }
      if (isAlwaysConfirmPath(candidate, projectRoot)) {
        // isAlwaysConfirmPath returns true when path is outside-project AND
        // outside system temp. Treat as outside_project signal.
        const insideTemp = tempDirs.some((d) => isPathUnder(resolved, d));
        const insideProject = isPathUnder(resolved, resolvedRoot);
        if (!insideTemp && !insideProject && !emittedOutsideTargets.has(resolved)) {
          emittedOutsideTargets.add(resolved);
          signals.push({ kind: 'outside_project', path: candidate });
        }
      }
    }

    // Pass 2: shell_redirect_outside for write targets (`>`, `>>`, tee, etc.)
    //   collectBashWriteTargets returns the targets a write command would
    //   write to. We flag targets that are outside project AND outside temp.
    for (const target of collectBashWriteTargets(command)) {
      let resolved: string;
      try {
        resolved = path.resolve(projectRoot, target);
      } catch {
        continue;
      }
      // Don't duplicate a protected_path signal as shell_redirect_outside.
      if (resolveProtectedZone(resolved, projectRoot)) continue;
      const insideProject = isPathUnder(resolved, resolvedRoot);
      if (insideProject) continue;
      const insideTemp = tempDirs.some((d) => isPathUnder(resolved, d));
      if (insideTemp) continue;
      // Outside project + outside temp = redirect-to-elsewhere.
      signals.push({ kind: 'shell_redirect_outside', target });
    }

    return signals;
  },
};
