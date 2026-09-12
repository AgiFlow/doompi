import { DOOM_AGENT_MODEL_ENTRY_TYPE } from '@agimon-ai/doompi-extension-contracts/agent-model';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { agentModelExtension, publishAgentModel } from '../../src/extensions/agentModel';

describe('publishAgentModel', () => {
  it('journals the model so a client with no wire event for it can follow', () => {
    const appendEntry = vi.fn();

    const published = publishAgentModel({ appendEntry }, { provider: 'anthropic', id: 'opus' }, undefined);

    expect(appendEntry).toHaveBeenCalledWith(DOOM_AGENT_MODEL_ENTRY_TYPE, { provider: 'anthropic', id: 'opus' });
    expect(published).toBe(JSON.stringify({ provider: 'anthropic', id: 'opus' }));
  });

  it('stays quiet when the model already on the record is selected again', () => {
    const appendEntry = vi.fn();
    const first = publishAgentModel({ appendEntry }, { provider: 'anthropic', id: 'opus' }, undefined);

    publishAgentModel({ appendEntry }, { provider: 'anthropic', id: 'opus' }, first);

    expect(appendEntry).toHaveBeenCalledTimes(1);
  });

  it('journals again once the model actually differs', () => {
    const appendEntry = vi.fn();
    const first = publishAgentModel({ appendEntry }, { provider: 'anthropic', id: 'opus' }, undefined);

    publishAgentModel({ appendEntry }, { provider: 'openai', id: 'gpt' }, first);

    expect(appendEntry).toHaveBeenCalledTimes(2);
    expect(appendEntry).toHaveBeenLastCalledWith(DOOM_AGENT_MODEL_ENTRY_TYPE, { provider: 'openai', id: 'gpt' });
  });
});

describe('agentModelExtension', () => {
  it('publishes the model each model_select settles on, and repeats nothing', () => {
    const appendEntry = vi.fn();
    const handlers = new Map<string, (event: unknown) => void>();
    const pi = {
      appendEntry,
      on: (event: string, handler: (payload: unknown) => void) => handlers.set(event, handler),
    } as unknown as ExtensionAPI;

    agentModelExtension(pi);
    const onModelSelect = handlers.get('model_select');
    onModelSelect?.({ model: { provider: 'anthropic', id: 'opus' } });
    onModelSelect?.({ model: { provider: 'anthropic', id: 'opus' } });
    onModelSelect?.({ model: { provider: 'openai', id: 'gpt' } });

    expect(appendEntry.mock.calls.map((call) => call[1])).toEqual([
      { provider: 'anthropic', id: 'opus' },
      { provider: 'openai', id: 'gpt' },
    ]);
  });
});
