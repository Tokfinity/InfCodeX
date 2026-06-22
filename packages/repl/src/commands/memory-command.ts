/**
 * FEATURE_124 (v0.7.43) Phase D — `/memory` slash command.
 *
 * Per-project memory subsystem inspection + maintenance. Mirrors
 * claudecode `/memory` semantics (list / rebuild / open) over the
 * substrate in `@kodax-ai/agent` (Phase A) so the user has a stable
 * escape hatch when the LLM-managed index drifts or gets corrupted.
 *
 * Subcommands:
 *   /memory                  — alias for `list`
 *   /memory list             — show MEMORY.md + file count + memory dir
 *   /memory rebuild          — regenerate MEMORY.md from topic frontmatter
 *                              (sorted by mtime descending — newest on top)
 *   /memory open             — print MEMORY.md path so the user can open
 *                              it in their editor (the REPL doesn't ship
 *                              an in-process editor — KodaX is CLI-first)
 *   /memory help             — show usage
 *
 * Rebuild contract: ALWAYS preserves topic files; ONLY rewrites
 * `MEMORY.md`. Files whose frontmatter is missing or malformed get a
 * conservative `[<basename>](<file>) — <basename>` line and a stderr
 * warning so the user can spot and fix them rather than silently lose
 * them. `MEMORY.md` itself is excluded from the scan (it's not a topic
 * file). Files outside the configured memory dir are NEVER touched —
 * this is the only filesystem write the command performs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import chalk from 'chalk';

import {
  parseMemoryFile,
  resolveMemoryEntrypoint,
  resolveMemoryRoot,
  type MemoryType,
} from '@kodax-ai/agent';

import { printLearningPendingForFilter } from './learning-inbox.js';
import type { Command } from './types.js';

function resolveCwd(context: { runtimeInfo?: { workspaceRoot?: string; executionCwd?: string } }): string {
  return (
    context.runtimeInfo?.workspaceRoot ??
    context.runtimeInfo?.executionCwd ??
    process.cwd()
  );
}

interface TopicFile {
  filename: string;
  absPath: string;
  mtimeMs: number;
  title: string;
  description: string;
  type: MemoryType | undefined;
  parseOk: boolean;
}

function readTopicFiles(memoryDir: string): TopicFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(memoryDir, { withFileTypes: true });
  } catch (err) {
    // ENOENT = "memory dir not created yet" — expected when the LLM
    // has never written a memory. Surface any other failure (EPERM,
    // ENOTDIR, etc.) so the user notices filesystem problems instead
    // of seeing a silent "0 topic files" — per project rule "NEVER
    // silently swallow errors" (CLAUDE.md).
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[memory] failed to read memory directory ${memoryDir}:`, err);
    }
    return [];
  }

  const result: TopicFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'MEMORY.md') {
      continue;
    }
    const absPath = path.join(memoryDir, entry.name);
    let raw = '';
    let mtimeMs = 0;
    try {
      raw = fs.readFileSync(absPath, 'utf-8');
      mtimeMs = fs.statSync(absPath).mtimeMs;
    } catch (err) {
      // Per-file read errors (TOCTOU with concurrent delete, unusual
      // permissions, etc.) skip the file but log so the user can spot
      // it. Do NOT abort the whole scan — a single unreadable file
      // shouldn't block rebuild of the rest of the index.
      console.error(`[memory] failed to read ${absPath}:`, err);
      continue;
    }
    const parsed = parseMemoryFile(raw);
    const fm = parsed.frontmatter;
    // `parseMemoryFile` ALWAYS returns a frontmatter object (degraded
    // tolerance — see frontmatter.ts contract). Treat "no usable
    // fields" as malformed so the rebuild warning fires correctly when
    // a topic file is missing its `--- name: ... ---` header.
    const parseOk =
      fm.name !== undefined ||
      fm.description !== undefined ||
      fm.type !== undefined;
    const baseTitle = path.basename(entry.name, '.md');
    result.push({
      filename: entry.name,
      absPath,
      mtimeMs,
      title: fm.name?.trim() || baseTitle,
      description: fm.description?.trim() || baseTitle,
      type: fm.type,
      parseOk,
    });
  }
  return result;
}

function buildIndexLines(files: TopicFile[]): string[] {
  return files.map((f) => `- [${f.title}](${f.filename}) — ${f.description}`);
}

async function listMemory(memoryDir: string, entrypointPath: string): Promise<void> {
  console.log(chalk.cyan('\n[memory] per-project memory directory'));
  console.log(chalk.dim(`  ${memoryDir}`));

  const files = readTopicFiles(memoryDir);
  const malformed = files.filter((f) => !f.parseOk);
  console.log(
    chalk.dim(
      `  ${files.length} topic file${files.length === 1 ? '' : 's'}` +
        (malformed.length > 0 ? `, ${malformed.length} without parsable frontmatter` : ''),
    ),
  );

  let indexExists = false;
  let indexRaw = '';
  try {
    indexRaw = fs.readFileSync(entrypointPath, 'utf-8');
    indexExists = true;
  } catch {
    indexExists = false;
  }

  if (!indexExists) {
    console.log(chalk.yellow('\n  MEMORY.md does not exist yet.'));
    if (files.length > 0) {
      console.log(chalk.dim('  Run `/memory rebuild` to seed it from existing topic files.'));
    } else {
      console.log(chalk.dim('  The LLM will create it on first save — no action needed.'));
    }
    console.log();
    return;
  }

  console.log(chalk.cyan('\n--- MEMORY.md ---'));
  if (indexRaw.trim().length === 0) {
    console.log(chalk.dim('  (empty)'));
  } else {
    console.log(indexRaw.trimEnd());
  }
  console.log(chalk.cyan('--- end ---\n'));
}

async function rebuildMemory(memoryDir: string, entrypointPath: string): Promise<void> {
  let dirExists = false;
  try {
    dirExists = fs.statSync(memoryDir).isDirectory();
  } catch {
    dirExists = false;
  }

  if (!dirExists) {
    console.log(chalk.yellow('\n[memory] memory directory does not exist yet — nothing to rebuild.'));
    console.log(chalk.dim(`  ${memoryDir}`));
    console.log(chalk.dim('  The LLM will create both the directory and MEMORY.md on first save.\n'));
    return;
  }

  const files = readTopicFiles(memoryDir);
  if (files.length === 0) {
    console.log(chalk.yellow('\n[memory] no topic files found — nothing to rebuild.'));
    console.log(chalk.dim(`  ${memoryDir}\n`));
    return;
  }

  // mtime descending = newest on top, matching the natural-LRU ordering
  // documented in memory-rules.ts (PREPEND-to-top creates newest-first).
  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const lines = buildIndexLines(sorted);
  const body = lines.join('\n') + '\n';

  fs.writeFileSync(entrypointPath, body, 'utf-8');

  console.log(chalk.green(`\n[memory] rebuilt MEMORY.md with ${sorted.length} entries (newest first).`));
  console.log(chalk.dim(`  ${entrypointPath}`));
  const malformed = sorted.filter((f) => !f.parseOk);
  if (malformed.length > 0) {
    console.log(chalk.yellow(`  ${malformed.length} file(s) had no parsable frontmatter — used filename as fallback:`));
    for (const file of malformed) {
      console.log(chalk.dim(`    - ${file.filename}`));
    }
    console.log(chalk.dim('  Tip: add `---\\nname: ...\\ndescription: ...\\ntype: ...\\n---` at the top of those files.'));
  }
  console.log();
}

function openMemory(memoryDir: string, entrypointPath: string): void {
  console.log(chalk.cyan('\n[memory] open these paths in your editor:'));
  console.log(chalk.dim('  index :'), entrypointPath);
  console.log(chalk.dim('  dir   :'), memoryDir);
  console.log(
    chalk.dim(
      '\n  (No in-REPL editor is provided — open the file in your usual editor.\n' +
        '   Use `/memory rebuild` after manual edits if you renamed any topic file.)\n',
    ),
  );
}

function printHelp(): void {
  console.log(chalk.cyan('\n/memory - Inspect or rebuild per-project memory'));
  console.log(chalk.dim('  /memory                 List MEMORY.md + memory directory'));
  console.log(chalk.dim('  /memory list            Same as `/memory`'));
  console.log(chalk.dim('  /memory pending         List pending context-note learning suggestions'));
  console.log(chalk.dim('  /memory rebuild         Regenerate MEMORY.md from topic frontmatter'));
  console.log(chalk.dim('  /memory open            Print paths so you can open them in your editor'));
  console.log(chalk.dim('  /memory help            Show this help'));
  console.log();
}

function printDetailedHelp(): void {
  console.log(chalk.bold('\n/memory - Inspect or rebuild project memory\n'));
  console.log('Usage:');
  console.log(chalk.cyan('  /memory                 ') + chalk.dim('Show MEMORY.md + topic file count'));
  console.log(chalk.cyan('  /memory list            ') + chalk.dim('Alias for `/memory`'));
  console.log(chalk.cyan('  /memory pending         ') + chalk.dim('List pending context-note learning suggestions'));
  console.log(chalk.cyan('  /memory rebuild         ') + chalk.dim('Regenerate MEMORY.md (newest first by mtime)'));
  console.log(chalk.cyan('  /memory open            ') + chalk.dim('Print the index + dir paths for editor use'));
  console.log(chalk.cyan('  /memory help            ') + chalk.dim('Show this help\n'));
  console.log('Description:');
  console.log(
    chalk.dim(
      '  Each project gets its own memory directory under your KodaX agent\n' +
        '  home — `<agentConfigHome>/projects/<project-key>/memory/`. The LLM\n' +
        '  owns reads/writes; this command is your escape hatch when the\n' +
        '  MEMORY.md index drifts from the topic files on disk.\n',
    ),
  );
  console.log('Notes:');
  console.log(chalk.dim('  • Rebuild ONLY rewrites MEMORY.md. Topic files are never touched.'));
  console.log(chalk.dim('  • Rebuild sorts entries by file mtime descending — the same'));
  console.log(chalk.dim('    natural-LRU order the LLM produces by prepending new entries.'));
  console.log(chalk.dim('  • Files missing or with malformed frontmatter still appear in'));
  console.log(chalk.dim('    the rebuilt index using their filename as fallback; the command'));
  console.log(chalk.dim('    prints a warning so you can fix the frontmatter.\n'));
}

/**
 * `/memory` command definition.
 */
export const memoryCommand: Command = {
  name: 'memory',
  description: 'Inspect or rebuild per-project memory (FEATURE_124)',
  usage: '/memory [list|pending|rebuild|open|help]',
  argumentHint: 'list | pending | rebuild | open | help',
  handler: async (args, context) => {
    const cwd = resolveCwd(context);
    const memoryDir = resolveMemoryRoot(cwd);
    const entrypointPath = resolveMemoryEntrypoint(cwd);
    const sub = (args[0] ?? 'list').toLowerCase();

    if (sub === 'help' || sub === '--help' || sub === '-h') {
      printHelp();
      return;
    }
    if (sub === 'list') {
      await listMemory(memoryDir, entrypointPath);
      return;
    }
    if (sub === 'pending') {
      await printLearningPendingForFilter(cwd, 'memory');
      return;
    }
    if (sub === 'rebuild') {
      await rebuildMemory(memoryDir, entrypointPath);
      return;
    }
    if (sub === 'open') {
      openMemory(memoryDir, entrypointPath);
      return;
    }
    console.log(chalk.yellow(`\n[memory] unknown subcommand: ${sub}`));
    printHelp();
  },
  detailedHelp: printDetailedHelp,
};
