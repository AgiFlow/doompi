import {
  DOOM_BACKGROUND_WORK_SERVICE,
  type DoomBackgroundWorkService,
  readDoomBackgroundWorkService,
} from '../src/schemas/backgroundWork.ts';
import {
  DOOM_DELEGATION_SERVICE,
  type DoomDelegationService,
  readDoomDelegationService,
} from '../src/schemas/delegation.ts';
import {
  DOOM_SUBAGENT_POLICY_SERVICE,
  type DoomSubagentPolicyService,
  readDoomSubagentPolicyService,
} from '../src/schemas/subagentPolicy.ts';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';

describe('collaboration Cordis contracts', () => {
  it('uses provider-owned named services that retract with their fibers', async () => {
    const root = new Context();
    const backgroundWork: DoomBackgroundWorkService = {
      generation: 'background-1',
      register: vi.fn(),
      snapshot: () => ({ items: [], errors: [] }),
    };
    const delegation: DoomDelegationService = {
      sessionId: 'session-1',
      generation: 'delegation-1',
      request: async () => undefined,
      cancel: () => undefined,
    };
    const subagentPolicy: DoomSubagentPolicyService = {
      generation: 'policy-1',
      register: vi.fn(),
    };
    const provider = root.plugin((ctx) => {
      ctx.provide(DOOM_BACKGROUND_WORK_SERVICE, backgroundWork);
      ctx.provide(DOOM_DELEGATION_SERVICE, delegation);
      ctx.provide(DOOM_SUBAGENT_POLICY_SERVICE, subagentPolicy);
    });
    await provider;

    expect(readDoomBackgroundWorkService(root)).toBe(backgroundWork);
    expect(readDoomDelegationService(root)).toBe(delegation);
    expect(readDoomSubagentPolicyService(root)).toBe(subagentPolicy);

    await provider.dispose();
    expect(readDoomBackgroundWorkService(root)).toBeUndefined();
    expect(readDoomDelegationService(root)).toBeUndefined();
    expect(readDoomSubagentPolicyService(root)).toBeUndefined();
    await root.fiber.dispose();
  });

  it('restarts an injected consumer when a provider unloads and is replaced', async () => {
    const root = new Context();
    const observed: string[] = [];
    root.inject([DOOM_DELEGATION_SERVICE], (ctx) => {
      const service = readDoomDelegationService(ctx);
      if (!service) return undefined;
      observed.push(`bind:${service.generation}`);
      return () => observed.push(`unbind:${service.generation}`);
    });
    const makeService = (generation: string): DoomDelegationService => ({
      sessionId: 'session-1',
      generation,
      request: async () => undefined,
      cancel: () => undefined,
    });

    const first = root.plugin((ctx) => ctx.provide(DOOM_DELEGATION_SERVICE, makeService('first')));
    await first;
    await first.dispose();
    const second = root.plugin((ctx) => ctx.provide(DOOM_DELEGATION_SERVICE, makeService('second')));
    await second;
    await second.dispose();

    expect(observed).toEqual(['bind:first', 'unbind:first', 'bind:second', 'unbind:second']);
    await root.fiber.dispose();
  });
});
