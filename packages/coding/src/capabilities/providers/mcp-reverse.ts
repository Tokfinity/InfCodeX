/**
 * FEATURE_222 — build the MCP reverse-capability handlers from the host's
 * workspace + interaction surface, to inject into `McpCapabilityProvider`.
 *
 * This is the production wiring the CLI / ACP host uses so the agent-layer
 * reverse seam (roots / elicitation) is actually advertised + served, instead
 * of staying dormant (every reverse request → -32601). Slice A (roots) is wired
 * now; elicitation is layered on here once the host UI is available.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { McpReverseCapabilities, McpRoot } from '@kodax-ai/agent';

export interface McpReverseWorkspace {
  /** The directory KodaX is operating in (the project root). */
  readonly cwd: string;
  /** The git root, when it differs from cwd. */
  readonly gitRoot?: string;
  /** Extra working directories to expose as roots. */
  readonly extraRoots?: readonly string[];
}

/**
 * Compute the workspace roots a server should see, as `file://` URIs (the spec
 * requires `file://`). De-duplicated; the project cwd comes first.
 */
export function mcpRootsFromWorkspace(workspace: McpReverseWorkspace): McpRoot[] {
  const dirs: string[] = [];
  const add = (dir?: string): void => {
    if (!dir) return;
    const absolute = path.resolve(dir);
    if (!dirs.includes(absolute)) dirs.push(absolute);
  };
  add(workspace.cwd);
  add(workspace.gitRoot);
  for (const extra of workspace.extraRoots ?? []) add(extra);
  return dirs.map((dir) => ({ uri: pathToFileURL(dir).href, name: path.basename(dir) || dir }));
}

/**
 * Build the reverse-capability handlers for a workspace. Currently wires roots
 * only (Slice A); the resulting `listRoots` reflects the workspace at the time
 * the server asks. Returns `undefined` when there is nothing to expose, so the
 * caller can omit the injection entirely (→ no capability advertised).
 */
export function buildMcpReverseCapabilities(
  workspace: McpReverseWorkspace,
): McpReverseCapabilities | undefined {
  const roots = mcpRootsFromWorkspace(workspace);
  if (roots.length === 0) return undefined;
  return {
    listRoots: () => roots,
  };
}
