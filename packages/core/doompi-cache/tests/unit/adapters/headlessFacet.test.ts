import type {
  DoomHeadlessExecutionContext,
  DoomHeadlessHook,
  DoomHeadlessHostService,
} from '@agimon-ai/doompi-core/headless';
import { DOOM_HEADLESS_HOST_SERVICE } from '@agimon-ai/doompi-core/headless';
import { DOOM_SERVER_HOST_SERVICE } from '@agimon-ai/doompi-core/server-facet';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';

import { cacheServerFacet } from '../../../src/extensions/server';

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
    model: { provider: 'openai', id: 'gpt-test' },
    selection: { majorMode: 'development', activeLayers: [], domains: [], state: {} },
  } as unknown as DoomHeadlessExecutionContext;
  return { execution, hook };
}

describe('cache headless provider hook', () => {
  it('wraps an effective cache rewrite as a provider payload patch', async () => {
    const { execution, hook } = await fixture();
    const result = await hook.handle(
      {
        lane: 'main',
        runId: 'run-1',
        model: { provider: 'openai', id: 'gpt-test' },
        payload: { api: 'openai-responses', model: 'gpt-test', prompt_cache_key: 'pi-session' },
      },
      execution,
    );
    expect(result).toMatchObject({
      payload: {
        api: 'openai-responses',
        model: 'gpt-test',
        prompt_cache_key: expect.stringMatching(/^dpc1_/),
      },
    });
  });

  it('returns no patch when the provider payload has no replaceable key', async () => {
    const { execution, hook } = await fixture();
    const result = await hook.handle(
      {
        lane: 'main',
        runId: 'run-2',
        model: { provider: 'openai', id: 'gpt-test' },
        payload: { api: 'openai-responses', model: 'gpt-test' },
      },
      execution,
    );
    expect(result).toBeUndefined();
  });
});
