import type { Context } from '@deepseek-ai/cordis';
import type {
  DoomHeadlessExecutionContext,
  DoomHeadlessHook,
  DoomHeadlessHostService,
} from '@agimon-ai/doompi-extension-contracts/headless';
import { describe, expect, it, vi } from 'vitest';
import { cacheHeadlessFacet } from '../../../src/adapters/headless/facet.ts';

function fixture() {
  const hooks: DoomHeadlessHook[] = [];
  const host = {
    registerResource: () => ({ dispose: vi.fn() }),
    registerHook: (hook: DoomHeadlessHook) => {
      hooks.push(hook);
      return { dispose: vi.fn() };
    },
  } as unknown as DoomHeadlessHostService;
  cacheHeadlessFacet.apply({ get: () => host } as unknown as Context);
  const hook = hooks.find(({ event }) => event === 'before_provider_request') as
    | DoomHeadlessHook<'before_provider_request'>
    | undefined;
  if (!hook) throw new Error('Cache provider hook was not registered');
  const execution = {
    sessionId: 'cache-headless-test',
    model: { provider: 'openai', id: 'gpt-test' },
    selection: { majorMode: 'development', activeLayers: [], domains: [], minorModes: [] },
  } as unknown as DoomHeadlessExecutionContext;
  return { execution, hook };
}

describe('cache headless provider hook', () => {
  it('wraps an effective cache rewrite as a provider payload patch', async () => {
    const { execution, hook } = fixture();
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
    const { execution, hook } = fixture();
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
