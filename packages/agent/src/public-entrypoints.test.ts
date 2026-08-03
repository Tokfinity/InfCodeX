import { describe, expect, it } from 'vitest';

import { readProcessStartIdentity } from './index.js';
import {
  searchSessionHistoryCooperatively,
  validateSessionHistorySearchQuery,
} from './session-lineage/index.js';
import {
  dispatchSkillCreatorTool,
  isSkillCreatorDispatchAction,
} from './capabilities/skills/index.js';

describe('@kodax-ai/agent public entrypoints', () => {
  it('exports production helpers without private src imports', () => {
    expect(readProcessStartIdentity).toBeTypeOf('function');
    expect(searchSessionHistoryCooperatively).toBeTypeOf('function');
    expect(validateSessionHistorySearchQuery).toBeTypeOf('function');
    expect(dispatchSkillCreatorTool).toBeTypeOf('function');
    expect(isSkillCreatorDispatchAction).toBeTypeOf('function');
  });
});
