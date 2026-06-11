/**
 * FEATURE_222 — build the MCP reverse-capability handlers from the host's
 * workspace + interaction surface, to inject into `McpCapabilityProvider`.
 *
 * This is the production wiring the CLI / ACP host uses so the agent-layer
 * reverse seam (roots / elicitation) is actually advertised + served, instead
 * of staying dormant (every reverse request -> -32601). Elicitation is opt-in
 * because it needs a live host UI.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  getActiveUserInteraction,
  type McpElicitRequest,
  type McpElicitResult,
  type McpReverseCapabilities,
  type McpRoot,
  type UserInteraction,
} from '@kodax-ai/agent';

export interface McpReverseWorkspace {
  /** The directory KodaX is operating in (the project root). */
  readonly cwd: string;
  /** The git root, when it differs from cwd. */
  readonly gitRoot?: string;
  /** Extra working directories to expose as roots. */
  readonly extraRoots?: readonly string[];
  /**
   * Advertise + serve elicitation (form + url) by routing server requests to the
   * live user-interaction surface registered via `setActiveUserInteraction`.
   * When no surface is live (headless / between turns) the handler declines.
   */
  readonly enableElicitation?: boolean;
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
 * Build the reverse-capability handlers for a workspace. `listRoots` reflects
 * the workspace captured by the host, and elicitation is wired only when the
 * host opts in. Returns `undefined` when there is nothing to expose, so the
 * caller can omit the injection entirely (no capability advertised).
 */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Map an MCP `form` elicitation's schema onto the host's ask-user surface. */
async function elicitForm(ui: UserInteraction, request: McpElicitRequest): Promise<McpElicitResult> {
  const message = request.message ?? 'A connected tool is requesting information.';
  const properties = asObject(asObject(request.requestedSchema)?.properties);

  // Confirm-only form (no fields) -> a single approve/decline prompt.
  if (!properties || Object.keys(properties).length === 0) {
    if (!ui.askUser) return { action: 'decline' };
    const answer = await ui.askUser({
      question: message,
      kind: 'select',
      options: [{ label: 'Approve', value: 'accept' }, { label: 'Decline', value: 'decline' }],
    });
    return answer === 'accept' ? { action: 'accept', content: {} } : { action: 'decline' };
  }

  const content: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(properties)) {
    const prop = asObject(raw) ?? {};
    const label = typeof prop.title === 'string' ? prop.title : key;
    const question = `${message}\n\n${label}`;
    const enumValues = Array.isArray(prop.enum) ? prop.enum : undefined;

    if (enumValues && enumValues.length > 0 && ui.askUser) {
      const choices = enumValues.map((value, index) => ({
        label: String(value),
        value: String(index),
      }));
      const answer = await ui.askUser({
        question,
        kind: 'select',
        options: choices,
      });
      const selectedIndex = Number(answer);
      content[key] = Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < enumValues.length
        ? enumValues[selectedIndex]
        : answer;
    } else if (prop.type === 'boolean' && ui.askUser) {
      const answer = await ui.askUser({
        question,
        kind: 'select',
        options: [{ label: 'Yes', value: 'true' }, { label: 'No', value: 'false' }],
      });
      content[key] = answer === 'true';
    } else if (ui.askUserInput) {
      const answer = await ui.askUserInput({ question });
      if (answer === undefined) return { action: 'cancel' };
      content[key] = prop.type === 'number' || prop.type === 'integer' ? Number(answer) : answer;
    } else {
      return { action: 'decline' };
    }
  }
  return { action: 'accept', content };
}

/**
 * Map an MCP `url` elicitation onto an anti-phishing consent prompt: show the
 * full URL + its domain and require explicit consent. KodaX never auto-opens
 * the browser and never exposes the URL/contents to the model — the user
 * decides, then visits the shown URL themselves.
 */
async function elicitUrl(ui: UserInteraction, request: McpElicitRequest): Promise<McpElicitResult> {
  const url = request.url;
  if (!url || !ui.askUser) return { action: 'decline' };
  let domain = url;
  try {
    domain = new URL(url).host;
  } catch {
    // keep the raw url as the shown domain when it is not parseable
  }
  const answer = await ui.askUser({
    question:
      `${request.message ?? 'A connected tool needs you to authorize something in your browser.'}\n\n`
      + `URL: ${url}\nDomain: ${domain}\n\nOnly continue if you trust this domain. KodaX will NOT open it automatically.`,
    kind: 'select',
    options: [
      { label: 'I trust this — open it myself and continue', value: 'accept' },
      { label: 'Decline', value: 'decline' },
    ],
  });
  return answer === 'accept' ? { action: 'accept', content: {} } : { action: 'decline' };
}

/** Route an elicitation request to the host interaction; failures degrade to cancel. */
export async function elicitViaUserInteraction(
  ui: UserInteraction,
  request: McpElicitRequest,
): Promise<McpElicitResult> {
  try {
    return request.mode === 'url' ? await elicitUrl(ui, request) : await elicitForm(ui, request);
  } catch {
    return { action: 'cancel' };
  }
}

/**
 * An elicit handler that resolves the LIVE user-interaction surface at call
 * time (the MCP provider is built before any interactive loop exists). When
 * nothing is registered — headless, print mode, between turns — it declines.
 */
export function activeElicitHandler(): (request: McpElicitRequest) => Promise<McpElicitResult> {
  return async (request) => {
    const ui = getActiveUserInteraction();
    if (!ui || (!ui.askUser && !ui.askUserInput)) return { action: 'decline' };
    return elicitViaUserInteraction(ui, request);
  };
}

export function buildMcpReverseCapabilities(
  workspace: McpReverseWorkspace,
): McpReverseCapabilities | undefined {
  const roots = mcpRootsFromWorkspace(workspace);
  const reverse: {
    listRoots?: () => McpRoot[];
    elicit?: (request: McpElicitRequest) => Promise<McpElicitResult>;
    elicitationModes?: { form?: boolean; url?: boolean };
  } = {};
  if (roots.length > 0) {
    reverse.listRoots = () => roots;
  }
  if (workspace.enableElicitation) {
    reverse.elicit = activeElicitHandler();
    reverse.elicitationModes = { form: true, url: true };
  }
  return reverse.listRoots || reverse.elicit ? reverse : undefined;
}
