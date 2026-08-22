import { Context } from '@deepseek-ai/cordis';
import { Check } from 'typebox/value';
import { describe, expect, it, vi } from 'vitest';
import {
  DOOM_FABLE_PLAN_SERVICE,
  type DoomFablePlanService,
  FABLE_PLAN_MODEL,
  FABLE_PLAN_PROFILE,
  FABLE_PLAN_REQUESTER,
  FABLE_PLAN_RUNTIME,
  FablePlanResultSchema,
  FablePlanStartSchema,
  readDoomFablePlanService,
} from '../src/schemas/fablePlan.ts';

describe('Fable plan Cordis contract', () => {
  it('publishes and retracts a session-scoped named service with its provider fiber', async () => {
    const root = new Context();
    const service: DoomFablePlanService = {
      sessionId: 'session-1',
      generation: 'generation-1',
      start: vi.fn(),
      cancel: vi.fn(),
    };
    const provider = root.plugin((ctx) => ctx.provide(DOOM_FABLE_PLAN_SERVICE, service));
    await provider.await();

    expect(readDoomFablePlanService(root)).toBe(service);
    await provider.dispose();
    expect(readDoomFablePlanService(root)).toBeUndefined();
    await root.fiber.dispose();
  });

  it('keeps request literals and bounded result payloads schema-checked', () => {
    expect(
      Check(FablePlanStartSchema, {
        requester: FABLE_PLAN_REQUESTER,
        operationId: 'operation-1',
        runtime: FABLE_PLAN_RUNTIME,
        model: FABLE_PLAN_MODEL,
        profile: FABLE_PLAN_PROFILE,
        packet: {
          goal: ['Produce a plan'],
          constraints: ['Stay read-only'],
          decisions: [],
          verifiedFindings: [{ path: 'src/file.ts', finding: 'The source was inspected by Pi.' }],
          inferredFindings: [],
          unresolvedQuestions: [],
        },
      }),
    ).toBe(true);
    expect(
      Check(FablePlanResultSchema, {
        operationId: 'operation-1',
        status: 'completed',
        stage: 'completed',
        draft: 'draft',
        draftRunId: 'run-1',
        durationMs: 1,
      }),
    ).toBe(true);
  });
});
