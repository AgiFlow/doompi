import type {
  DoomHeadlessExecutionContext,
  DoomHeadlessHook,
  DoomHeadlessHostService,
} from '@agimon-ai/doompi-core/headless';
import { DOOM_HEADLESS_HOST_SERVICE } from '@agimon-ai/doompi-core/headless';
import { DOOM_SERVER_HOST_SERVICE } from '@agimon-ai/doompi-core/serverFacet';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';

import { facet as cacheServerFacet } from '../../../generated/server';

async function fixture() {
  const hooks: DoomHeadlessHook[] = [];
  const host = {
    registerResource: () => ({ dispose: vi.fn() }),
    registerHook: (hook: DoomHeadlessHook) => {
      hooks.push(hook);
      return { dispose: vi.fn() };
    },
  } as unknown as DoomHeadlessHostService;
  const context = new Context();
  context.provide(DOOM_SERVER_HOST_SERVICE, { scope: 'session' });
  context.provide(DOOM_HEADLESS_HOST_SERVICE, host);
  await cacheServerFacet.apply(context);
  const hook = hooks.find(({ event }) => event === 'before_provider_request') as
    | DoomHeadlessHook<'before_provider_request'>
    | undefined;
  if (!hook) throw new Error('Cache provider hook was not registered');
  const execution = {
    sessionId: 'cache-headless-test',
    model: { provider: 'other-provider', id: 'selected-model' },
    selection: { majorMode: 'development', activeLayers: [], domains: [], state: {} },
  } as unknown as DoomHeadlessExecutionContext;
  return { execution, hook };
}

const model = { provider: 'openai-codex', id: 'gpt-test', api: 'openai-codex-responses' };
describe('cache headless provider hook', () => {
  it('rewrites a native request using its model metadata without leaking metadata onto the wire', async () => {
    const { execution, hook } = await fixture();
    const payload = { model: 'gpt-test', instructions: 'stable prompt', input: [], prompt_cache_key: 'pi-session' };
    const event = { lane: 'main', runId: 'run-1', model, payload };
    const result = await hook.handle(event, execution);
    expect(result).toEqual({ payload: { ...payload, prompt_cache_key: expect.stringMatching(/^dpc1_/) } });
    expect(payload.prompt_cache_key).toBe('pi-session');
    expect(await hook.handle({ ...event, runId: 'run-2' }, execution)).toEqual(result);
    if (!result) throw new Error('Cache key was not rewritten');
    expect(await hook.handle({ ...event, payload: result.payload }, execution)).toBeUndefined();
    expect(await hook.handle(event, { ...execution, sessionId: 'another-session' })).not.toEqual(result);
  });

  it('returns no patch when the native provider omits its cache key', async () => {
    const { execution, hook } = await fixture();
    expect(
      await hook.handle({ lane: 'main', runId: 'run-2', model, payload: { model: 'gpt-test' } }, execution),
    ).toBeUndefined();
  });

  it.each([undefined, 'anthropic-messages', 'unknown-api'])(
    'does not infer cache capability for %s from the body',
    async (api) => {
      const { execution, hook } = await fixture();
      const requestModel = { ...model, api };
      const result = await hook.handle(
        {
          lane: 'main',
          runId: 'run-3',
          model: requestModel,
          payload: { api: 'openai-codex-responses', model: 'gpt-test', prompt_cache_key: 'pi-session' },
        },
        execution,
      );
      expect(result).toBeUndefined();
    },
  );
});
