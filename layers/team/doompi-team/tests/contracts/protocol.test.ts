import { Check } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import {
  DelegationAcceptedSchema,
  DelegationRequestSchema,
  DelegationResultSchema,
} from '../../src/schemas/delegationApi';
describe('delegation protocol', () => {
  it('strictly validates typed delegation requests and results', () => {
    expect(
      Check(DelegationRequestSchema, {
        requestId: 'request-1',
        taskId: 'task-1',
        agent: 'explorer',
        prompt: 'Inspect the package',
        cwd: '/tmp',
        unexpected: true,
      }),
    ).toBe(false);
    expect(Check(DelegationAcceptedSchema, { requestId: 'request-1', unexpected: true })).toBe(false);
    expect(Check(DelegationAcceptedSchema, { requestId: 'request-1' })).toBe(true);
    expect(
      Check(DelegationResultSchema, {
        requestId: 'request-1',
        runId: 'run-1',
        status: 'running',
      }),
    ).toBe(false);
    expect(
      Check(DelegationRequestSchema, {
        requestId: 'request-2',
        taskId: 'task-2',
        agent: 'schema-explorer',
        inlineAgent: { systemPrompt: '' },
        prompt: 'Inspect the package',
        cwd: '/tmp',
      }),
    ).toBe(false);
    expect(
      Check(DelegationRequestSchema, {
        requestId: 'request-3',
        taskId: 'task-3',
        agent: 'schema-explorer',
        inlineAgent: { systemPrompt: 'Inspect schemas only.' },
        prompt: 'Inspect the package',
        cwd: '/tmp',
      }),
    ).toBe(true);
  });
});
