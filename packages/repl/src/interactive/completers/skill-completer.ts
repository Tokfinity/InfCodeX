/**
 * Skill completer.
 *
 * Supports both the preferred Claude Code-style direct slash form:
 *   /code-review
 *
 * and the legacy compatibility form:
 *   /skill:code-review
 */

import type { Completer, Completion } from '../autocomplete.js';
import {
  getSkillRegistry,
  initializeSkillRegistry,
  type SkillMetadata,
} from '@kodax-ai/agent';

interface SkillCompletionTrigger {
  partial: string;
  invocationPrefix: '/' | '/skill:';
}

export class SkillCompleter implements Completer {
  private gitRoot?: string;

  constructor(gitRoot?: string) {
    this.gitRoot = gitRoot;
  }

  canComplete(input: string, cursorPos: number): boolean {
    return this.parseTrigger(input.slice(0, cursorPos)) !== undefined;
  }

  async getCompletions(input: string, cursorPos: number): Promise<Completion[]> {
    const trigger = this.parseTrigger(input.slice(0, cursorPos));
    if (!trigger) {
      return [];
    }

    const partial = trigger.partial.toLowerCase();
    const skills = await this.getSkills();

    return skills
      .filter((skill) => {
        const nameLower = skill.name.toLowerCase();
        return nameLower.includes(partial) || this.fuzzyIncludes(partial, nameLower);
      })
      .map((skill) => ({
        text: `${trigger.invocationPrefix}${skill.name}`,
        display: skill.name,
        description: this.truncateDescription(skill.description),
        type: 'skill' as const,
      }))
      .sort((a, b) => {
        const aIsPrefix = a.display.toLowerCase().startsWith(partial);
        const bIsPrefix = b.display.toLowerCase().startsWith(partial);
        if (aIsPrefix && !bIsPrefix) return -1;
        if (!aIsPrefix && bIsPrefix) return 1;
        return a.display.length - b.display.length;
      });
  }

  setGitRoot(gitRoot: string | undefined): void {
    if (this.gitRoot !== gitRoot) {
      this.gitRoot = gitRoot;
    }
  }

  private parseTrigger(beforeCursor: string): SkillCompletionTrigger | undefined {
    const legacyMatch = beforeCursor.match(/(^|\s)\/skill:([^\s]*)$/);
    if (legacyMatch) {
      return {
        partial: legacyMatch[2] ?? '',
        invocationPrefix: '/skill:',
      };
    }

    const directMatch = beforeCursor.match(/(^|\s)\/([^\s]*)$/);
    if (directMatch) {
      return {
        partial: directMatch[2] ?? '',
        invocationPrefix: '/',
      };
    }

    return undefined;
  }

  private async getSkills(): Promise<SkillMetadata[]> {
    try {
      const registry = getSkillRegistry(this.gitRoot);
      if (registry.size === 0) {
        await initializeSkillRegistry(this.gitRoot);
      }

      return registry.listUserInvocable();
    } catch {
      return [];
    }
  }

  private fuzzyIncludes(pattern: string, target: string): boolean {
    let patternIndex = 0;

    for (let i = 0; i < target.length && patternIndex < pattern.length; i += 1) {
      if (target[i] === pattern[patternIndex]) {
        patternIndex += 1;
      }
    }

    return patternIndex === pattern.length;
  }

  private truncateDescription(description: string, maxLength = 50): string {
    if (description.length <= maxLength) {
      return description;
    }
    return description.slice(0, maxLength - 3) + '...';
  }
}

export function createSkillCompleter(gitRoot?: string): SkillCompleter {
  return new SkillCompleter(gitRoot);
}
