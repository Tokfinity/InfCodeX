import { describe, expect, it } from 'vitest';

import { createPromptSection } from '../prompts/sections.js';
import { SELF_KNOWLEDGE_ROUTING_RULE } from './routing-rule.js';

describe('FEATURE_218 self-knowledge routing rule', () => {
  it('stays bounded (≤250 tokens ≈ ≤1000 bytes) to keep the prompt cache stable', () => {
    expect(Buffer.byteLength(SELF_KNOWLEDGE_ROUTING_RULE, 'utf-8')).toBeLessThanOrEqual(1000);
  });

  it('names the tool and the KodaX-vs-others disambiguation', () => {
    expect(SELF_KNOWLEDGE_ROUTING_RULE).toContain('kodax_manual');
    expect(SELF_KNOWLEDGE_ROUTING_RULE).toContain('~/.kodax/config.json');
    expect(SELF_KNOWLEDGE_ROUTING_RULE.toLowerCase()).toContain('codex');
  });

  it('is wired through a registered prompt section id (createPromptSection does not throw)', () => {
    const section = createPromptSection(
      'self-knowledge-routing',
      SELF_KNOWLEDGE_ROUTING_RULE,
      'test',
    );
    expect(section.id).toBe('self-knowledge-routing');
  });
});
