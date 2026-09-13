import { Check } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import { DelegationRequestSchema, InlineAgentSchema } from '../../src/exports/delegation';

describe('delegation contract', () => {
  it('validates the optional inline agent at the shared foundation boundary', () => {
    expect(Check(InlineAgentSchema, { systemPrompt: '' })).toBe(false);
    expect(
      Check(DelegationRequestSchema, {
        requestId: 'request-1',
        taskId: 1,
        agent: 'explorer',
        inlineAgent: { systemPrompt: 'Inspect schemas only.' },
        prompt: 'Inspect the package',
        cwd: '/tmp',
      }),
    ).toBe(true);
  });
});
