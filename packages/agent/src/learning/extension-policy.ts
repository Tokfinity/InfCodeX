import { LearningCapabilityError } from './center-types.js';

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const TOOL_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function getLearnedExtensionToolName(slug: string, toolName: string): string {
  if (!SLUG_PATTERN.test(slug)) {
    throw new LearningCapabilityError('invalid_record', 'learned Extension slug is invalid');
  }
  if (!TOOL_PATTERN.test(toolName)) {
    throw new LearningCapabilityError('invalid_record', 'learned Extension tool name is invalid');
  }
  return `learned.${slug}.${toolName}`;
}

export function isLearnedExtensionCommandAllowed(_command: string): false {
  return false;
}
