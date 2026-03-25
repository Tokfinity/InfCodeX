/**
 * KodaX Tool Types
 */

import type { KodaXToolDefinition } from '@kodax/ai';
import type { KodaXToolExecutionContext } from '../types.js';

export type ToolHandler = (
  input: Record<string, unknown>,
  context: KodaXToolExecutionContext
) => Promise<string>;

export interface LocalToolDefinition extends KodaXToolDefinition {
  handler: ToolHandler;
}

export interface ToolDefinitionSource {
  kind: 'builtin' | 'extension';
  id?: string;
  label?: string;
}

export interface RegisteredToolDefinition extends LocalToolDefinition {
  registrationId: string;
  requiredParams: string[];
  source: ToolDefinitionSource;
}

export interface ToolRegistrationOptions {
  source?: ToolDefinitionSource;
}

export type ToolRegistry = Map<string, RegisteredToolDefinition[]>;
