/**
 * Bash Signal Collector — FEATURE_158 Step 3 (v0.7.39).
 *
 * Command-string-level mechanical pattern matches over a `bash` tool call.
 * Produces signals the auto-mode classifier consumes as informational input
 * (NOT verdicts — see `signals.ts` invariants).
 *
 * Scope of this collector:
 *   - dangerous_pattern  (wraps `classifyBashCommand` from bash-classifier.ts;
 *                        DEFAULT_DANGEROUS_PATTERNS hits become signals)
 *   - network            (curl / wget / fetch literal token)
 *   - package_install    (npm/pnpm/yarn/pip/cargo/apt/brew install verbs)
 *   - git_write          (commit / push / reset / clean / rebase /
 *                        cherry-pick / revert)
 *
 * **Out of scope (deferred to REPL-side `extraCollectors`)**:
 *   - protected_path / outside_project signals that depend on extracting
 *     paths from a bash command argv. The AST + path-extraction utilities
 *     live in `@kodax/repl` for historical reasons (Issue 131 root cause);
 *     keeping this module repl-independent preserves layer boundaries
 *     (ADR-021). The guardrail accepts `extraCollectors` so REPL can inject
 *     a path-aware bash collector built on its `extractPathsFromCommand`.
 *
 * Purity: deterministic given `call.input.command`. No async, no I/O.
 */

import type { RunnerToolCall } from '@kodax-ai/agent';

import {
  classifyBashCommand,
  DEFAULT_DANGEROUS_PATTERNS,
  DEFAULT_SAFE_PATTERNS,
} from '../../permissions/bash-classifier.js';

import type { SignalCollector, ToolCallSignal } from './signals.js';

/**
 * Severity mapping for `DEFAULT_DANGEROUS_PATTERNS`. The classifier weighs
 * signals; broad `rm` is contextual (`rm -rf node_modules` is routine) while
 * `git push --force` / `sudo` / `curl | sh` are typically destructive.
 *
 * Keep in sync with `DEFAULT_DANGEROUS_PATTERNS` source order in
 * `bash-classifier.ts`. The pattern source is matched (regex `.source`)
 * rather than index so reordering bash-classifier doesn't silently flip
 * severities.
 */
const DANGEROUS_PATTERN_SEVERITY: Record<string, 'high' | 'medium'> = {
  // /\brm\s+(-[a-z]*r|-[a-z]*f|--force|--recursive)/i — broad rm, contextual
  '\\brm\\s+(-[a-z]*r|-[a-z]*f|--force|--recursive)': 'medium',
  // destructive git verbs
  '\\bgit\\s+(push\\s+--force|push\\s+-f\\b|reset\\s+--hard|clean\\s+-[a-z]*f|checkout\\s+--\\s+\\.|restore\\s+--staged\\s+\\.|branch\\s+-D)':
    'high',
  '\\bsudo\\b': 'high',
  '\\bchmod\\s+[0-7]*777\\b': 'high',
  // mkfs/fdisk/dd if/format — already caught by Tier 0 for the catastrophic
  // dd of=/dev/sd* and mkfs.*; this regex is broader (e.g. `dd if=/dev/zero
  // of=test.bin` is benign) so we keep it as a high-severity signal not a hard
  // Tier 0 block.
  '\\b(mkfs|fdisk|dd\\s+if=|format)\\b': 'high',
  // curl | bash — pipe-to-shell is a known attack vector
  '\\bcurl\\b.*\\|\\s*(bash|sh|zsh)\\b': 'high',
  // SQL destructive
  '\\b(drop\\s+|truncate\\s+|delete\\s+from)\\b': 'high',
  // rm -rf / or ~ — Tier 0 catches this; redundant signal acceptable
  '\\brm\\s+-rf\\s+[\\/~]': 'high',
  // System control
  '\\b(shutdown|reboot|halt|poweroff)\\b': 'medium',
};

function severityFor(patternSource: string): 'high' | 'medium' {
  return DANGEROUS_PATTERN_SEVERITY[patternSource] ?? 'high';
}

// ============== Network token detection ==============

