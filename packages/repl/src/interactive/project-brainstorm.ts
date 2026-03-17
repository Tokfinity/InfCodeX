export type BrainstormTurnRole = 'user' | 'assistant';

export interface BrainstormTurn {
  role: BrainstormTurnRole;
  text: string;
  createdAt: string;
}

export interface BrainstormSession {
  id: string;
  topic: string;
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'completed';
  turns: BrainstormTurn[];
}

function normalizeText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} cannot be empty`);
  }
  return normalized;
}

function createTurn(
  role: BrainstormTurnRole,
  text: string,
  timestamp: string,
): BrainstormTurn {
  return {
    role,
    text: normalizeText(text, `${role} turn`),
    createdAt: timestamp,
  };
}

export function createBrainstormSession(
  topic: string,
  assistantOpening: string,
  timestamp = new Date().toISOString(),
): BrainstormSession {
  const normalizedTopic = normalizeText(topic, 'topic');
  return {
    id: `brainstorm_${timestamp.replace(/[:.]/g, '-')}`,
    topic: normalizedTopic,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: 'active',
    turns: [
      createTurn('user', normalizedTopic, timestamp),
      createTurn('assistant', assistantOpening, timestamp),
    ],
  };
}

export function appendBrainstormExchange(
  session: BrainstormSession,
  userInput: string,
  assistantReply: string,
  timestamp = new Date().toISOString(),
): BrainstormSession {
  if (session.status !== 'active') {
    throw new Error('cannot append to a completed brainstorm session');
  }

  return {
    ...session,
    updatedAt: timestamp,
    turns: [
      ...session.turns,
      createTurn('user', userInput, timestamp),
      createTurn('assistant', assistantReply, timestamp),
    ],
  };
}

export function completeBrainstormSession(
  session: BrainstormSession,
  timestamp = new Date().toISOString(),
): BrainstormSession {
  if (session.status === 'completed') {
    return session;
  }

  return {
    ...session,
    status: 'completed',
    updatedAt: timestamp,
  };
}

export function buildFallbackBrainstormOpening(topic: string): string {
  const normalizedTopic = normalizeText(topic, 'topic');
  return [
    `Let us pressure-test "${normalizedTopic}" before we turn it into execution work.`,
    '',
    'Key questions to answer first:',
    '1. What user or business outcome must this unlock?',
    '2. What constraints or edge cases would make the first version fail?',
    '3. Which trade-off matters most: speed, correctness, flexibility, or cost?',
    '4. What signals would tell us the design is working after launch?',
    '',
    'Promising directions:',
    '- Define the smallest version that proves the idea without overcommitting architecture.',
    '- Surface the riskiest assumption early and test it with a concrete scenario.',
    '- Compare one simple implementation path with one scalable path before choosing.',
    '',
    'Reply with more context, constraints, or a candidate direction and we will keep refining it.',
  ].join('\n');
}

export function buildFallbackBrainstormReply(userInput: string): string {
  const normalizedInput = normalizeText(userInput, 'user turn');
  return [
    `That adds useful signal: "${normalizedInput}".`,
    '',
    'Next angles to pressure-test:',
    '1. Which assumption here is still the least certain?',
    '2. What would break if the first version had to ship in one week?',
    '3. Which stakeholder or system dependency has not been represented yet?',
    '',
    'Suggested next move:',
    '- Turn the riskiest unknown into a concrete scenario or acceptance test.',
    '- If there are competing approaches, describe both so we can compare trade-offs directly.',
  ].join('\n');
}

export function formatBrainstormTranscript(session: BrainstormSession): string {
  const lines = [
    `# Brainstorm: ${session.topic}`,
    '',
  ];

  for (const turn of session.turns) {
    lines.push(`## ${turn.role === 'user' ? 'User' : 'Assistant'}`);
    lines.push(turn.text);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
