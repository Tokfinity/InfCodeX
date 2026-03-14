import { describe, expect, it } from 'vitest';
import { parseSkillMarkdown } from './skill-loader.js';

describe('parseSkillMarkdown', () => {
  it('parses Claude-style frontmatter with hooks and nested metadata', () => {
    const content = `---
name: review-helper
description: "Review code: focus on safety"
user-invocable: false
allowed-tools:
  - Read
  - Grep
context: fork
agent: explorer
model: sonnet
hooks:
  UserPromptSubmit:
    - command: echo prompt-hook
metadata:
  short-description: Review helper
---

# Review Helper

Use this skill to review code.
`;

    const parsed = parseSkillMarkdown(content);

    expect(parsed.frontmatter.name).toBe('review-helper');
    expect(parsed.frontmatter.description).toBe('Review code: focus on safety');
    expect(parsed.frontmatter.userInvocable).toBe(false);
    expect(parsed.frontmatter.allowedTools).toBe('Read, Grep');
    expect(parsed.frontmatter.context).toBe('fork');
    expect(parsed.frontmatter.agent).toBe('explorer');
    expect(parsed.frontmatter.model).toBe('sonnet');
    expect(parsed.frontmatter.hooks?.UserPromptSubmit?.[0]?.command).toBe('echo prompt-hook');
    expect(parsed.frontmatter.metadata?.['short-description']).toBe('Review helper');
    expect(parsed.body).toContain('# Review Helper');
  });

  it('sanitizes unquoted colons in string values', () => {
    const content = `---
name: start-next-feature
description: Implement a workflow: plan, test, ship
---

Body
`;

    const parsed = parseSkillMarkdown(content);
    expect(parsed.frontmatter.description).toBe('Implement a workflow: plan, test, ship');
  });
});