const NETWORK_TOOL_REGEX: ReadonlyArray<readonly [RegExp, 'curl' | 'wget' | 'fetch']> = [
  [/(^|[\s|;&(])curl(\s|$)/, 'curl'],
  [/(^|[\s|;&(])wget(\s|$)/, 'wget'],
  // `fetch` is a Windows tool name conflict (PowerShell alias) but appears in
  // some agent-emitted commands; keep narrow — only literal `fetch ` at start
  // or after pipe/semicolon, to avoid false positives on env names like
  // `FETCH_URL=...`.
  [/(^|[\s|;&(])fetch(\s|$)/, 'fetch'],
];

// ============== Package install detection ==============

const PACKAGE_INSTALL_REGEX: ReadonlyArray<readonly [RegExp, ToolCallSignal & { kind: 'package_install' }]> = [
  [/(^|[\s|;&(])npm\s+(install|i|add)(\s|$)/, { kind: 'package_install', manager: 'npm' }],
  [/(^|[\s|;&(])pnpm\s+(add|install|i)(\s|$)/, { kind: 'package_install', manager: 'pnpm' }],
  [/(^|[\s|;&(])yarn\s+(add|install)(\s|$)/, { kind: 'package_install', manager: 'yarn' }],
  [/(^|[\s|;&(])pip[3]?\s+install(\s|$)/, { kind: 'package_install', manager: 'pip' }],
  [/(^|[\s|;&(])cargo\s+install(\s|$)/, { kind: 'package_install', manager: 'cargo' }],
  [/(^|[\s|;&(])apt(-get)?\s+install(\s|$)/, { kind: 'package_install', manager: 'apt' }],
  [/(^|[\s|;&(])brew\s+install(\s|$)/, { kind: 'package_install', manager: 'brew' }],
];

// ============== Git write detection ==============

const GIT_WRITE_REGEX: ReadonlyArray<readonly [RegExp, ToolCallSignal & { kind: 'git_write' }]> = [
  [/(^|[\s|;&(])git\s+commit(\s|$)/, { kind: 'git_write', verb: 'commit' }],
  [/(^|[\s|;&(])git\s+push(\s|$)/, { kind: 'git_write', verb: 'push' }],
  [/(^|[\s|;&(])git\s+reset(\s|$)/, { kind: 'git_write', verb: 'reset' }],
  [/(^|[\s|;&(])git\s+clean(\s|$)/, { kind: 'git_write', verb: 'clean' }],
  [/(^|[\s|;&(])git\s+rebase(\s|$)/, { kind: 'git_write', verb: 'rebase' }],
  [/(^|[\s|;&(])git\s+cherry-pick(\s|$)/, { kind: 'git_write', verb: 'cherry-pick' }],
  [/(^|[\s|;&(])git\s+revert(\s|$)/, { kind: 'git_write', verb: 'revert' }],
];

// ============== Collector ==============

const BASH_TOOL_NAMES: ReadonlySet<string> = new Set(['bash']);

export const bashSignalCollector: SignalCollector = {
  toolNames: BASH_TOOL_NAMES,

  collect(call: RunnerToolCall): readonly ToolCallSignal[] {
    const command = typeof call.input.command === 'string' ? call.input.command : '';
    if (!command) return [];

    const signals: ToolCallSignal[] = [];

    // 1. Dangerous patterns (via existing bash-classifier — single source of truth)
    const classification = classifyBashCommand(command, {
      safePatterns: DEFAULT_SAFE_PATTERNS,
      dangerousPatterns: DEFAULT_DANGEROUS_PATTERNS,
    });
    if (classification.level === 'dangerous' && classification.matchedPattern) {
      signals.push({
        kind: 'dangerous_pattern',
        pattern: classification.matchedPattern,
        severity: severityFor(classification.matchedPattern),
      });
    }

    // 2. Network tools
    for (const [regex, tool] of NETWORK_TOOL_REGEX) {
      if (regex.test(command)) {
        signals.push({ kind: 'network', tool });
        break; // one network signal is enough; tool identity recorded
      }
    }

    // 3. Package install
    for (const [regex, signal] of PACKAGE_INSTALL_REGEX) {
      if (regex.test(command)) {
        signals.push(signal);
        break; // first match wins (uncommon to mix managers in one line)
      }
    }

    // 4. Git write verbs
    for (const [regex, signal] of GIT_WRITE_REGEX) {
      if (regex.test(command)) {
        signals.push(signal);
        // No break — `git commit && git push` legitimately emits two signals
      }
    }

    return signals;
  },
};
